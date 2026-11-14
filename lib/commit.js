// 落账：把片段替换成一条「已折叠历史」用户消息，并写进插件自己的载荷文件。
//
// 为什么是 user/message：宿主只允许 surface 节点按 surfaceOp 被替换，而 assistant/message
// 禁止带 sourceEventSeqs（dsh-session/lib/index.js:318）；官方压缩也是把整段历史换成一条
// user 角色的检查点消息（dsh-compaction-basic/lib/index.js:628-676）。

import { randomUUID } from 'node:crypto'
import { checkpointPrefix, pinPrefix, recallToolName, sourceCheckpoint, sourcePin } from './constants.js'
import { planSegments } from './plan.js'
import { buildNote, clip, recallItems, statsOf, totalChars } from './fold-text.js'
import { normalizeConfig, noteBudget } from './config.js'
import { normalizeUsage } from './usage.js'

// 段后缀：1→a、26→z、27→aa。maxFoldsPerTurn 允许 32 段，单字符后缀不够用。
function segmentSuffix(n) {
  let value = Math.max(1, Math.floor(n))
  let out = ''
  while (value > 0) {
    value -= 1
    out = String.fromCharCode(97 + (value % 26)) + out
    value = Math.floor(value / 26)
  }
  return out
}


export function createCheckpointMessage({ text, foldId }) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: sourceCheckpoint, foldId },
  }
}

export function createPinMessage({ label, text }) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: pinPrefix + ' ' + label + '\n' + text }],
    source: { kind: sourcePin, label },
  }
}

// 折叠一轮。返回折掉的片段数与编号；任何一段失败都只跳过那一段，不影响其它段。
// maxSegments 只给测试留一个显式覆盖口，正式路径用配置里的 maxFoldsPerTurn。
export function foldTurn({ session, turn, nodes, config, store, log, maxSegments, usage }) {
  const settings = config || normalizeConfig({})
  if (!settings.enabled) return { folded: 0, ids: [] }
  const limit = typeof maxSegments === 'number' && Number.isFinite(maxSegments)
    ? maxSegments
    : (typeof settings.maxFoldsPerTurn === 'number' ? settings.maxFoldsPerTurn : 8)
  const segments = planSegments(nodes || [])
  // 本轮的真实用量：同一轮折成多段时每段都写同一份，成本模型按轮去重。
  const usageRecord = normalizeUsage(usage)
  const ids = []
  for (const segment of segments) {
    if (ids.length >= limit) break
    const surface = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
    const startSeq = segment[0].seq
    const endSeq = segment[segment.length - 1].seq
    const startIdx = surface.indexOf(startSeq)
    const endIdx = surface.indexOf(endSeq)
    if (startIdx < 0 || endIdx < startIdx) {
      // 本轮其它片段已经把这段遮掉了（同一轮多段时 surface 会连续变化）。
      continue
    }
    const stats = statsOf(segment)
    const total = totalChars(stats, settings.foldToolOutputs)
    if (total < settings.minFoldChars) continue

    // 段号后缀按「已折叠的段」连续编号：中间有段被跳过时也不会出现空洞。
    const suffix = segments.length > 1 ? segmentSuffix(ids.length + 1) : ''
    const foldId = 'f' + turn + suffix
    if (store && store.findFold(foldId)) continue
    const note = buildNote({
      foldId,
      turn,
      stats,
      maxChars: noteBudget(total, settings),
      toolName: recallToolName,
      includeToolOutputs: settings.foldToolOutputs,
    })
    // 摘要比原文还长就没有折叠的意义：宁可留着原文。
    if (note.length >= total) continue

    const shadowed = surface.slice(startIdx, endIdx + 1)
    // 载荷必须覆盖整段：注入消息与工具调用参数都不进 total，按 total 估预算总会在最后几步
    // 之前花完，最先被丢掉的恰恰是最终回复——那正是召回最想拿到的结论。用不封顶的预算，
    // 体量上限交给调用方（召回返回时还有 maxRecallChars 控制一次塞回多少）。
    const items = recallItems(segment, Number.MAX_SAFE_INTEGER, settings.foldToolOutputs)
    // 先持久化载荷，再写检查点：检查点一旦落盘，模型就只看到「原文用 fold_recall 召回」的承诺。
    // 反过来的顺序（早先的实现）在磁盘满、权限问题或两步之间崩溃时会留下一条永远召回不到的死引用。
    // 孤儿载荷无害（多一行记录），死引用则会把模型引向不存在的原文。
    if (store) {
      const persisted = store.append({
        kind: 'fold',
        id: foldId,
        turn,
        at: Date.now(),
        startSeq,
        endSeq,
        chars: total,
        note,
        items,
        ...(usageRecord ? { usage: usageRecord } : {}),
      })
      if (!persisted) {
        log && log.warn('折叠跳过（第 ' + turn + ' 轮 ' + foldId + '）：载荷写入失败，保留原文。')
        continue
      }
    }
    try {
      session.append('user/message', createCheckpointMessage({ text: note, foldId }), {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: shadowed,
      })
    } catch (error) {
      log && log.warn('折叠失败（第 ' + turn + ' 轮 ' + foldId + '）：' + (error && error.message ? error.message : error))
      continue
    }
    ids.push(foldId)
  }

  return { folded: ids.length, ids }
}

// 软上限只提示、不拒绝：条数与长度交给模型自己判断，插件不替它守门。
// 依据是短消息多记几条的收益高于它的常驻开销——每条 pin 只占一次输入，而反复召回要给整段。
function softLimitNote(settings, count, chars) {
  const over = []
  if (settings.maxPins > 0 && count > settings.maxPins) over.push('条数已超过软上限 ' + settings.maxPins + ' 条')
  if (settings.pinBudgetChars > 0 && chars > settings.pinBudgetChars) over.push('总字数已超过软预算 ' + settings.pinBudgetChars + ' 字')
  if (over.length === 0) return ''
  return '（提示：重要消息' + over.join('、') + '，仍然照常发布；之后可以合并或精简旧条目。）'
}

// 发布一条重要消息：以 user/message 追加，永不进入折叠片段（planSegments 会在它前面断开）。
// 默认不设条数与长度上限：是否值得记由模型判断，硬配额只会让它在该记的时候不敢记。
export function publishPin({ session, label, text, config, store, log, turn }) {
  const settings = config || normalizeConfig({})
  const raw = String(text || '').trim()
  // 只有显式配了正数才截断；即便截断也照常发布，不退回错误。
  const body = settings.maxPinTextChars > 0 ? clip(raw, settings.maxPinTextChars) : raw
  if (!body) return { ok: false, reason: '正文是空的，没有可发布的内容。' }
  const name = clip(String(label || '').trim(), 60) || '重要结论'
  try {
    session.append('user/message', createPinMessage({ label: name, text: body }), { surfaceOp: 'append' })
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    log && log.warn('发布重要消息失败：' + reason)
    return { ok: false, reason: '写入会话失败：' + reason }
  }
  let pins = []
  if (store) {
    const record = { kind: 'pin', id: name, text: body, at: Date.now() }
    // 记录发布时所在的轮：统计页要把它算成那一轮的负收益。旧记录没有这个字段。
    if (typeof turn === 'number' && Number.isFinite(turn) && turn > 0) record.turn = Math.floor(turn)
    // 正文已经在会话消息里，记录写失败只影响账本，不影响「永不折叠」本身；但必须留痕。
    if (!store.append(record)) log && log.warn('重要消息已写入会话，但载荷记录失败：' + name)
    pins = store.pins()
  }
  const totalChars = pins.reduce((sum, pin) => sum + String(pin.text || '').length, 0)
  const truncated = body.length < raw.length ? '（正文被 maxPinTextChars 截断到 ' + body.length + ' 字）' : ''
  const result = { ok: true, label: name, chars: body.length }
  if (pins.length > 0) {
    result.pins = pins.length
    result.totalChars = totalChars
    result.note = truncated + softLimitNote(settings, pins.length, totalChars)
  } else if (truncated) {
    result.note = truncated
  }
  return result
}

export { checkpointPrefix, pinPrefix }

// 落账：把片段替换成一条「已折叠历史」用户消息，并写进插件自己的载荷文件。
//
// 为什么是 user/message：宿主只允许 surface 节点按 surfaceOp 被替换，而 assistant/message
// 禁止带 sourceEventSeqs（dsh-session/lib/index.js:318）；官方压缩也是把整段历史换成一条
// user 角色的检查点消息（dsh-compaction-basic/lib/index.js:628-676）。

import { randomUUID } from 'node:crypto'
import { checkpointPrefix, pinPrefix, recallToolName, sourceCheckpoint, sourcePin } from './constants.js'
import { planSegments } from './plan.js'
import { buildNoteEx, clip, estimateNoteChars, isWorthFolding, recallItems, statsOf, totalChars } from './fold-text.js'
import { normalizeConfig, noteChars } from './config.js'
import { normalizeUsage } from './usage.js'
import { CHARS_PER_TOKEN, estimateTokens } from './tokens.js'

// 段号按轮生成（f<轮><段后缀>），但同一轮可能被关闭两次：模型被 steering 再叫起来、
// 或 turn-stopping 折过之后 turn/end 又兜底了一轮。第二次就撞上已经存在的编号。
// 早先撞号直接跳过，后半段的内容永远折不掉；这里改成递增后缀，编号难看一点，但内容不丢。
function uniqueFoldId(baseId, store) {
  if (!store || typeof store.findFold !== 'function') return baseId
  if (!store.findFold(baseId)) return baseId
  for (let n = 2; n < 1000; n += 1) {
    const candidate = baseId + '-' + n
    if (!store.findFold(candidate)) return candidate
  }
  return baseId
}

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
  // 保护清单来自生效配置：读文件、写文件、加载技能的步骤整步保留，不进入任何片段。
  const segments = planSegments(nodes || [], {
    keepTools: settings.keepTools,
    keepPaths: settings.keepPaths,
    keepFileOps: settings.keepFileOps,
  })
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

    // 段号后缀按「已折叠的段」连续编号：中间有段被跳过时也不会出现空洞。
    const suffix = segments.length > 1 ? segmentSuffix(ids.length + 1) : ''
    const baseId = 'f' + turn + suffix
    const noteOptions = {
      foldId: baseId,
      turn,
      stats,
      maxTokens: noteChars(settings),
      toolName: recallToolName,
      includeToolOutputs: settings.foldToolOutputs,
    }
    // 比例判据：摘要长度 / 原文长度低于 minFoldRatio 才折，否则留着原文更划算。
    // 摘要长度由 stats 精确算出（含标题摘要），先预判、构建后再复核一次，
    // 省掉「构建完才发现不划算」的浪费。
    if (!isWorthFolding(estimateNoteChars(noteOptions), total, settings.minFoldRatio)) continue
    const foldId = uniqueFoldId(baseId, store)
    noteOptions.foldId = foldId
    const note = buildNoteEx(noteOptions)
    if (!isWorthFolding(note.text.length, total, settings.minFoldRatio)) continue

    const shadowed = surface.slice(startIdx, endIdx + 1)
    // 载荷必须覆盖整段：注入消息与工具调用参数都不进 total，按 total 估预算总会在最后几步
    // 之前花完，最先被丢掉的恰恰是最终回复——那正是召回最想拿到的结论。用不封顶的预算，
    // 体量上限交给调用方（召回返回时还有 maxRecallTokens 控制一次塞回多少）。
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
        note: note.text,
        replyTruncated: note.replyTruncated,
        items,
        ...(usageRecord ? { usage: usageRecord } : {}),
      })
      if (!persisted) {
        log && log.warn('折叠跳过（第 ' + turn + ' 轮 ' + foldId + '）：载荷写入失败，保留原文。')
        continue
      }
    }
    try {
      session.append('user/message', createCheckpointMessage({ text: note.text, foldId }), {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: shadowed,
      })
    } catch (error) {
      // 检查点没写进去，刚落的载荷就成了没人引用的孤儿：它还永久占着这个编号，
      // 之后同一轮再折会去拿 -2 这种新号，而那条死载荷永远查不到、也删不掉。
      // 这里立刻撤回，维持「有载荷必有检查点」；撤回失败只能留痕，不能静默。
      if (store && typeof store.remove === 'function' && !store.remove(foldId)) {
        log && log.warn('折叠失败后撤回载荷也失败（' + foldId + '）：该编号会一直被占用，召回会指向不存在的原文。')
      }
      log && log.warn('折叠失败（第 ' + turn + ' 轮 ' + foldId + '，seq ' + startSeq + '–' + endSeq + '）：' + (error && error.message ? error.message : error))
      continue
    }
    ids.push(foldId)
  }

  return { folded: ids.length, ids }
}

// 软上限只提示、不拒绝：条数与长度交给模型自己判断，插件不替它守门。
// 依据是短消息多记几条的收益高于它的常驻开销——每条 pin 只占一次输入，而反复召回要给整段。
function softLimitNote(settings, count, tokens) {
  const over = []
  if (settings.maxPins > 0 && count > settings.maxPins) over.push('条数已超过软上限 ' + settings.maxPins + ' 条')
  if (settings.pinBudgetTokens > 0 && tokens > settings.pinBudgetTokens) over.push('总 token 估算已超过软预算 ' + settings.pinBudgetTokens)
  if (over.length === 0) return ''
  return '（提示：重要消息' + over.join('、') + '，仍然照常发布；之后可以合并或精简旧条目。）'
}

// 发布一条重要消息：以 user/message 追加，永不进入折叠片段（planSegments 会在它前面断开）。
// 默认不设条数与长度上限：是否值得记由模型判断，硬配额只会让它在该记的时候不敢记。
export function publishPin({ session, label, text, config, store, log, turn, onPublish }) {
  const settings = config || normalizeConfig({})
  const raw = String(text || '').trim()
  // 只有显式配了正数才截断；即便截断也照常发布，不退回错误。
  const body = settings.maxPinTextTokens > 0 ? clip(raw, settings.maxPinTextTokens * CHARS_PER_TOKEN) : raw
  if (!body) return { ok: false, reason: '正文是空的，没有可发布的内容。' }
  const name = clip(String(label || '').trim(), 60) || '重要结论'
  // 账本记录先构造：轮内发布时它跟着消息一起入队，等消息真正注入成功后再落账。
  // 反过来（先写账本、消息等轮末 flush）在进程中途退出时会留下「账本有、历史没有」的 pin，
  // 统计页会把这条不存在的消息标成「已被压缩卷走」。
  const record = { kind: 'pin', id: name, text: body, at: Date.now() }
  // 记录发布时所在的轮：统计页要把它算成那一轮的负收益。旧记录没有这个字段。
  if (typeof turn === 'number' && Number.isFinite(turn) && turn > 0) record.turn = Math.floor(turn)
  // 轮内发布：消息注入要推迟到本轮折叠之后（onPublish）。
  // 早注入会落在「工具调用」与「工具结果」之间，planSegments 会被这条 keeper 打断，
  // 调用与结果既不能一起折、又不能各自折（孤儿 tool 消息），整段只能留在模型视野里。
  let queued = false
  if (typeof onPublish === 'function') {
    // 队列只在内存里：进程退出、运行时被 LRU 淘汰、插件 stop 都会把它清空。
    // 只把消息放进队列就回「已发布」，遇到上面任何一种情况都会变成一句没兑现的承诺。
    // 所以先落一条 pending 记录，等消息真的注入会话后再由宿主删掉；没删掉的会在
    // 下次进入这个会话时补投（host.js 的 restorePendingPins）。
    const pid = randomUUID()
    if (store && typeof store.append === 'function') {
      const pendingRecord = { kind: 'pin-pending', pid, id: name, text: body, at: record.at }
      if (record.turn) pendingRecord.turn = record.turn
      if (!store.append(pendingRecord)) {
        log && log.warn('发布重要消息失败：待投递记录写入失败：' + name)
        return { ok: false, reason: '载荷写入失败，重要消息没有发布。' }
      }
    }
    try {
      onPublish({ label: name, text: body, record, pid })
      queued = true
    } catch (error) {
      // 入队失败就把刚写的 pending 撤掉，否则下次进来会把它当「待补投」再发一遍。
      if (store && typeof store.resolvePending === 'function') store.resolvePending(pid)
      const reason = error && error.message ? error.message : String(error)
      log && log.warn('发布重要消息失败：' + reason)
      return { ok: false, reason: '写入会话失败：' + reason }
    }
  } else {
    try {
      session.append('user/message', createPinMessage({ label: name, text: body }), { surfaceOp: 'append' })
    } catch (error) {
      const reason = error && error.message ? error.message : String(error)
      log && log.warn('发布重要消息失败：' + reason)
      return { ok: false, reason: '写入会话失败：' + reason }
    }
    // 正文已经在会话消息里，记录写失败只影响账本，不影响「永不折叠」本身；但必须留痕。
    if (store && !store.append(record)) log && log.warn('重要消息已写入会话，但载荷记录失败：' + name)
  }
  let pins = []
  if (store) {
    // 入队的那条还没落账：先把它算进返回值，工具调用当场就能报出正确的条数。
    // 同名重发时按 label 去重（与 store.pins 一致），不能把旧记录和新记录算成两条。
    pins = typeof onPublish === 'function'
      ? store.pins().filter((pin) => String(pin.id) !== name).concat([record])
      : store.pins()
  }
  const totalTokens = pins.reduce((sum, pin) => sum + estimateTokens([String(pin.text || '')]), 0)
  const truncated = body.length < raw.length ? '（正文被 maxPinTextTokens 截断到约 ' + estimateTokens([body]) + ' token 估算）' : ''
  const result = { ok: true, label: name, chars: body.length }
  // 轮内发布只是排进队列，还没进会话：调用方要据此换一种说法，不能直接说「已发布」。
  if (queued) result.pending = true
  if (pins.length > 0) {
    result.pins = pins.length
    result.totalTokens = totalTokens
    result.note = truncated + softLimitNote(settings, pins.length, totalTokens)
  } else if (truncated) {
    result.note = truncated
  }
  return result
}

export { checkpointPrefix, pinPrefix }

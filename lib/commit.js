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
  let index = 0

  for (const segment of segments) {
    if (ids.length >= limit) break
    index += 1
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

    const suffix = segments.length > 1 ? String.fromCharCode(96 + index) : ''
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
    try {
      session.append('user/message', createCheckpointMessage({ text: note, foldId }), {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: shadowed,
      })
    } catch (error) {
      log && log.warn('折叠失败（第 ' + turn + ' 轮 ' + foldId + '）：' + (error && error.message ? error.message : error))
      continue
    }
    if (store) {
      store.append({
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
    }
    ids.push(foldId)
  }

  return { folded: ids.length, ids }
}

// 发布一条重要消息：以 user/message 追加，永不进入折叠片段（planSegments 会在它前面断开）。
// 配额在写之前判：超了就明确拒绝，而不是悄悄丢掉。
export function publishPin({ session, label, text, config, store, log, turn }) {
  const settings = config || normalizeConfig({})
  const body = clip(String(text || '').trim(), settings.maxPinTextChars)
  if (!body) return { ok: false, reason: '正文是空的，没有可发布的内容。' }
  const pins = store ? store.pins() : []
  if (pins.length >= settings.maxPins) {
    return { ok: false, reason: '这个会话已经有 ' + pins.length + ' 条重要消息（上限 ' + settings.maxPins + '），先删掉不再需要的再发布。' }
  }
  const used = pins.reduce((sum, pin) => sum + String(pin.text || '').length, 0)
  if (used + body.length > settings.pinBudgetChars) {
    return { ok: false, reason: '重要消息的正文预算快用完了（' + used + '/' + settings.pinBudgetChars + ' 字），这条放不下。' }
  }
  const name = clip(String(label || '').trim(), 60) || '重要结论'
  try {
    session.append('user/message', createPinMessage({ label: name, text: body }), { surfaceOp: 'append' })
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    log && log.warn('发布重要消息失败：' + reason)
    return { ok: false, reason: '写入会话失败：' + reason }
  }
  if (store) {
    const record = { kind: 'pin', id: name, text: body, at: Date.now() }
    // 记录发布时所在的轮：统计页要把它算成那一轮的负收益。旧记录没有这个字段。
    if (typeof turn === 'number' && Number.isFinite(turn) && turn > 0) record.turn = Math.floor(turn)
    store.append(record)
  }
  return { ok: true, label: name, chars: body.length }
}

export { checkpointPrefix, pinPrefix }

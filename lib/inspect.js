// 折叠可视化：把「模型真正看到的历史」与「不折叠时的历史」摊开成同一份报告模型。
//
// 两个视角都从同一处出发——会话的派生消息（session.deriveMessages()）：
//   · 模型视角：派生消息就是模型拿到的东西，一条检查点只是一条短消息；
//   · 不折叠视角：把带 foldId 的检查点按 fold-store 里的 items 原文展开，检查点本身消失。
// 后者不是日志重放，所以原文载荷缺失时只能退回摘要并记一条告警。
//
// 全部是纯函数，不 import 宿主包；token 按与宿主上下文面板一致的
// 经验公式估算（4 字符/token，按内容块 +4），不追求分词器级精确。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { reportDirName, sourceCheckpoint, sourcePin } from './constants.js'
import { safeFileName } from './store.js'
import { blocksOfFoldItem, blocksOfMessage, buildTurnGroups, entryKindOf } from './turns.js'
import { estimateChars, estimateMessageTokens } from './tokens.js'

const PREVIEW_CHARS = 200
const TEXT_REPORT_LIMIT = 2000

export function clipText(text, limit) {
  const value = typeof text === 'string' ? text : ''
  const max = typeof limit === 'number' && limit > 0 ? limit : PREVIEW_CHARS
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}

// 派生消息与 surface 节点都能喂进来：前者有 content，后者把消息包在 data / data.message 里。
export function asMessage(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (Array.isArray(raw.content)) return raw
  const data = raw.data && typeof raw.data === 'object' ? raw.data : null
  if (!data) return null
  const inner = raw.type === 'user/message' ? data : data.message
  return inner && typeof inner === 'object' ? inner : null
}

// 「模型看到的字符」：正文、思考、工具调用名与参数都算；非文本块只留一个占位符。
export function messageText(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'tool-call') {
      const name = typeof block.name === 'string' ? block.name : ''
      const args = typeof block.arguments === 'string' ? block.arguments : ''
      parts.push('[调用 ' + name + ']' + (args ? ' ' + args : ''))
      continue
    }
    if (typeof block.arguments === 'string') {
      parts.push(block.arguments)
      continue
    }
    if (block.type) parts.push('[' + block.type + ']')
  }
  return parts.join('\n')
}

function textOfEntry(entry) {
  if (!entry || typeof entry !== 'object') return ''
  if (typeof entry.text === 'string') return entry.text
  const message = asMessage(entry)
  return message ? messageText(message) : ''
}

function seqOf(raw, message) {
  if (raw && typeof raw.seq === 'number') return raw.seq
  if (message && typeof message.seq === 'number') return message.seq
  return null
}

function kindOf(message) {
  return message && message.source && typeof message.source.kind === 'string' ? message.source.kind : ''
}

function foldIdOf(message) {
  const source = message && message.source ? message.source : null
  return source && typeof source.foldId === 'string' && source.foldId ? source.foldId : ''
}

export function roleLabel(role) {
  switch (role) {
    case 'user':
      return '用户'
    case 'assistant':
      return '助手'
    case 'tool':
      return '工具'
    case 'developer':
      return '开发者'
    case 'system':
      return '系统'
    default:
      return '未知'
  }
}

export function sourceLabel(kind, foldId) {
  if (kind === sourceCheckpoint) return foldId ? '折叠检查点 ' + foldId : '折叠检查点'
  if (kind === sourcePin) return '重要消息（永不折叠）'
  if (kind === 'user') return '用户原话'
  if (kind === 'model') return '模型生成'
  if (kind === 'tool') return '工具结果'
  if (kind === 'runtime-context') return '运行时注入'
  if (kind === 'developer') return '开发者消息'
  if (kind === 'system') return '系统消息'
  if (kind === 'fold-record') return '折叠原文'
  return kind ? kind : '未知来源'
}

// fold 记录可能是 Map（store.folds()）、数组或普通对象，统一成 id -> 记录。
export function foldMapOf(folds) {
  const map = new Map()
  if (!folds) return map
  const records = folds instanceof Map ? Array.from(folds.values()) : Array.isArray(folds) ? folds : Object.values(folds)
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (record.kind && record.kind !== 'fold') continue
    if (typeof record.id === 'string' && record.id) map.set(record.id, record)
  }
  return map
}

function labelOfPin(pin) {
  if (!pin || typeof pin !== 'object') return '重要消息'
  const label = typeof pin.id === 'string' && pin.id ? pin.id : typeof pin.label === 'string' && pin.label ? pin.label : ''
  return label || '重要消息'
}

// pin 记录目前不带折叠编号；这里同时认显式字段，方便以后 commit 写入。
function foldIdsOfPin(pin) {
  if (!pin || typeof pin !== 'object') return []
  if (typeof pin.foldId === 'string' && pin.foldId) return [pin.foldId]
  if (Array.isArray(pin.foldIds)) return pin.foldIds.filter((id) => typeof id === 'string' && id)
  return []
}

function numericTime(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN
}

// 一条消息的 token：有 content 就按内容块算；只有文本（还原出来的折叠项）时按一个块算。
function tokensOfEntry(raw, message, text) {
  if (message && Array.isArray(message.content) && message.content.length > 0) return estimateMessageTokens(message)
  return estimateChars(text.length)
}

// 逐条统计模型视角：角色、来源、字符数与 token，标出检查点与重要消息。
export function summarizeModelView({ derivedMessages, folds, pins } = {}) {
  const foldMap = foldMapOf(folds)
  const pinRecords = Array.isArray(pins) ? pins.length : 0
  const list = Array.isArray(derivedMessages) ? derivedMessages : []
  const messages = []
  let chars = 0
  let tokens = 0
  let checkpoints = 0
  let pinCount = 0

  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i]
    const message = asMessage(raw)
    const text = textOfEntry(raw)
    const kind = kindOf(message)
    const foldId = foldIdOf(message)
    const isCheckpoint = kind === sourceCheckpoint || !!foldId
    const isPin = kind === sourcePin
    const role = message && typeof message.role === 'string' ? message.role : 'unknown'
    const messageTokens = tokensOfEntry(raw, message, text)
    chars += text.length
    tokens += messageTokens
    if (isCheckpoint) checkpoints += 1
    if (isPin) pinCount += 1
    messages.push({
      index: i + 1,
      seq: seqOf(raw, message),
      role,
      roleLabel: roleLabel(role),
      sourceKind: kind,
      sourceLabel: sourceLabel(kind, foldId),
      foldId,
      isCheckpoint,
      isPin,
      chars: text.length,
      tokens: messageTokens,
      preview: clipText(text, PREVIEW_CHARS),
    })
  }

  return {
    messages,
    totals: {
      count: messages.length,
      chars,
      checkpoints,
      pins: pinCount,
      pinRecords,
      tokens,
    },
  }
}

function roleOfItemText(text) {
  if (text.indexOf('[工具结果]') === 0) return 'tool'
  if (text.indexOf('[开发者消息]') === 0) return 'developer'
  if (text.indexOf('[注入消息]') === 0) return 'user'
  if (text.indexOf('[调用 ') === 0) return 'assistant'
  return 'assistant'
}

// 用 fold 记录里的 items 原文还原检查点，并按轮汇总折叠前/折叠后字符与节省率。
// 普通消息在两个视角里都一样，只有带 foldId 的检查点会被展开。
export function reconstructUnfolded({ derivedMessages, folds } = {}) {
  const foldMap = foldMapOf(folds)
  const list = Array.isArray(derivedMessages) ? derivedMessages : []
  const messages = []
  const foldRows = []
  const missing = []
  const turnMap = new Map()
  let chars = 0
  let tokens = 0

  function pushMessage(entry) {
    messages.push(entry)
    chars += entry.chars
    tokens += typeof entry.tokens === 'number' ? entry.tokens : 0
  }

  function turnRow(turn) {
    const key = typeof turn === 'number' && Number.isFinite(turn) ? turn : 'unknown'
    let row = turnMap.get(key)
    if (!row) {
      row = { turn: key, steps: 0, unfoldedChars: 0, foldedChars: 0, foldIds: [] }
      turnMap.set(key, row)
    }
    return row
  }

  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i]
    const message = asMessage(raw)
    const text = textOfEntry(raw)
    const kind = kindOf(message)
    const foldId = foldIdOf(message)
    const role = message && typeof message.role === 'string' ? message.role : 'unknown'

    if (kind === sourceCheckpoint || foldId) {
      const record = foldId ? foldMap.get(foldId) : undefined
      const items = record && Array.isArray(record.items) ? record.items : []
      if (!record || items.length === 0) {
        // 载荷缺失（fork 会话、fold-store 被删）：保留摘要，不假装能还原。
        missing.push(foldId || '无编号')
        pushMessage({
          index: i + 1,
          seq: seqOf(raw, message),
          role,
          roleLabel: roleLabel(role),
          sourceKind: kind,
          sourceLabel: sourceLabel(kind, foldId) + '（原文缺失）',
          foldId: foldId || '',
          isCheckpoint: true,
          isPin: false,
          turn: null,
          chars: text.length,
          tokens: estimateChars(text.length),
          preview: clipText(text, PREVIEW_CHARS),
          text,
        })
        continue
      }
      let unfoldedChars = 0
      let steps = 0
      for (const item of items) {
        const itemText = item && typeof item.text === 'string' ? item.text : ''
        const seq = item && typeof item.seq === 'number' ? item.seq : null
        const itemRole = roleOfItemText(itemText)
        unfoldedChars += itemText.length
        if (itemRole === 'assistant') steps += 1
        pushMessage({
          index: messages.length + 1,
          seq,
          role: itemRole,
          roleLabel: roleLabel(itemRole),
          sourceKind: 'fold-record',
          sourceLabel: '折叠原文 ' + foldId + (seq === null ? '' : ' #' + seq),
          foldId,
          fromFold: foldId,
          isCheckpoint: false,
          isPin: false,
          turn: typeof record.turn === 'number' ? record.turn : null,
          chars: itemText.length,
          tokens: estimateChars(itemText.length),
          preview: clipText(itemText, PREVIEW_CHARS),
          text: itemText,
        })
      }
      const foldedChars = text.length
      const saved = unfoldedChars - foldedChars
      const row = turnRow(record.turn)
      row.steps += steps
      row.unfoldedChars += unfoldedChars
      row.foldedChars += foldedChars
      row.foldIds.push(foldId)
      foldRows.push({
        foldId,
        turn: record.turn,
        steps,
        unfoldedChars,
        foldedChars,
        saved,
        saveRate: unfoldedChars > 0 ? saved / unfoldedChars : 0,
      })
      continue
    }

    pushMessage({
      index: i + 1,
      seq: seqOf(raw, message),
      role,
      roleLabel: roleLabel(role),
      sourceKind: kind,
      sourceLabel: sourceLabel(kind, foldId),
      foldId: foldId || '',
      isCheckpoint: false,
      isPin: kind === sourcePin,
      turn: null,
      chars: text.length,
      tokens: tokensOfEntry(raw, message, text),
      preview: clipText(text, PREVIEW_CHARS),
      text,
    })
  }

  const turns = Array.from(turnMap.values())
    .map((row) => {
      const saved = row.unfoldedChars - row.foldedChars
      return {
        turn: row.turn,
        steps: row.steps,
        unfoldedChars: row.unfoldedChars,
        foldedChars: row.foldedChars,
        saved,
        saveRate: row.unfoldedChars > 0 ? saved / row.unfoldedChars : 0,
        foldIds: row.foldIds,
        recallCount: 0,
        pinned: false,
      }
    })
    .sort((a, b) => {
      if (typeof a.turn === 'number' && typeof b.turn === 'number') return a.turn - b.turn
      return typeof a.turn === 'number' ? -1 : 1
    })

  return {
    messages,
    totals: { count: messages.length, chars, tokens, missing, expanded: messages.filter((item) => item.fromFold).length },
    turns,
    foldRows,
  }
}

// 召回次数与固化状态来自 fold-store：召回记录带 id 与 at，pin 记录带 label、正文与 at。
// 固化判定：pin 显式带 foldId 时直接认；否则把「召回之后发布的 pin」归给最近被召回的那段（推测）。
function annotateStats({ unfolded, folds, pins, recalls }) {
  const counts = new Map()
  const lastRecall = new Map()
  let recallTotal = 0
  for (const record of recalls) {
    if (!record || (record.kind && record.kind !== 'recall')) continue
    const id = String(record.id || '')
    if (!id) continue
    recallTotal += 1
    counts.set(id, (counts.get(id) || 0) + 1)
    const at = numericTime(record.at)
    if (Number.isFinite(at)) {
      const previous = lastRecall.has(id) ? lastRecall.get(id) : -Infinity
      lastRecall.set(id, Math.max(previous, at))
    }
  }

  const pinByFold = new Map()
  const explicitPins = new Set()
  function attach(foldId, label) {
    const list = pinByFold.get(foldId) || []
    if (list.indexOf(label) < 0) list.push(label)
    pinByFold.set(foldId, list)
  }
  for (const pin of pins) {
    for (const foldId of foldIdsOfPin(pin)) {
      attach(foldId, labelOfPin(pin))
      explicitPins.add(foldId)
    }
  }
  for (const pin of pins) {
    if (foldIdsOfPin(pin).length > 0) continue
    const at = numericTime(pin.at)
    if (!Number.isFinite(at)) continue
    let best = ''
    let bestAt = -Infinity
    for (const entry of lastRecall) {
      if (entry[1] <= at && entry[1] > bestAt) {
        best = entry[0]
        bestAt = entry[1]
      }
    }
    if (best) attach(best, labelOfPin(pin))
  }

  const foldRows = unfolded.foldRows.map((row) => {
    const labels = pinByFold.get(row.foldId) || []
    return {
      foldId: row.foldId,
      turn: row.turn,
      steps: row.steps,
      unfoldedChars: row.unfoldedChars,
      foldedChars: row.foldedChars,
      saved: row.saved,
      saveRate: row.saveRate,
      recallCount: counts.get(row.foldId) || 0,
      pinned: labels.length > 0,
      pinLabels: labels,
      pinnedBy: explicitPins.has(row.foldId) ? 'explicit' : labels.length > 0 ? 'after-recall' : '',
    }
  })

  const turns = unfolded.turns.map((row) => {
    let recallCount = 0
    let pinned = false
    for (const foldId of row.foldIds) {
      recallCount += counts.get(foldId) || 0
      if (pinByFold.has(foldId)) pinned = true
    }
    return { ...row, recallCount, pinned }
  })

  const pinRows = pins.map((pin) => ({
    label: labelOfPin(pin),
    chars: pin && typeof pin.text === 'string' ? pin.text.length : 0,
    turn: pin && typeof pin.turn === 'number' ? pin.turn : null,
    at: pin ? numericTime(pin.at) : NaN,
    foldIds: foldIdsOfPin(pin),
  }))

  const timeline = buildTimeline({ folds, pins, recalls })
  const recalledFolds = foldRows.filter((row) => row.recallCount > 0).length
  const pinChars = pinRows.reduce((sum, row) => sum + row.chars, 0)

  return {
    foldRows,
    turns,
    pinRows,
    timeline,
    totals: { recalls: recallTotal, recalledFolds, pinCount: pinRows.length, pinChars },
  }
}

function buildTimeline({ folds, pins, recalls }) {
  const events = []
  let order = 0
  for (const record of folds.values()) {
    const turn = typeof record.turn === 'number' ? '第 ' + record.turn + ' 轮，' : ''
    events.push({
      kind: 'fold',
      at: numericTime(record.at),
      label: '折叠 ' + record.id,
      detail: turn + fmt(record.chars || 0) + ' 字',
      order: order += 1,
    })
  }
  const seen = new Map()
  for (const record of recalls) {
    const id = String(record.id || '')
    if (!id) continue
    if (record.kind && record.kind !== 'recall') continue
    const nth = (seen.get(id) || 0) + 1
    seen.set(id, nth)
    events.push({ kind: 'recall', at: numericTime(record.at), label: '召回 ' + id, detail: '第 ' + nth + ' 次', order: order += 1 })
  }
  for (const pin of pins) {
    events.push({
      kind: 'pin',
      at: numericTime(pin.at),
      label: '发布重要消息「' + labelOfPin(pin) + '」',
      detail: (typeof pin.text === 'string' ? pin.text.length : 0) + ' 字',
      order: order += 1,
    })
  }
  events.sort((a, b) => {
    const hasA = Number.isFinite(a.at)
    const hasB = Number.isFinite(b.at)
    if (hasA && hasB && a.at !== b.at) return a.at - b.at
    if (hasA !== hasB) return hasA ? -1 : 1
    return a.order - b.order
  })
  return events
}

// 从 store 读三样记录：折叠地图、pin 快照、召回流水（recall 需要时间戳，所以走 readAll）。
export function collectRecords(store) {
  const folds = store && typeof store.folds === 'function' ? store.folds() : new Map()
  const pins = store && typeof store.pins === 'function' ? store.pins() : []
  const all = store && typeof store.readAll === 'function' ? store.readAll() : []
  const recalls = []
  for (const record of all) {
    if (record && record.kind === 'recall') recalls.push(record)
  }
  return { folds, pins, recalls }
}

// 逐轮视图的原料：把每条派生消息预处理成「角色 + 块结构 + 折叠载荷」，
// 之后分组与渲染都只读这份结构，不再碰宿主对象。
export function messageEntries({ derivedMessages, folds } = {}) {
  const foldMap = folds instanceof Map ? folds : foldMapOf(folds)
  const list = Array.isArray(derivedMessages) ? derivedMessages : []
  const entries = []
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i]
    const message = asMessage(raw)
    if (!message) continue
    const role = typeof message.role === 'string' ? message.role : 'unknown'
    const source = message.source && typeof message.source === 'object' ? message.source : {}
    const sourceKind = kindOf(message)
    const foldId = foldIdOf(message)
    const isCheckpoint = sourceKind === sourceCheckpoint || !!foldId
    const isPin = sourceKind === sourcePin
    const text = textOfEntry(raw)
    const record = isCheckpoint && foldId ? foldMap.get(foldId) : null
    const entry = {
      index: i + 1,
      seq: seqOf(raw, message),
      role,
      roleLabel: roleLabel(role),
      sourceKind,
      sourceLabel: sourceLabel(sourceKind, foldId),
      foldId,
      isCheckpoint,
      isPin,
      pinLabel: isPin && typeof source.label === 'string' ? source.label : '',
      chars: text.length,
      text,
      blocks: blocksOfMessage(message, role),
      foldRecord: null,
    }
    if (record) {
      const items = Array.isArray(record.items) ? record.items : []
      entry.foldRecord = {
        id: foldId,
        turn: typeof record.turn === 'number' ? record.turn : null,
        chars: typeof record.chars === 'number' ? record.chars : 0,
        items: items.map((item) => {
          const value = item && typeof item.text === 'string' ? item.text : ''
          return {
            seq: item && typeof item.seq === 'number' ? item.seq : null,
            chars: value.length,
            blocks: blocksOfFoldItem(value),
          }
        }),
      }
    }
    entries.push(entry)
  }
  return entries
}

// 旧版系统提示只是 surface 里的历史副本：真实请求只带最后一条生效的提示，
// 把它们算进「模型视角」总量会把上下文抬高好几倍，所以统计前先扣掉。
function excludeStaleSystem(folded, unfolded, groups) {
  let lastSystem = -1
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]
    if (group && group.kind !== 'turn' && (group.chars || 0) > 0) lastSystem = i
  }
  let chars = 0
  let tokens = 0
  let count = 0
  for (let i = 0; i < groups.length; i += 1) {
    if (i === lastSystem) continue
    const group = groups[i]
    if (!group || group.kind === 'turn') continue
    const entries = Array.isArray(group.entries) ? group.entries : []
    for (const entry of entries) {
      chars += typeof entry.chars === 'number' ? entry.chars : 0
      tokens += typeof entry.tokens === 'number' ? entry.tokens : 0
      count += 1
    }
  }
  if (chars === 0 && tokens === 0) return { chars: 0, tokens: 0, count: 0 }
  for (const view of [folded, unfolded]) {
    view.totals.chars = Math.max(0, view.totals.chars - chars)
    view.totals.tokens = Math.max(0, view.totals.tokens - tokens)
    view.totals.count = Math.max(0, view.totals.count - count)
  }
  return { chars, tokens, count }
}

export function buildReportModel({ sessionId, derivedMessages, folds, pins, recalls, config, now } = {}) {
  const messages = Array.isArray(derivedMessages) ? derivedMessages : []
  const pinList = Array.isArray(pins) ? pins : []
  const recallList = Array.isArray(recalls) ? recalls : []
  const foldMap = foldMapOf(folds)

  const folded = summarizeModelView({ derivedMessages: messages, folds: foldMap, pins: pinList })
  const unfolded = reconstructUnfolded({ derivedMessages: messages, folds: foldMap })

  const entries = messageEntries({ derivedMessages: messages, folds: foldMap })
  const turnGroups = buildTurnGroups({ entries })

  const staleSystem = excludeStaleSystem(folded, unfolded, turnGroups)

  const stats = annotateStats({ unfolded, folds: foldMap, pins: pinList, recalls: recallList })
  const saved = unfolded.totals.chars - folded.totals.chars
  const saveRate = unfolded.totals.chars > 0 ? saved / unfolded.totals.chars : 0

  const warns = []
  if (unfolded.totals.missing.length > 0) {
    warns.push(
      '有 ' + unfolded.totals.missing.length + ' 个检查点找不到原文载荷（' +
        unfolded.totals.missing.slice(0, 5).join('、') +
        '）：fork 会话或 fold-store 被清理时会这样，不折叠视角只能看到摘要。',
    )
  }
  if (folded.totals.checkpoints === 0) warns.push('模型视角里没有折叠检查点：这个会话还没折过，或历史来自插件装上之前。')
  if (foldMap.size === 0) warns.push('fold-store 里没有折叠记录：召回、固化与时间线都无从统计。')
  if (config && config.enabled === false) warns.push('配置里 enabled 为 false：之后不会再自动折叠，以下是既有记录。')

  return {
    sessionId: sessionId || '未知会话',
    generatedAt: typeof now === 'number' ? now : Date.now(),
    folded,
    unfolded,
    entries,
    turnGroups,
    turns: stats.turns,
    foldRows: stats.foldRows,
    pinRows: stats.pinRows,
    timeline: stats.timeline,
    staleSystem,
    totals: { ...stats.totals, saved, saveRate },
    config: config || {},
    warns,
  }
}

function fmt(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function pct(rate) {
  const value = typeof rate === 'number' && Number.isFinite(rate) ? rate : 0
  return (value * 100).toFixed(1) + '%'
}

function turnText(turn) {
  return typeof turn === 'number' && Number.isFinite(turn) ? String(turn) : '?'
}

function tokenText(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return 'token 估算不可用'
  return '约 ' + fmt(tokens) + ' token'
}

export function buildTextReport(model = {}, options = {}) {
  const data = model && typeof model === 'object' ? model : {}
  const foldedTotals = (data.folded && data.folded.totals) || { count: 0, chars: 0, tokens: {} }
  const unfoldedTotals = (data.unfolded && data.unfolded.totals) || { count: 0, chars: 0, tokens: {} }
  const turns = Array.isArray(data.turns) ? data.turns : []
  const foldRows = Array.isArray(data.foldRows) ? data.foldRows : []
  const pinRows = Array.isArray(data.pinRows) ? data.pinRows : []
  const warns = Array.isArray(data.warns) ? data.warns : []
  const totals = data.totals || {}
  const saved = unfoldedTotals.chars - foldedTotals.chars
  const saveRate = unfoldedTotals.chars > 0 ? saved / unfoldedTotals.chars : 0
  const limit = typeof options.maxChars === 'number' && options.maxChars >= 200 ? Math.floor(options.maxChars) : TEXT_REPORT_LIMIT

  const lines = []
  lines.push('折叠可视化：' + (data.sessionId || '未知会话'))
  lines.push('模型视角：' + fmt(foldedTotals.count) + ' 条，' + fmt(foldedTotals.chars) + ' 字（' + tokenText(foldedTotals.tokens) + '）')
  lines.push('不折叠：' + fmt(unfoldedTotals.count) + ' 条，' + fmt(unfoldedTotals.chars) + ' 字（' + tokenText(unfoldedTotals.tokens) + '）')
  lines.push(
    '节省：' + fmt(saved) + ' 字（' + pct(saveRate) + '）；折叠段 ' + fmt(foldRows.length) +
      '，召回 ' + fmt(totals.recalls) + ' 次（涉及 ' + fmt(totals.recalledFolds) + ' 段），重要消息 ' +
      fmt(totals.pinCount) + ' 条（' + fmt(totals.pinChars) + ' 字）',
  )
  if (turns.length > 0) {
    lines.push('按轮：')
    for (const row of turns.slice(0, 8)) {
      lines.push(
        '  第 ' + turnText(row.turn) + ' 轮 ' + fmt(row.unfoldedChars) + ' → ' + fmt(row.foldedChars) +
          ' 字（' + pct(row.saveRate) + '，召回 ' + fmt(row.recallCount) + ' 次）',
      )
    }
  }
  if (foldRows.length > 0) {
    lines.push('折叠段：')
    for (const row of foldRows.slice(0, 8)) {
      lines.push(
        '  ' + row.foldId + ' 第 ' + turnText(row.turn) + ' 轮 ' + fmt(row.unfoldedChars) + ' → ' +
          fmt(row.foldedChars) + ' 字，召回 ' + fmt(row.recallCount) + ' 次，' + (row.pinned ? '已固化' : '未固化'),
      )
    }
  }
  if (pinRows.length > 0) {
    lines.push('重要消息：')
    for (const row of pinRows.slice(0, 5)) {
      lines.push('  「' + row.label + '」' + fmt(row.chars) + ' 字' + (typeof row.turn === 'number' ? ' · 第 ' + row.turn + ' 轮' : ''))
    }
  }
  for (const line of warns.slice(0, 3)) lines.push('注意：' + line)
  lines.push('口径：token = 每块 ceil(字符数/4)+4、每条消息 +4（同宿主上下文面板）；不含系统提示词与工具定义；不折叠视角依赖 fold-store 原文。')
  let text = lines.join('\n')
  if (text.length > limit) text = text.slice(0, limit - 1) + '…'
  return text
}


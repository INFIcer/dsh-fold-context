// 折叠可视化：把「模型真正看到的历史」与「不折叠时的历史」摊开成数据与单文件 HTML 报告。
//
// 两个视角都从同一处出发——会话的派生消息（session.deriveMessages()）：
//   · 模型视角：派生消息就是模型拿到的东西，一条检查点只是一条短消息；
//   · 不折叠视角：把带 foldId 的检查点按 fold-store 里的 items 原文展开，检查点本身消失。
// 后者不是日志重放，所以原文载荷缺失时只能退回摘要并记一条告警。
//
// 除 writeReport 外的函数都是纯函数，不 import 宿主包；token 按与宿主上下文面板一致的
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
  const turnGroups = buildTurnGroups({
    entries,
    minFoldTokens: config && typeof config.minFoldTokens === 'number' ? config.minFoldTokens : 0,
  })

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

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmt(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function pct(rate) {
  const value = typeof rate === 'number' && Number.isFinite(rate) ? rate : 0
  return (value * 100).toFixed(1) + '%'
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

function dateTimeText(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  )
}

function timeText(at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '时间未知'
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

function turnText(turn) {
  return typeof turn === 'number' && Number.isFinite(turn) ? String(turn) : '?'
}

function tokenText(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return 'token 估算不可用'
  return '约 ' + fmt(tokens) + ' token'
}

const CSS = [
  ':root{--bg:#f5f6f8;--panel:#fff;--ink:#1f2328;--muted:#68707a;--line:#e2e5e9;--accent:#2f6feb;--good:#1a7f37;--warn:#9a6700;--pin:#8250df;--ckpt:#5c6670}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
  'header{padding:20px 24px 16px;background:var(--panel);border-bottom:1px solid var(--line)}',
  'h1{font-size:20px;margin:0 0 6px}',
  '.meta{color:var(--muted);font-size:12px;margin-top:2px}',
  '.toolbar{margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.toolbar button{font:inherit;font-size:13px;padding:5px 12px;border:1px solid var(--line);background:var(--panel);border-radius:8px;cursor:pointer;color:var(--ink)}',
  '.toolbar button:hover{border-color:var(--accent);color:var(--accent)}',
  '.check{font-size:13px;color:var(--muted);display:flex;gap:6px;align-items:center;cursor:pointer}',
  'main{max-width:1120px;margin:0 auto;padding:20px 24px 64px}',
  'section{margin-bottom:26px}',
  'h2{font-size:15px;margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}',
  '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}',
  '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}',
  '.card .k{color:var(--muted);font-size:12px}',
  '.card .v{font-size:20px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}',
  '.card .s{color:var(--muted);font-size:12px;margin-top:2px}',
  '.card.save .v{color:var(--good)}',
  'table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}',
  'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px}',
  'th{color:var(--muted);font-weight:500;background:#fafbfc;white-space:nowrap}',
  'tr:last-child td{border-bottom:none}',
  '.num{text-align:right;font-variant-numeric:tabular-nums}',
  '.empty{color:var(--muted);font-size:13px;margin:6px 0}',
  '.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}',
  '.tag.ok{color:var(--good);border-color:#b7e0c3;background:#f2fbf4}',
  '.tag.ckpt{color:var(--ckpt);border-color:#d9dde2}',
  '.tag.pin{color:var(--pin);border-color:#ddc9ff;background:#faf5ff}',
  '.timeline{list-style:none;margin:0;padding:0;position:relative}',
  '.timeline:before{content:"";position:absolute;left:7px;top:6px;bottom:6px;width:2px;background:var(--line)}',
  '.timeline li{position:relative;padding:0 0 10px 26px;font-size:13px}',
  '.timeline li:before{content:"";position:absolute;left:2px;top:7px;width:12px;height:12px;border-radius:50%;background:#c4cbd3;border:2px solid var(--bg)}',
  '.timeline li.fold:before{background:var(--ckpt)}',
  '.timeline li.recall:before{background:var(--accent)}',
  '.timeline li.pin:before{background:var(--pin)}',
  '.timeline .tl-detail{color:var(--muted);font-size:12px;margin-left:8px}',
  '.timeline time{color:var(--muted);font-size:12px;margin-left:8px;font-variant-numeric:tabular-nums}',
  'details.msg-block{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:12px}',
  'details.msg-block > summary{cursor:pointer;padding:12px 14px;font-weight:500}',
  'details.msg-block[open] > summary{border-bottom:1px solid var(--line)}',
  '.rows{padding:6px 14px 14px}',
  '.row{display:grid;grid-template-columns:42px 46px minmax(0,1fr) 74px;gap:8px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:13px;align-items:baseline}',
  '.row:last-child{border-bottom:none}',
  '.row .idx{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}',
  '.row .role{font-size:12px;font-weight:500}',
  '.role-user{color:var(--accent)}',
  '.role-assistant{color:#0a7d54}',
  '.role-tool{color:var(--warn)}',
  '.role-developer{color:var(--pin)}',
  '.role-unknown{color:var(--muted)}',
  '.row .src{color:var(--muted);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.row .seq{color:#a8b0b8}',
  '.row .turn{color:var(--accent);margin-right:6px}',
  '.row .chars{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}',
  '.row .preview{grid-column:1 / -1;color:#333;font-size:12.5px;white-space:pre-wrap;word-break:break-word}',
  '.legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px;color:var(--muted);margin:0 0 8px}',
  '.legend .sw{display:inline-flex;align-items:center;gap:6px}',
  '.legend .sw i{width:12px;height:12px;border-radius:3px;display:inline-block;border-left:3px solid transparent}',
  '.hint{font-size:12.5px;color:var(--muted);margin:0 0 12px}',
  'details.turn{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;overflow:hidden}',
  'details.turn>summary{cursor:pointer;padding:10px 14px;list-style:none}',
  'details.turn>summary::-webkit-details-marker{display:none}',
  'details.turn>summary:hover{background:#fafbfc}',
  'details.turn[open]>summary{border-bottom:1px solid var(--line);background:#fafbfc}',
  '.thead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.tno{font-size:13px;font-weight:600}',
  '.tmeta{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}',
  '.peek{margin-top:5px;font-size:12.5px;color:#3c434b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.peek .pk{display:inline-block;min-width:36px;color:var(--muted);margin-right:8px}',
  '.tbody{padding:10px 14px 14px;display:flex;flex-direction:column;gap:8px}',
  '.blk{border-radius:8px;padding:8px 10px;border-left:3px solid transparent}',
  '.blk .bh{font-size:11.5px;color:#5b636c;margin-bottom:3px;font-variant-numeric:tabular-nums}',
  '.blk .bt{font-size:13px;white-space:pre-wrap;word-break:break-word}',
  '.blk .bt.scroll{max-height:240px;overflow:auto}',
  'body.wide .blk .bt.scroll{max-height:none}',
  '.k-user{background:#e8f0fe;border-left-color:#2f6feb}',
  '.k-inject{background:#f1f3f6;border-left-color:#9aa3ae}',
  '.k-dev{background:#f5f3ff;border-left-color:#7c3aed}',
  '.k-pin{background:#faf5ff;border-left-color:#8250df}',
  '.k-ckpt{background:#e7ecf2;border-left-color:#5c6670}',
  '.k-think{background:#fffbeb;border-left-color:#d4a72c}',
  '.k-call{background:#eef2ff;border-left-color:#4f46e5}',
  '.k-result{background:#fff4e5;border-left-color:#d97706}',
  '.k-reply{background:#ecfdf5;border-left-color:#1a7f37}',
  '.k-text{background:#f7f8fa;border-left-color:#b8bec6}',
  '.divider{font-size:11.5px;color:var(--muted);border-top:1px dashed var(--line);padding-top:7px;margin-top:2px}',
  'details.inject{background:#f7f8fa;border:1px solid var(--line);border-radius:8px;padding:0}',
  'details.inject>summary{cursor:pointer;padding:6px 10px;font-size:12px;color:var(--muted)}',
  'details.inject .blk{margin:0 8px 8px}',
  'details.sys{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:10px}',
  'details.sys>summary{cursor:pointer;padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.tag.dim{color:var(--muted)}',
  '.notes,.warns{font-size:12.5px;color:var(--muted);padding-left:18px;margin:8px 0}',
  '.warns li{color:var(--warn)}',
  '@media (max-width:640px){.row{grid-template-columns:32px 40px minmax(0,1fr) 64px}main{padding:12px}}',
].join('\n')

const SCRIPT = [
  '(function () {',
  '  var groups = document.querySelectorAll("details.turn, details.sys");',
  '  function setAll(open) {',
  '    for (var i = 0; i < groups.length; i += 1) groups[i].open = open;',
  '  }',
  '  var openBtn = document.getElementById("btnOpen");',
  '  var closeBtn = document.getElementById("btnClose");',
  '  if (openBtn) openBtn.addEventListener("click", function () { setAll(true); });',
  '  if (closeBtn) closeBtn.addEventListener("click", function () { setAll(false); });',
  '  var only = document.getElementById("onlyFolded");',
  '  if (only) {',
  '    only.addEventListener("change", function () {',
  '      for (var i = 0; i < groups.length; i += 1) {',
  '        var folded = groups[i].getAttribute("data-folded") === "1";',
  '        groups[i].style.display = only.checked && !folded ? "none" : "";',
  '      }',
  '    });',
  '  }',
  '  var wide = document.getElementById("wideText");',
  '  if (wide) {',
  '    wide.addEventListener("change", function () {',
  '      document.body.className = wide.checked ? "wide" : "";',
  '    });',
  '  }',
  '})();',
].join('\n')

function card(title, value, sub, extraClass) {
  return (
    '<div class="card' + (extraClass ? ' ' + extraClass : '') + '">' +
      '<div class="k">' + esc(title) + '</div>' +
      '<div class="v">' + esc(value) + '</div>' +
      '<div class="s">' + esc(sub) + '</div>' +
    '</div>'
  )
}

// 块的底色由类型决定：用户原话蓝、折叠摘要灰、思考琥珀、调用靛、结果橙、回复绿、重要消息紫。
const KIND_CLASS = {
  user: 'user',
  inject: 'inject',
  developer: 'dev',
  checkpoint: 'ckpt',
  pin: 'pin',
  system: 'text',
  think: 'think',
  call: 'call',
  result: 'result',
  reply: 'reply',
  text: 'text',
  other: 'other',
}

const BLOCK_LABEL = {
  think: '思考',
  call: '工具调用',
  result: '工具结果',
  reply: '回复',
  text: '正文',
  developer: '开发者消息',
  inject: '上下文注入',
  other: '其它块',
}

function classOfKind(kind) {
  return KIND_CLASS[kind] || 'text'
}

function headLine(label, chars, seq) {
  const parts = [esc(label), fmt(chars) + ' 字']
  if (typeof seq === 'number') parts.push('#' + esc(seq))
  return parts.join(' · ')
}

function blockCard(cls, head, text, scroll) {
  return (
    '<div class="blk ' + cls + '">' +
      '<div class="bh">' + head + '</div>' +
      '<div class="bt' + (scroll ? ' scroll' : '') + '">' + esc(text) + '</div>' +
    '</div>'
  )
}

function blockHead(block, seq) {
  const label = BLOCK_LABEL[block.kind] || '内容'
  const name = block.kind === 'call' && block.name ? ' ' + block.name : ''
  const parts = [esc(label + name), fmt(block.text.length) + ' 字']
  if (typeof seq === 'number') parts.push('#' + esc(seq))
  return parts.join(' · ')
}

// 长块不裁剪内容，只给滚动框：工具栏的「展开长文本」能把滚动框全打开。
function blockHtml(block, seq) {
  const scroll = block.kind === 'think' || block.kind === 'call' || block.kind === 'result'
  return blockCard('k-' + classOfKind(block.kind), blockHead(block, seq), block.text, scroll)
}

function checkpointHtml(entry) {
  const out = []
  const title = entry.foldId ? '折叠摘要 ' + entry.foldId : '折叠摘要'
  out.push(blockCard('k-ckpt', headLine(title + '（模型只看得到这一段）', entry.chars, entry.seq), entry.text, false))
  const record = entry.foldRecord
  if (!record || record.items.length === 0) {
    out.push('<p class="empty">这段折叠找不到原文载荷（fork 会话或 fold-store 被清理过），只能看到摘要。</p>')
    return out.join('')
  }
  out.push('<div class="divider">以下是折叠掉的原文，报告替你摊开，模型看不到</div>')
  for (const item of record.items) {
    for (const block of item.blocks) out.push(blockHtml(block, item.seq))
  }
  return out.join('')
}

function entryHtml(entry) {
  const kind = entryKindOf(entry)
  if (kind === 'user') return blockCard('k-user', headLine('用户原话', entry.chars, entry.seq), entry.text, false)
  if (kind === 'pin') return blockCard('k-pin', headLine('重要消息 · 永不折叠', entry.chars, entry.seq), entry.text, false)
  if (kind === 'system') return blockCard('k-text', headLine('系统提示词', entry.chars, entry.seq), entry.text, false)
  if (kind === 'inject' || kind === 'developer') {
    const label = kind === 'developer' ? '开发者消息' : '上下文注入'
    return (
      '<details class="inject">' +
        '<summary>' + headLine(label + ' · 未折叠，点开看全文', entry.chars, entry.seq) + '</summary>' +
        blockCard('k-' + classOfKind(kind), '全文', entry.text, false) +
      '</details>'
    )
  }
  if (kind === 'checkpoint') return checkpointHtml(entry)
  const blocks = entry.blocks.length ? entry.blocks : [{ kind: 'text', name: '', text: entry.text }]
  const out = []
  for (const block of blocks) out.push(blockHtml(block, entry.seq))
  return out.join('')
}

function swatch(kind, label) {
  return '<span class="sw"><i class="k-' + classOfKind(kind) + '"></i>' + esc(label) + '</span>'
}

function peekText(text, limit) {
  const value = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
  if (!value) return '（没有文字）'
  return clipText(value, limit)
}

// 一轮一块：收起时只露用户第一句与最终回复，展开能看到本轮全部内容与折叠原文。
function turnGroupHtml(group) {
  const label = typeof group.turn === 'number' ? '第 ' + fmt(group.turn) + ' 轮' : '第 ' + fmt(group.ordinal) + ' 段'
  const tags = []
  for (const id of group.foldIds) tags.push('<span class="tag ckpt">' + esc(id) + '</span>')
  if (group.continuation) tags.push('<span class="tag dim">轮内续接</span>')
  if (group.folded) tags.push('<span class="tag ok">已折叠 · 省 ' + pct(group.saveRate) + '</span>')
  else if (group.prePlugin) tags.push('<span class="tag dim">插件生效前 · 未折叠</span>')
  else tags.push('<span class="tag dim">' + (group.short ? '内容较少 · 未折叠' : '未折叠') + '</span>')
  const meta = fmt(group.steps) + ' 步 · ' + fmt(group.chars) + ' 字' + (group.folded ? ' ← 原文 ' + fmt(group.unfoldedChars) + ' 字' : '')
  const body = []
  for (const entry of group.entries) body.push(entryHtml(entry))
  // 回复原文已经离开上下文时：先用折叠摘要里留下的回复开头，再退到摘要首行。
  const replyPeek = group.replyText
    ? '<div class="peek"><span class="pk">回复</span>' + esc(peekText(group.replyText, 150)) + '</div>'
    : group.replyNote
      ? '<div class="peek"><span class="pk">回复</span>' + esc(peekText(group.replyNote, 150)) + '</div>'
      : group.lastCheckpointText
      ? '<div class="peek"><span class="pk">摘要</span>' + esc(peekText(group.lastCheckpointText, 150)) + '</div>'
      : ''
  return (
    '<details class="turn" data-folded="' + (group.folded ? '1' : '0') + '">' +
      '<summary>' +
        '<div class="thead"><span class="tno">' + esc(label) + '</span>' + tags.join('') + '<span class="tmeta">' + esc(meta) + '</span></div>' +
        '<div class="peek"><span class="pk">用户</span>' + esc(peekText(group.userText, 150)) + '</div>' +
        replyPeek +
      '</summary>' +
      '<div class="tbody">' + (body.length ? body.join('') : '<p class="empty">这一轮没有内容。</p>') + '</div>' +
    '</details>'
  )
}

// 系统提示词从不折叠：按出现时间单独成块、全文展开，不混进任何一轮。
// 报告只负责如实记录；「模型视角」页里后一版默认只显示差异。
function systemGroupHtml(group) {
  const body = []
  for (const entry of group.entries) body.push(entryHtml(entry))
  const version = typeof group.version === 'number' && group.version > 0 ? group.version : 1
  const diff = group.diff
  const tags = ['<span class="tag dim">第 ' + fmt(version) + ' 版 · 不折叠 · 全文</span>']
  if (version > 1 && diff) {
    tags.push('<span class="tag ' + (diff.same ? 'dim' : 'ok') + '">' +
      (diff.same ? '与上一版一致' : '与第 ' + fmt(version - 1) + ' 版相比 +' + fmt(diff.add) + ' −' + fmt(diff.del)) + '</span>')
  }
  return (
    '<details class="sys" data-folded="0">' +
      '<summary><span class="tno">系统提示词</span>' + tags.join('') +
        '<span class="tmeta">' + fmt(group.chars) + ' 字</span></summary>' +
      '<div class="tbody">' + body.join('') + '</div>' +
    '</details>'
  )
}

// 单文件 HTML：CSS 与 JS 内联，零外部资源；所有来自会话的文本都过 esc。
export function buildHtmlReport(model = {}) {
  const data = model && typeof model === 'object' ? model : {}
  const foldedTotals = (data.folded && data.folded.totals) || { count: 0, chars: 0, checkpoints: 0, pins: 0, tokens: {} }
  const unfoldedTotals = (data.unfolded && data.unfolded.totals) || { count: 0, chars: 0, tokens: {} }
  const turnGroups = Array.isArray(data.turnGroups) ? data.turnGroups : []
  const turns = Array.isArray(data.turns) ? data.turns : []
  const foldRows = Array.isArray(data.foldRows) ? data.foldRows : []
  const pinRows = Array.isArray(data.pinRows) ? data.pinRows : []
  const timeline = Array.isArray(data.timeline) ? data.timeline : []
  const warns = Array.isArray(data.warns) ? data.warns : []
  const totals = data.totals || {}
  const config = data.config && typeof data.config === 'object' ? data.config : {}
  const sessionId = String(data.sessionId || '未知会话')
  const generatedAt = data.generatedAt ? new Date(data.generatedAt) : new Date()
  const saved = unfoldedTotals.chars - foldedTotals.chars
  const saveRate = unfoldedTotals.chars > 0 ? saved / unfoldedTotals.chars : 0

  const parts = []
  parts.push('<!DOCTYPE html>')
  parts.push('<html lang="zh-CN">')
  parts.push('<head>')
  parts.push('<meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  parts.push('<title>折叠可视化 · ' + esc(sessionId) + '</title>')
  parts.push('<style>')
  parts.push(CSS)
  parts.push('</style>')
  parts.push('</head>')
  parts.push('<body>')

  parts.push('<header>')
  parts.push('<h1>折叠可视化报告</h1>')
  parts.push('<div class="meta">会话 ' + esc(sessionId) + ' · 生成于 ' + esc(dateTimeText(generatedAt)) + (config.enabled === false ? ' · 折叠已关闭' : '') + '</div>')
  parts.push('<div class="meta">折叠阈值 ' + fmt(config.minFoldTokens) + ' 字 · 召回提醒阈值 ' + fmt(config.recallReminderAfter) + ' 次</div>')
  parts.push('<div class="toolbar">')
  parts.push('<button id="btnOpen" type="button">展开全部</button>')
  parts.push('<button id="btnClose" type="button">收起全部</button>')
  parts.push('<label class="check"><input id="onlyFolded" type="checkbox"> 只看已折叠的轮次</label>')
  parts.push('<label class="check"><input id="wideText" type="checkbox"> 展开长文本</label>')
  parts.push('</div>')
  parts.push('</header>')

  parts.push('<main>')

  parts.push('<section>')
  parts.push('<h2>概览</h2>')
  parts.push('<div class="cards">')
  parts.push(card('折叠后（模型视角）', fmt(foldedTotals.chars) + ' 字', tokenText(foldedTotals.tokens) + ' · ' + fmt(foldedTotals.count) + ' 条消息'))
  parts.push(card('不折叠（原始视角）', fmt(unfoldedTotals.chars) + ' 字', tokenText(unfoldedTotals.tokens) + ' · ' + fmt(unfoldedTotals.count) + ' 条消息'))
  parts.push(card('节省', pct(saveRate), '省下 ' + fmt(saved > 0 ? saved : 0) + ' 字', 'save'))
  parts.push(card('折叠段数', fmt(foldRows.length), '检查点消息 ' + fmt(foldedTotals.checkpoints) + ' 条'))
  parts.push(card('召回', fmt(totals.recalls) + ' 次', '涉及 ' + fmt(totals.recalledFolds) + ' 段折叠'))
  parts.push(card('重要消息', fmt(totals.pinCount) + ' 条', '占用 ' + fmt(totals.pinChars) + ' 字'))
  parts.push('</div>')
  parts.push('</section>')

  parts.push('<section>')
  parts.push('<h2>事件时间线</h2>')
  if (timeline.length === 0) {
    parts.push('<p class="empty">没有折叠、召回或重要消息记录。</p>')
  } else {
    parts.push('<ol class="timeline">')
    for (const event of timeline) {
      const detail = event.detail ? '<span class="tl-detail">' + esc(event.detail) + '</span>' : ''
      const when = Number.isFinite(event.at) ? timeText(event.at) : '时间未知'
      parts.push(
        '<li class="' + esc(event.kind) + '">' + '<span class="tl-label">' + esc(event.label) + '</span>' + detail +
          '<time>' + esc(when) + '</time>' + '</li>',
      )
    }
    parts.push('</ol>')
  }
  parts.push('</section>')

  parts.push('<section>')
  parts.push('<h2>按轮对比</h2>')
  if (turns.length === 0) {
    parts.push('<p class="empty">没有可对比的轮次。</p>')
  } else {
    parts.push('<table><thead><tr><th>轮次</th><th class="num">步数</th><th class="num">折叠前字符</th><th class="num">折叠后字符</th><th class="num">节省</th><th class="num">节省率</th><th class="num">召回次数</th></tr></thead><tbody>')
    for (const row of turns) {
      parts.push(
        '<tr><td>第 ' + esc(turnText(row.turn)) + ' 轮</td>' +
          '<td class="num">' + fmt(row.steps) + '</td>' +
          '<td class="num">' + fmt(row.unfoldedChars) + '</td>' +
          '<td class="num">' + fmt(row.foldedChars) + '</td>' +
          '<td class="num">' + fmt(row.saved) + '</td>' +
          '<td class="num">' + pct(row.saveRate) + '</td>' +
          '<td class="num">' + fmt(row.recallCount) + '</td></tr>',
      )
    }
    parts.push('</tbody></table>')
  }
  parts.push('</section>')

  parts.push('<section>')
  parts.push('<h2>折叠段明细</h2>')
  if (foldRows.length === 0) {
    parts.push('<p class="empty">没有折叠段。</p>')
  } else {
    parts.push('<table><thead><tr><th>编号</th><th>轮次</th><th class="num">折叠前字符</th><th class="num">折叠后字符</th><th class="num">节省</th><th class="num">节省率</th><th class="num">被召回次数</th><th>固化状态</th></tr></thead><tbody>')
    for (const row of foldRows) {
      const pinnedText = row.pinned ? (row.pinnedBy === 'explicit' ? '已固化' : '已固化（召回后）') : '未固化'
      const pinnedClass = row.pinned ? 'tag ok' : 'tag'
      parts.push(
        '<tr><td><span class="tag ckpt">' + esc(row.foldId) + '</span></td>' +
          '<td>第 ' + esc(turnText(row.turn)) + ' 轮</td>' +
          '<td class="num">' + fmt(row.unfoldedChars) + '</td>' +
          '<td class="num">' + fmt(row.foldedChars) + '</td>' +
          '<td class="num">' + fmt(row.saved) + '</td>' +
          '<td class="num">' + pct(row.saveRate) + '</td>' +
          '<td class="num">' + fmt(row.recallCount) + '</td>' +
          '<td><span class="' + pinnedClass + '">' + esc(pinnedText) + '</span></td></tr>',
      )
    }
    parts.push('</tbody></table>')
  }
  parts.push('</section>')

  parts.push('<section>')
  parts.push('<h2>重要消息</h2>')
  if (pinRows.length === 0) {
    parts.push('<p class="empty">没有发布过重要消息。</p>')
  } else {
    parts.push('<table><thead><tr><th>标题</th><th class="num">字数</th><th>轮次</th><th>发布时间</th></tr></thead><tbody>')
    for (const row of pinRows) {
      const when = Number.isFinite(row.at) ? timeText(row.at) : '时间未知'
      parts.push(
        '<tr><td><span class="tag pin">' + esc(row.label) + '</span></td>' +
          '<td class="num">' + fmt(row.chars) + '</td>' +
          '<td>' + (typeof row.turn === 'number' ? '第 ' + fmt(row.turn) + ' 轮' : '未记录') + '</td>' +
          '<td>' + esc(when) + '</td></tr>',
      )
    }
    parts.push('</tbody></table>')
  }
  parts.push('</section>')

  parts.push('<section>')
  parts.push('<h2>逐轮历史</h2>')
  parts.push(
    '<div class="legend">' +
      swatch('user', '用户原话') + swatch('inject', '上下文注入') + swatch('checkpoint', '折叠摘要（模型只看到这个）') +
      swatch('think', '思考') + swatch('call', '工具调用') + swatch('result', '工具结果') +
      swatch('reply', '回复') + swatch('pin', '重要消息') +
    '</div>',
  )
  parts.push('<p class="hint">每一轮默认收起，只露用户与回复；展开能看到本轮全部内容。折叠过的轮次里，灰色的「折叠摘要」是模型实际看到的全部内容，其它色块是报告替你把原文摊开（模型看不到）。系统提示词按出现时间单独成块，后一版在「模型视角」页里默认只显示与上一版的差异。</p>')
  if (turnGroups.length === 0) {
    parts.push('<p class="empty">没有可展示的消息。</p>')
  } else {
    for (const group of turnGroups) {
      parts.push(group && group.kind === 'system' ? systemGroupHtml(group) : turnGroupHtml(group))
    }
  }
  parts.push('</section>')

  const notes = [
    '折叠后字符 = 模型视角里全部消息的字符数（含用户原话、检查点与重要消息）。',
    '逐轮历史以模型视角为准：灰底的折叠摘要就是模型看到的全部内容，同一轮下面的其它色块是报告按 fold-store 原文摊开的，模型看不到。',
    '轮次号优先取 fold 记录里的 turn（会话自己的轮次计数）；插件生效前或未折叠的轮次按相邻轮次推断，推不出来时写「第 N 段」。同一轮里用户又插话（steering）时，后一段标「轮内续接」。系统提示词与用户原话从不参与折叠。',
    '正文不裁剪：思考、工具调用、工具结果默认折叠成滚动框，勾选「展开长文本」可以一次看全。',
    'token 估算与账本、宿主上下文面板同一口径：每个文本块 ceil(字符数 / 4) + 4，工具调用的名字与参数各算一块，每条消息再加 4。它不含系统提示词与工具定义，所以比「上下文」页的总量小。',
    '召回次数来自 fold-store 的 recall 记录；固化状态先看 pin 记录有没有带 foldId，没有则把「召回之后发布的 pin」归给最近被召回的那一段（推测）。',
    '时间线按 fold / recall / pin 记录的 at 排序；缺 at 的记录排在最后。',
  ]
  parts.push('<section>')
  parts.push('<h2>口径与告警</h2>')
  parts.push('<ul class="notes">' + notes.map((line) => '<li>' + esc(line) + '</li>').join('') + '</ul>')
  if (warns.length > 0) {
    parts.push('<ul class="warns">' + warns.map((line) => '<li>' + esc(line) + '</li>').join('') + '</ul>')
  }
  parts.push('</section>')

  parts.push('</main>')
  parts.push('<script>')
  parts.push(SCRIPT)
  parts.push('</script>')
  parts.push('</body>')
  parts.push('</html>')
  return parts.join('\n')
}

// 工具返回值用的纯文本摘要：先写总量，再写按轮与折叠段，最后给口径提示，整体不超过字数上限。
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

// 报告落在 <home>/fold-debug/<safe>.html：同一会话重复生成覆盖同一份文件，不累积垃圾。
export function writeReport(homeDir, { sessionId, html } = {}) {
  const base = resolve(String(homeDir || '.'))
  const dir = join(base, reportDirName)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, safeFileName(sessionId) + '.html')
  writeFileSync(filePath, typeof html === 'string' ? html : '', 'utf8')
  return filePath
}

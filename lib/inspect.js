// 折叠可视化：把「模型真正看到的历史」与「不折叠时的历史」摊开成同一份报告模型。
//
// 两个视角都从同一处出发——会话的派生消息（session.deriveMessages()）：
//   · 模型视角：派生消息就是模型拿到的东西，一条检查点只是一条短消息；
//   · 不折叠视角：把带 foldId 的检查点按 fold-store 里的 items 原文展开，检查点本身消失。
// 后者不是日志重放，所以原文载荷缺失时只能退回摘要并记一条告警。
//
// 全部是纯函数，不 import 宿主包；token 按与宿主上下文面板一致的
// 经验公式估算（4 字符/token，按内容块 +4），不追求分词器级精确。

import { sourceCheckpoint, sourcePin } from './constants.js'
import { pinLevelOfText } from './pins.js'
import { blocksOfFoldItem, blocksOfMessage, buildTurnGroups, entryKindOf, recallCallsOfBlocks } from './turns.js'
import { foldParts, matchFoldPartNumbers, normalizePartSelectors, normalizeQuery, selectFoldParts } from './recall.js'
import { CHARS_PER_TOKEN, estimateChars, estimateMessageTokens } from './tokens.js'

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

export function sourceLabel(kind, foldId, level) {
  if (kind === sourceCheckpoint) return foldId ? '折叠检查点 ' + foldId : '折叠检查点'
  // 模型视角要一眼看出这条是会过期的近期结论，还是长期断言。
  if (kind === sourcePin) return level === 'recent' ? '近期重要（可能过时）' : '重要消息（永不折叠）'
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
    // 级别只对 pin 有意义：近期重要会过期，长期重要不会，页面据此分色。
    const pinLevel = isPin ? pinLevelOfText(text) : ''
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
      sourceLabel: sourceLabel(kind, foldId, pinLevel),
      foldId,
      isCheckpoint,
      isPin,
      pinLevel,
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
    const pinLevel = kind === sourcePin ? pinLevelOfText(text) : ''

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
          pinLevel: '',
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
          pinLevel: '',
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
      sourceLabel: sourceLabel(kind, foldId, pinLevel),
      foldId: foldId || '',
      isCheckpoint: false,
      isPin: kind === sourcePin,
      pinLevel,
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

// 每条折叠加起来被召回了几次：key 是折叠编号，值是召回流水里带该编号的记录数。
// 检索记录没有编号（id 为空），不参与；目录/分段/整段召回都算一次「被取回过」。
export function recallTimesById(recalls) {
  const counts = new Map()
  for (const record of Array.isArray(recalls) ? recalls : []) {
    if (!record || (record.kind && record.kind !== 'recall')) continue
    const id = String(record.id || '')
    if (!id) continue
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  return counts
}

// 段级召回标记：标到具体的段上，并记下这次调用落在哪里（页面据此在调用与被调用两端互相跳）。
// 段号与 fold_recall 的目录同一套规则（含长回复按标题切段），所以标上去的就是目录里的段号。
// 两个来源各有各的用处：
//   · 工具结果（call.resultText）说明模型实际收到了哪几段——整段召回、目录、失败都写在这里；
//   · 调用参数（parts / query）说明模型选了哪几段——被召回次数与引用表按它记，
//     否则一次整段召回就会把上百段全标成「被召回」，标签会失去指向。
function attachPartRecalls({ entries, groups, folds, config }) {
  const foldMap = folds instanceof Map ? folds : foldMapOf(folds)
  const recallTokens = config && typeof config.maxRecallTokens === 'number' && config.maxRecallTokens > 0 ? config.maxRecallTokens : 1000
  const replySplitChars = recallTokens * CHARS_PER_TOKEN
  const partsById = new Map()
  const list = Array.isArray(entries) ? entries : []
  const groupList = Array.isArray(groups) ? groups : []

  function partsOf(id) {
    if (partsById.has(id)) return partsById.get(id)
    const record = foldMap.get(id)
    const parts = record ? foldParts(record, { replySplitChars }) : []
    partsById.set(id, parts)
    return parts
  }

  // 折叠原文里的调用落在「第几段」：段号按召回目录的规则算（含长回复按标题切段）。
  // 引用跳转因此能落到那一段，而不是只打开检查点。
  const partNoById = new Map()
  function partNoAt(id, itemIndex, blockIndex) {
    if (!id) return 0
    let map = partNoById.get(id)
    if (!map) {
      map = new Map()
      for (const part of partsOf(id)) {
        if (typeof part.itemIndex !== 'number' || typeof part.blockIndex !== 'number') continue
        map.set(part.itemIndex + ':' + part.blockIndex, part.no)
      }
      partNoById.set(id, map)
    }
    return map.get(itemIndex + ':' + blockIndex) || 0
  }

  // 老数据没有块归属：调用一定在某个 call 块里，取第一个就是它。
  function callBlockIndexOf(blocks) {
    const list = Array.isArray(blocks) ? blocks : []
    for (let i = 0; i < list.length; i += 1) if (list[i] && list[i].kind === 'call') return i
    return 0
  }

  // 每个条目在页面上的落点：轮序号（o）、条目序号（i）、轮号（t）。跳转只认这三个数。
  const locOf = new Map()
  for (const group of groupList) {
    if (!group) continue
    const o = typeof group.ordinal === 'number' ? group.ordinal : -1
    const t = typeof group.turn === 'number' ? group.turn : o
    for (const entry of Array.isArray(group.entries) ? group.entries : []) {
      if (!entry) continue
      locOf.set(entry, { o, i: typeof entry.index === 'number' ? entry.index : 0, t })
    }
  }
  // 检查点按折叠编号索引：一次调用的落点就是它召回的那条折叠的检查点。
  const checkpointOf = new Map()
  for (const entry of list) {
    if (entry && entry.isCheckpoint === true && entry.foldId) checkpointOf.set(entry.foldId, entry)
  }

  // 工具结果通常是一条独立的工具消息，紧跟在调用消息后面：按组顺序配对，不依赖块的先后。
  for (const group of groupList) {
    if (!group) continue
    let pending = []
    for (const entry of Array.isArray(group.entries) ? group.entries : []) {
      if (!entry) continue
      const calls = Array.isArray(entry.recallCalls) ? entry.recallCalls : []
      if (calls.length > 0) pending = calls
      if (pending.length === 0 || entryKindOf(entry) !== 'result') continue
      const text = entryTextOf(entry)
      if (!text) continue
      for (const call of pending) if (!call.resultText) call.resultText = text
      pending = []
    }
  }
  // 折叠原文里的调用：工具结果是紧跟在后面的一个工具结果条目（同一段里相邻的也算），
  // 所以按条目顺序配对，与召回时的消息顺序一致。
  for (const entry of list) {
    const record = entry && entry.foldRecord
    if (!record || !Array.isArray(record.items)) continue
    let pending = []
    for (const item of record.items) {
      const calls = item && Array.isArray(item.recallCalls) ? item.recallCalls : []
      // 同一段里调用与结果相邻时，块内配对先拿到结果。
      const texts = resultTextsOfBlocks(item.blocks)
      for (let i = 0; i < calls.length; i += 1) if (!calls[i].resultText && texts[i]) calls[i].resultText = texts[i]
      if (calls.length > 0) pending = calls.filter((call) => !call.resultText)
      if (pending.length === 0) continue
      if (itemKindOf(item) !== 'result') continue
      const text = blocksTextOf(item.blocks)
      if (!text) continue
      for (const call of pending) call.resultText = text
      pending = []
    }
  }

  // 历史里的调用有两处：活着的条目，和折叠原文里的条目（已被折掉的调用）。
  const calls = []
  for (const entry of list) {
    if (!entry) continue
    const loc = locOf.get(entry) || { o: -1, i: typeof entry.index === 'number' ? entry.index : 0, t: 0 }
    for (const call of Array.isArray(entry.recallCalls) ? entry.recallCalls : []) calls.push({ call, entry, loc })
    const record = entry.foldRecord
    if (!record || !Array.isArray(record.items)) continue
    const foldId = String(entry.foldId || record.id || '')
    for (let itemIndex = 0; itemIndex < record.items.length; itemIndex += 1) {
      const item = record.items[itemIndex]
      const itemCalls = Array.isArray(item && item.recallCalls) ? item.recallCalls : []
      const owners = Array.isArray(item && item.recallCallBlocks) ? item.recallCallBlocks : []
      for (let k = 0; k < itemCalls.length; k += 1) {
        const call = itemCalls[k]
        const blockIndex = owners.length === itemCalls.length ? owners[k] : callBlockIndexOf(item && item.blocks)
        const partNo = partNoAt(foldId, itemIndex, blockIndex)
        if (partNo > 0) call.partNo = partNo
        calls.push({ call, entry, loc })
      }
    }
  }

  // 一次检索命中的折叠：段级记进 searchedParts（段号 -> 哪次检索碰到了它），折叠级记进
  // searchedRefs（哪次检索用到了这张分段目录、命中多少段）。命中但页面上没有这条折叠的检查点时
  // 只留 searchHits：跳转落点为空，页面就不做成可点，而不是跳到别处。
  function collectSearchHits(call, outcome, loc) {
    const hits = Array.isArray(outcome && outcome.hits) ? outcome.hits : []
    if (hits.length === 0) return
    const rows = []
    const query = String(call && typeof call.query === 'string' ? call.query : '').slice(0, 60)
    let listed = 0
    let matched = 0
    for (const hit of hits) {
      const numbers = hit.numbers.slice(0, 60)
      const target = checkpointOf.get(hit.id)
      const targetLoc = target ? locOf.get(target) : null
      listed += numbers.length
      matched += hit.count
      rows.push({
        id: hit.id,
        turn: hit.turn,
        count: hit.count,
        totalParts: hit.totalParts,
        numbers,
        ...(hit.unlisted > 0 ? { unlisted: hit.unlisted } : {}),
        ...(targetLoc ? { loc: { o: targetLoc.o, i: targetLoc.i } } : {}),
      })
      if (!targetLoc) continue
      let table = searchedByCheckpoint.get(target)
      if (!table) {
        table = new Map()
        searchedByCheckpoint.set(target, table)
      }
      for (const no of numbers) {
        let refs = table.get(no)
        if (!refs) {
          refs = []
          table.set(no, refs)
        }
        if (refs.length < 8) {
          refs.push({
            o: loc.o,
            i: loc.i,
            t: loc.t,
            query,
            // part 是这次检索在它所在折叠原文里的段号：反查要落到那一段上。
            ...(call.partNo > 0 ? { part: call.partNo } : {}),
          })
        }
      }
      let foldRefs = searchedRefsByCheckpoint.get(target)
      if (!foldRefs) {
        foldRefs = new Map()
        searchedRefsByCheckpoint.set(target, foldRefs)
      }
      const key = loc.o + ':' + loc.i
      if (!foldRefs.has(key)) {
        foldRefs.set(key, {
          o: loc.o,
          i: loc.i,
          t: loc.t,
          query,
          count: hit.count,
          totalParts: hit.totalParts,
          numbers: numbers.slice(0, 8),
          ...(call.partNo > 0 ? { part: call.partNo } : {}),
        })
      }
    }
    call.searchHits = rows
    call.searchFoldCount = rows.length
    call.searchPartCount = matched
    call.searchListedCount = listed
    if (outcome.moreFolds) call.searchMoreFolds = outcome.moreFolds
  }

  function touchedOf(call) {
    const id = call && typeof call.id === 'string' ? call.id.trim() : ''
    if (!id) return null
    // 只给编号的整段召回不标段：先判选择器，别为一个不产生标记的调用去切几十万字。
    const selectors = normalizePartSelectors(call && call.parts)
    const tokens = normalizeQuery(call && typeof call.query === 'string' ? call.query : '')
    if (!selectors && tokens.length === 0) return null
    const parts = partsOf(id)
    if (parts.length === 0) return null
    let numbers
    if (selectors) {
      numbers = selectFoldParts(parts, selectors).picked.map((part) => part.no)
    } else {
      numbers = matchFoldPartNumbers(foldMap.get(id), tokens, { replySplitChars })
    }
    // 编号 + 关键词：先按关键词筛段，再按 parts 选，两步都成立才算取到。
    if (selectors && tokens.length > 0) {
      const allowed = new Set(matchFoldPartNumbers(foldMap.get(id), tokens, { replySplitChars }))
      numbers = numbers.filter((no) => allowed.has(no))
    }
    return { id, numbers }
  }

  function setSegments(call, numbers, from) {
    const unique = [...new Set(numbers.filter((no) => Number.isInteger(no) && no > 0))].sort((a, b) => a - b)
    if (unique.length === 0) return false
    // 一段折叠最多上千段：只带前 60 个段号，超出的用 segmentCount 报总数。
    call.segments = unique.slice(0, 60)
    call.segmentCount = unique.length
    call.segmentsFrom = from
    return true
  }

  const countsById = new Map()
  const refsByCheckpoint = new Map()
  // 检索是另一件事：它只是「按关键词找到了这些段和那张目录」，没有返回原文。
  // 所以单独一张表，段次不并进被召回，否则页面上的「取回 N 段次」会虚高。
  const searchedByCheckpoint = new Map()
  const searchedRefsByCheckpoint = new Map()
  for (const row of calls) {
    const call = row.call
    if (!call) continue
    const loc = row.loc
    call.loc = { o: loc.o, i: loc.i }
    const id = typeof call.id === 'string' ? call.id.trim() : ''
    const checkpoint = id ? checkpointOf.get(id) : null
    const checkpointLoc = checkpoint ? locOf.get(checkpoint) : null
    if (checkpointLoc) call.foldLoc = { o: checkpointLoc.o, i: checkpointLoc.i }

    // 1) 工具结果给出实际取回的段号：整段召回就是这条折叠的全部段。
    const outcome = parseRecallOutcome(call.resultText, id)
    if (outcome) {
      call.outcome = outcome.kind
      if (outcome.note) call.note = outcome.note
      if (typeof outcome.total === 'number' && outcome.total > 0) call.totalParts = outcome.total
      const numbers = outcome.kind === 'direct' ? partsOf(id).map((part) => part.no) : outcome.numbers
      setSegments(call, numbers || [], 'result')
      if (outcome.kind === 'search') collectSearchHits(call, outcome, loc)
    }
    // 2) 参数给出模型选了哪几段：段级标记、被召回次数与引用表都按它记。
    const touched = touchedOf(call)
    if (!touched || touched.numbers.length === 0) continue
    if (!call.segments) setSegments(call, touched.numbers, 'args')
    let table = countsById.get(touched.id)
    if (!table) {
      table = new Map()
      countsById.set(touched.id, table)
    }
    for (const no of touched.numbers) table.set(no, (table.get(no) || 0) + 1)
    // 引用：哪一次调用取回了这一段。挂在检查点上，页面据此从段反过来跳到调用点。
    if (checkpoint) {
      let refs = refsByCheckpoint.get(checkpoint)
      if (!refs) {
        refs = new Map()
        refsByCheckpoint.set(checkpoint, refs)
      }
      for (const no of touched.numbers) {
        let rows = refs.get(no)
        if (!rows) {
          rows = []
          refs.set(no, rows)
        }
        // part 是这次调用在它所在折叠原文里的段号：引用跳转要落到那一段上。
        rows.push({
          o: loc.o,
          i: loc.i,
          t: loc.t,
          id: touched.id,
          ...(call.partNo > 0 ? { part: call.partNo } : {}),
        })
      }
    }
  }
  for (const [checkpoint, refs] of refsByCheckpoint) {
    const table = {}
    for (const [no, rows] of refs) table[no] = rows
    checkpoint.partRefs = table
  }
  // 检索命中的段与目录：挂在被检索的那条折叠的检查点上，页面从目录/段反过来找是哪次检索。
  for (const [checkpoint, table] of searchedByCheckpoint) {
    const parts = {}
    let count = 0
    for (const [no, refs] of table) {
      if (refs.length === 0) continue
      parts[no] = refs
      count += refs.length
    }
    if (count === 0) continue
    checkpoint.searchedParts = parts
    checkpoint.searchedPartCount = count
  }
  for (const [checkpoint, refs] of searchedRefsByCheckpoint) {
    const rows = [...refs.values()]
    if (rows.length === 0) continue
    checkpoint.searchedRefs = rows
    checkpoint.searchedCount = rows.length
  }
  if (countsById.size === 0 && searchedByCheckpoint.size === 0) return

  // 挂到检查点上，再把每个分组的段次加起来：父级标签永远等于子项之和。
  for (const group of groupList) {
    if (!group) continue
    let groupTotal = 0
    let groupSearched = 0
    let groupSearchedParts = 0
    // 一次检索可能同时命中这一轮里的两条折叠：轮次标签按调用去重，否则「被检索 2 次」会被读成两次检索。
    const groupSearchedKeys = new Set()
    for (const entry of Array.isArray(group.entries) ? group.entries : []) {
      if (!entry || entry.isCheckpoint !== true || !entry.foldId) continue
      const table = countsById.get(entry.foldId)
      if (table && table.size > 0) {
        const recalledParts = {}
        let count = 0
        for (const [no, times] of table) {
          recalledParts[no] = times
          count += times
        }
        entry.recalledParts = recalledParts
        entry.recalledPartCount = count
        groupTotal += count
      }
      if (typeof entry.searchedPartCount === 'number' && entry.searchedPartCount > 0) {
        groupSearchedParts += entry.searchedPartCount
        for (const ref of Array.isArray(entry.searchedRefs) ? entry.searchedRefs : []) {
          groupSearchedKeys.add(ref.o + ':' + ref.i + ':' + (ref.part || 0))
        }
      }
    }
    groupSearched = groupSearchedKeys.size;
    group.recalledPartCount = groupTotal
    group.searchedPartCount = groupSearchedParts
    group.searchedCount = groupSearched
  }
}

// 一条消息的纯文本：块与块之间用换行拼，工具结果的三种形态都按行首识别。
function blocksTextOf(blocks) {
  let out = ''
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const text = block && typeof block.text === 'string' ? block.text : ''
    if (!text) continue
    out += (out ? '\n' : '') + text
  }
  return out
}

function entryTextOf(entry) {
  return blocksTextOf(entry && Array.isArray(entry.blocks) ? entry.blocks : [])
}

// 折叠原文的段以段首块定身份：[工具结果] 段就是那一次调用的返回。
function itemKindOf(item) {
  const blocks = item && Array.isArray(item.blocks) ? item.blocks : []
  const head = blocks.length > 0 ? blocks[0] : null
  return head && typeof head.kind === 'string' ? head.kind : 'text'
}

// 结果块紧跟在调用块后面：把结果文本配给前面还没配过的调用。
// 与 recallCallsOfBlocks 同序，因此能按调用出现的位置一一对上。
function resultTextsOfBlocks(blocks) {
  const texts = []
  let pending = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block) continue
    if (block.kind === 'call') {
      const found = recallCallsOfBlocks([block])
      pending = found
      for (let i = 0; i < found.length; i += 1) texts.push('')
      continue
    }
    if (block.kind !== 'result') continue
    const text = typeof block.text === 'string' ? block.text : ''
    if (!text || pending.length === 0) continue
    const base = texts.length - pending.length
    for (let i = 0; i < pending.length; i += 1) if (!texts[base + i]) texts[base + i] = text
    pending = []
  }
  return texts
}

const PARTS_ANSWER_HEAD = /^折叠 \S+（第 \d+ 轮）取回 \d+\/\d+ 段：/m
const DIRECT_ANSWER_HEAD = /^折叠 \S+（第 \d+ 轮，原文约 /m
const SEARCH_ANSWER_HEAD = /^检索「/m

// 工具结果的形状就是 recall.js 里那几种：分段（--- #N 类型 ---）、整段（--- #seq ---）、
// 目录（#N [类型] ... 行）。结果可能裹在脚本的其它输出里，所以从「折叠 <id>」那一行开始认，
// 别把无关的第一行当成失败原因。
const ERROR_HINTS = /没有匹配的段|没有编号为|载荷已因存储上限|里没有命中|没有回复段|缺少 id 或 query/

function errorNoteOf(value) {
  const lines = String(value === null || value === undefined ? '' : value).split('\n')
  for (const line of lines) {
    const text = line.trim()
    if (text && ERROR_HINTS.test(text)) return text.slice(0, 120)
  }
  for (const line of lines) {
    const text = line.trim()
    if (text) return text.slice(0, 120)
  }
  return ''
}

const SEARCH_FOLD_LINE = /^-\s+(\S+)（第\s*(\d+)\s*轮）命中\s*(\d+)\/(\d+)\s*段/
const SEARCH_PART_LINE = /^\s+#(\d+)\s+\[/
const SEARCH_MORE_LINE = /^\s*…还有\s*(\d+)\s*段命中/
const SEARCH_MORE_FOLDS = /（还有\s*(\d+)\s*条更早的折叠命中/

// 检索结果按折叠分组：每条折叠一行头（命中 n/m 段），下面列出命中的段（最多 maxParts 段），
// 没列出来的只有数量。段号与召回目录同一套，所以检索命中的段就能引到那张目录上。
function parseSearchHits(text) {
  const value = typeof text === 'string' ? text : ''
  const at = value.indexOf('检索「')
  if (at < 0) return null
  const hits = []
  let current = null
  for (const line of value.slice(at).split('\n')) {
    const head = SEARCH_FOLD_LINE.exec(line)
    if (head) {
      current = {
        id: head[1],
        turn: Number(head[2]) || 0,
        count: Number(head[3]) || 0,
        totalParts: Number(head[4]) || 0,
        numbers: [],
        unlisted: 0,
      }
      hits.push(current)
      continue
    }
    if (!current) continue
    const part = SEARCH_PART_LINE.exec(line)
    if (part) {
      const no = Number(part[1])
      if (Number.isInteger(no) && no > 0) current.numbers.push(no)
      continue
    }
    const more = SEARCH_MORE_LINE.exec(line)
    if (more) current.unlisted = Number(more[1]) || 0
  }
  if (hits.length === 0) return null
  const extra = SEARCH_MORE_FOLDS.exec(value)
  return { hits, moreFolds: extra ? Number(extra[1]) || 0 : 0 }
}

function searchOutcomeOf(value) {
  const parsed = parseSearchHits(value)
  if (!parsed) return { kind: 'search', numbers: [] }
  return { kind: 'search', numbers: [], hits: parsed.hits, moreFolds: parsed.moreFolds }
}

function parseRecallOutcome(text, id) {
  const value = typeof text === 'string' ? text : ''
  if (!value) return null
  let body = value
  if (id) {
    const at = value.indexOf('折叠 ' + id)
    if (at >= 0) body = value.slice(at)
  }
  if (!id && value.indexOf('检索「') >= 0) return searchOutcomeOf(value)
  if (SEARCH_ANSWER_HEAD.test(body)) return searchOutcomeOf(value)
  if (PARTS_ANSWER_HEAD.test(body)) {
    const numbers = []
    const pattern = /^--- #(\d+) .* ---$/gm
    let match
    while ((match = pattern.exec(body))) numbers.push(Number(match[1]))
    return { kind: 'parts', numbers }
  }
  if (body.indexOf('原文较长，先给目录') >= 0) {
    const numbers = []
    const pattern = /^#(\d+) \[/gm
    let match
    while ((match = pattern.exec(body))) numbers.push(Number(match[1]))
    // 目录本身可能被截断：页面上写「目录 29/207 段」才不会被读成这条折叠只有 29 段。
    const totalMatch = /共 (\d+) 段/.exec(body)
    const omittedMatch = /还有 (\d+) 段没列出来/.exec(body)
    const out = { kind: 'index', numbers }
    if (totalMatch) out.total = Number(totalMatch[1])
    if (omittedMatch) out.note = '目录被截断，还有 ' + omittedMatch[1] + ' 段没列出来'
    return out
  }
  if (DIRECT_ANSWER_HEAD.test(body)) return { kind: 'direct', numbers: [] }
  return { kind: 'error', numbers: [], note: errorNoteOf(body) }
}

// 召回次数与固化状态来自 fold-store：召回记录带 id 与 at，pin 记录带 label、正文与 at。
// 固化判定：pin 显式带 foldId 时直接认；否则把「召回之后发布的 pin」归给最近被召回的那段（推测）。
function annotateStats({ unfolded, folds, pins, recalls }) {
  const list = Array.isArray(recalls) ? recalls : []
  const counts = recallTimesById(list)
  const lastRecall = new Map()
  let recallTotal = 0
  for (const record of list) {
    if (!record || (record.kind && record.kind !== 'recall')) continue
    const id = String(record.id || '')
    if (!id) continue
    recallTotal += 1
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

// 从 store 读四样记录：折叠地图、pin 快照、召回流水（recall 需要时间戳，所以走 readAll），
// 以及每轮的实测用量（usage 与折叠无关，关掉折叠后账本靠它显示真实账单）。
export function collectRecords(store) {
  const folds = store && typeof store.folds === 'function' ? store.folds() : new Map()
  const pins = store && typeof store.pins === 'function' ? store.pins() : []
  const all = store && typeof store.readAll === 'function' ? store.readAll() : []
  const recalls = []
  const usages = []
  for (const record of all) {
    if (!record) continue
    if (record.kind === 'recall') recalls.push(record)
    else if (record.kind === 'usage') usages.push(record)
  }
  return { folds, pins, recalls, usages }
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
    const pinLevel = isPin ? pinLevelOfText(text) : ''
    const record = isCheckpoint && foldId ? foldMap.get(foldId) : null
    const entry = {
      index: i + 1,
      seq: seqOf(raw, message),
      role,
      roleLabel: roleLabel(role),
      sourceKind,
      sourceLabel: sourceLabel(sourceKind, foldId, pinLevel),
      foldId,
      isCheckpoint,
      isPin,
      pinLevel,
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
        // 检查点里回复是否被截断：段号规则（是否跳过长回复）要靠它，客户端才能和召回对齐。
        replyTruncated: record.replyTruncated !== false,
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

// 旧版系统提示留在 surface 里，但 dsh-context 与 provider 实际请求都只把最后一条当生效提示；
// 把它们算进「模型视角」总量会让多版本提示词的会话偏高一倍，所以统计前先扣掉。
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
  // 召回次数按折叠编号先算成表：分组时把它挂到每个检查点上，再汇总到轮次标签。
  const turnGroups = buildTurnGroups({ entries, recallCounts: recallTimesById(recallList) })
  // 段级标记要等全部条目走完：召回调用可能出现在被召回折叠的后面几轮里。
  attachPartRecalls({ entries, groups: turnGroups, folds: foldMap, config })

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
  // 总开关关闭时「没折过」是预期状态（页面顶部已有「压缩已关闭」），不再当警告占行；
  // 「配置里 enabled 为 false」也由页顶说明，同样不重复。
  const disabled = Boolean(config && config.enabled === false)
  if (!disabled && folded.totals.checkpoints === 0) warns.push('模型视角里没有折叠检查点：这个会话还没折过，或历史来自插件装上之前。')
  if (!disabled && foldMap.size === 0) warns.push('fold-store 里没有折叠记录：召回、固化与时间线都无从统计。')

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


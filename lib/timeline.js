// 上下文时间线：按会话事件重放 surface，算出每一步请求的上下文构成。
//
// 与 dsh-context 浏览器的口径一致：
// - 分类：assistant/message → 助手；tool/result → 工具结果；developer/message → 注入；
//   skill-invocation / skill-catalog → 注入；折叠检查点 → 折叠摘要；重要消息 → 重要消息；
//   其它 user/message 按 source.kind 分：kind 为空 / "user" / "schedule" 才算用户原话。
// - 计价：文本/思考 ceil(len/4)+4；工具调用名字与参数各一段；每条消息再加 4；
//   系统提示整段一次 ceil+4，只算最后一条（旧版留在 surface 里，单列参考、不计入）。
// - 工具定义取自最近一次 request/header，按每个工具 JSON 估一次。
//
// 时间线按「轮」记录一个点，并在系统提示、折叠、压缩事件处补一个点：
//   折叠后的视角：检查点替换原文（体积变小）；
//   不折叠视角：检查点换回原文（读 fold-store 的载荷），但压缩引擎切掉的内容不会回来。
// 这样有压缩的会话在趋势里能看到掉下去的台阶，未折叠视角也一样；折叠点只在折叠线掉台阶。

import { blocksOfFoldItem } from './turns.js'

const CATEGORIES = [
  { key: 'system', label: '系统提示' },
  // 只把最后一条非空 system/message 当当前提示词；更早的版本留在 surface 里但不计入请求预测。
  { key: 'systemHistory', label: '旧版系统提示（不计入）', reference: true },
  { key: 'toolDefs', label: '工具定义' },
  { key: 'user', label: '用户原话' },
  { key: 'assistant', label: '思考与回复' },
  { key: 'tools', label: '工具调用与结果' },
  { key: 'inject', label: '上下文注入' },
  { key: 'checkpoint', label: '折叠摘要' },
  { key: 'pin', label: '重要消息' },
]
const KEYS = CATEGORIES.map((item) => item.key)
const REFERENCE_KEYS = new Set(CATEGORIES.filter((item) => item.reference === true).map((item) => item.key))
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

function blank() {
  const bucket = {}
  for (const key of KEYS) bucket[key] = 0
  return bucket
}
function add(bucket, key, value) {
  if (!bucket || KEYS.indexOf(key) < 0) return
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (number > 0) bucket[key] += number
}
function mergeInto(target, source, sign) {
  for (const key of KEYS) target[key] += (source[key] || 0) * sign
}
function textTokens(text) {
  const value = typeof text === 'string' ? text : ''
  return value.length > 0 ? Math.ceil(value.length / 4) + 4 : 0
}
function contentTokens(content) {
  let total = 0
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'reasoning') total += textTokens(block.text)
    else if (block.type === 'tool-call') total += Math.ceil((block.name || '').length / 4) + Math.ceil((block.arguments || '').length / 4) + 4
    else total += Math.ceil(JSON.stringify(block).length / 4) + 4
  }
  return total
}
function messageTokens(message) {
  if (!message || !Array.isArray(message.content) || message.content.length === 0) return 0
  return contentTokens(message.content) + 4
}
function systemMessageTokens(message) {
  if (!message || !Array.isArray(message.content) || message.content.length === 0) return 0
  let chars = 0
  for (const block of message.content) chars += block.type === 'text' ? block.text.length : JSON.stringify(block).length
  return Math.ceil(chars / 4) + 4
}
// 折叠载荷里的一段：kind 形状的内容块（think/reply/call/result/inject），不是原始 content。
function foldBlockTokens(block) {
  if (!block || typeof block !== 'object') return 0
  const text = typeof block.text === 'string' ? block.text : ''
  if (block.kind === 'call') {
    return Math.ceil((block.name || '').length / 4) + Math.ceil(text.length / 4) + 4
  }
  return text.length > 0 ? Math.ceil(text.length / 4) + 4 : 0
}
function categoryOfBlock(block) {
  if (!block) return 'inject'
  if (block.kind === 'think' || block.kind === 'reply') return 'assistant'
  if (block.kind === 'call' || block.kind === 'result') return 'tools'
  return 'inject'
}
// 折叠原文里的一段可能同时含思考、回复与调用：按块占比拆到对应类别，再加一次角色开销。
function priceFoldItem(item) {
  const value = item && typeof item.text === 'string' ? item.text : ''
  const blocks = blocksOfFoldItem(value)
  const bucket = blank()
  const parts = []
  let counted = 0
  for (const block of blocks) {
    const tokens = foldBlockTokens(block)
    if (tokens <= 0) continue
    parts.push({ category: categoryOfBlock(block), tokens })
    counted += tokens
  }
  if (counted <= 0) {
    const chars = item && typeof item.chars === 'number' ? item.chars : value.length
    add(bucket, 'inject', Math.ceil(chars / 4) + 4)
    return bucket
  }
  const total = counted + 4
  for (const part of parts) add(bucket, part.category, (part.tokens / counted) * total)
  return bucket
}
function categoryOfMessage(event, message) {
  if (event.type === 'assistant/message') return 'assistant'
  if (event.type === 'tool/result') return 'tools'
  if (event.type === 'developer/message') return 'inject'
  const source = message && message.source
  const kind = source && typeof source.kind === 'string' ? source.kind : ''
  if (kind === 'fold-checkpoint') return 'checkpoint'
  if (kind === 'fold-pin') return 'pin'
  if (kind === 'skill-invocation' || kind === 'skill-catalog') return 'inject'
  if (kind !== '' && kind !== 'user' && kind !== 'schedule') return 'inject'
  return 'user'
}
function priceMessage(event) {
  const message = messageOf(event)
  const bucket = blank()
  if (!message) return bucket
  add(bucket, categoryOfMessage(event, message), messageTokens(message))
  return bucket
}
function messageOf(event) {
  if (!event) return null
  if (event.type === 'user/message') return event.data
  return event.data && event.data.message
}
function toolsTokensOf(header) {
  if (!header || !Array.isArray(header.tools) || header.tools.length === 0) return 0
  return header.tools.reduce((sum, tool) => sum + (Math.ceil(JSON.stringify(tool).length / 4) + 4), 0)
}
function labelOf(turn, kind, index) {
  if (kind === 'compact') return 'C' + index
  if (kind === 'prune') return 'P' + index
  if (kind === 'fold') return 'F' + index
  if (kind === 'system') return 'S' + index
  return 'T' + turn
}

// 返回 points（每轮一个点 + 系统/压缩/折叠点）与当前总量。
export function buildTimeline({ events, folds } = {}) {
  const list = Array.isArray(events) ? events : []
  const foldMap = folds instanceof Map ? folds : new Map()
  const points = []
  let nodes = []
  let toolsTokens = 0
  let lastTurn = 0
  let compactIndex = 0
  let foldIndex = 0
  let systemIndex = 0
  // 系统提示是请求信封的一部分：surface 节点可能被压缩整段卷走，但请求仍会带它，
  // 所以记住最后一次见到的非空系统提示，而不是只从当前 surface 里找。
  let systemCurrent = 0

  function currentTotals() {
    const folded = blank()
    const unfolded = blank()
    for (const node of nodes) {
      if (node.system) continue
      mergeInto(folded, node.folded, 1)
      mergeInto(unfolded, node.unfolded, 1)
    }
    folded.system = systemCurrent
    unfolded.system = systemCurrent
    folded.toolDefs = toolsTokens
    unfolded.toolDefs = toolsTokens
    return { folded, unfolded }
  }
  function pushPoint(turn, kind) {
    const current = currentTotals()
    const previous = points.length > 0 ? points[points.length - 1].totals : { folded: blank(), unfolded: blank() }
    const delta = { folded: blank(), unfolded: blank() }
    for (const key of KEYS) {
      delta.folded[key] = Math.max(0, (current.folded[key] || 0) - (previous.folded[key] || 0))
      delta.unfolded[key] = Math.max(0, (current.unfolded[key] || 0) - (previous.unfolded[key] || 0))
    }
    const index = kind === 'system' ? ++systemIndex : kind === 'compact' ? ++compactIndex : kind === 'fold' ? ++foldIndex : 0
    points.push({
      ordinal: points.length + 1,
      kind: kind === 'turn' ? 'turn' : kind === 'system' ? 'system' : 'event',
      turn: turn || null,
      label: labelOf(turn, kind, index),
      tokens: delta,
      totals: current,
      tokensTotals: { folded: sum(current.folded), unfolded: sum(current.unfolded) },
    })
  }
  function applySurface(event) {
    const message = messageOf(event)
    const isSystem = Boolean(message && message.role === 'system')
    const source = message && message.source
    let node
    if (isSystem) {
      const tokens = systemMessageTokens(message)
      if (tokens > 0) systemCurrent = tokens
      node = { seq: event.seq, system: true, tokens }
    } else {
      const folded = priceMessage(event)
      let unfolded = folded
      const foldId = source && typeof source.foldId === 'string' ? source.foldId : ''
      if (foldId && foldMap.has(foldId)) {
        const record = foldMap.get(foldId)
        const items = record && Array.isArray(record.items) ? record.items : []
        if (items.length > 0) {
          unfolded = blank()
          for (const item of items) mergeInto(unfolded, priceFoldItem(item), 1)
        }
      }
      node = { seq: event.seq, folded, unfolded }
    }
    const op = event.surfaceOp
    if (op && op.op === 'replace') {
      const start = nodes.findIndex((item) => item.seq === op.startSeq)
      const end = nodes.findIndex((item) => item.seq === op.endSeq)
      if (start >= 0 && end >= start) nodes.splice(start, end - start + 1)
      else nodes = []
    }
    nodes.push(node)
    if (isSystem) {
      pushPoint(lastTurn, 'system')
      return
    }
    const kind = source && (source.kind === 'fold-checkpoint' ? 'fold' : source.kind === 'compact-checkpoint' ? 'compact' : '')
    if (kind) pushPoint(lastTurn, kind)
  }

  for (const event of list) {
    if (!event) continue
    if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') {
      lastTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end' && event.data && typeof event.data.turn === 'number') {
      lastTurn = event.data.turn
      pushPoint(lastTurn, 'turn')
      continue
    }
    if (event.type === 'compaction/prune') continue
    if (event.type === 'request/header' && event.data && event.data.header) {
      toolsTokens = toolsTokensOf(event.data.header)
      continue
    }
    if (!SURFACE_TYPES.has(event.type)) continue
    applySurface(event)
  }
  pushPoint(lastTurn, 'turn')

  const last = points.length > 0 ? points[points.length - 1] : null
  const totalFolded = last ? Object.assign({}, last.totals.folded) : blank()
  const totalUnfolded = last ? Object.assign({}, last.totals.unfolded) : blank()
  return {
    categories: CATEGORIES,
    points: points.map((point) => ({
      ordinal: point.ordinal,
      kind: point.kind,
      turn: point.turn,
      label: point.label,
      tokens: point.tokens,
      totals: point.totals,
      tokensTotals: point.tokensTotals,
      // 图表按「当前点的总量」画堆叠面积；cumulativeTokens 就是该点的绝对值。
      cumulativeTokens: point.totals,
    })),
    totals: {
      tokens: {
        folded: totalFolded,
        unfolded: totalUnfolded,
        sum: { folded: sum(totalFolded), unfolded: sum(totalUnfolded) },
      },
    },
  }
}

function sum(bucket) {
  let total = 0
  for (const key of KEYS) {
    if (REFERENCE_KEYS.has(key)) continue
    total += bucket[key] || 0
  }
  return total
}

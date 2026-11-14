// 分级召回：原文短就整段返回，长就先给分段目录，再用 parts 多选取回。
//
// 为什么分级：一轮折叠的原文可能有几十万字（思考 + 工具输出），整段塞回去既贵又没必要。
// 目录只列段号、类型、字数与开头，模型先判断哪几段有用，再二级召回。
// 这里全是纯函数：不读会话、不落账；计数与存储由工具层负责。

import { blocksOfFoldItem } from './turns.js'

const KIND_LABELS = {
  think: '思考',
  reply: '回复',
  call: '调用',
  result: '工具结果',
  inject: '注入消息',
  developer: '开发者消息',
  text: '文本',
}

const TYPE_ALIASES = {
  think: ['think'],
  reasoning: ['think'],
  reply: ['reply', 'text'],
  text: ['text'],
  call: ['call'],
  tool: ['call', 'result'],
  tools: ['call', 'result'],
  result: ['result'],
  inject: ['inject'],
  '注入': ['inject'],
  developer: ['developer'],
  all: null,
}

function prefixOf(kind, name) {
  if (kind === 'think') return '[思考] '
  if (kind === 'reply') return '[回复] '
  if (kind === 'call') return '[调用 ' + (name || 'unknown') + '] '
  if (kind === 'result') return '[工具结果] '
  if (kind === 'inject') return '[注入消息] '
  if (kind === 'developer') return '[开发者消息] '
  return ''
}

function labelOf(kind, name) {
  const base = KIND_LABELS[kind] || '文本'
  return kind === 'call' ? base + ' ' + (name || 'unknown') : base
}

// 一段折叠载荷 = 一条节点，里面可能同时有思考、回复与工具调用；按行首前缀拆成可单独召回的段。
// 段号从 1 开始连续编号，跨节点也不重来——模型只需要记 #3 这种短编号。
export function foldParts(record) {
  const items = record && Array.isArray(record.items) ? record.items : []
  const parts = []
  for (const item of items) {
    const seq = item && typeof item.seq === 'number' ? item.seq : null
    const blocks = blocksOfFoldItem(item && typeof item.text === 'string' ? item.text : '')
    for (const block of blocks) {
      const kind = block.kind || 'text'
      const name = block.name || ''
      const body = typeof block.text === 'string' ? block.text : ''
      parts.push({
        no: parts.length + 1,
        seq,
        kind,
        name,
        label: labelOf(kind, name),
        text: prefixOf(kind, name) + body,
        chars: body.length,
      })
    }
  }
  return parts
}

function fmt(n) {
  const value = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function kindSummary(parts) {
  const stats = new Map()
  for (const part of parts) {
    const entry = stats.get(part.kind) || { count: 0, chars: 0 }
    entry.count += 1
    entry.chars += part.chars
    stats.set(part.kind, entry)
  }
  const lines = []
  const think = stats.get('think')
  if (think) lines.push('思考 ' + think.count + ' 段（' + fmt(think.chars) + ' 字）')
  const call = stats.get('call')
  if (call) lines.push('调用 ' + call.count + ' 次')
  const result = stats.get('result')
  if (result) lines.push('工具结果 ' + result.count + ' 段（' + fmt(result.chars) + ' 字）')
  const reply = stats.get('reply')
  if (reply) lines.push('回复 ' + reply.count + ' 段（' + fmt(reply.chars) + ' 字）')
  for (const [kind, entry] of stats) {
    if (kind === 'think' || kind === 'call' || kind === 'result' || kind === 'reply') continue
    lines.push((KIND_LABELS[kind] || kind) + ' ' + entry.count + ' 段')
  }
  return lines
}

function previewOf(part, limit) {
  const text = part.text.replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim()
  if (!text) return '（空）'
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit)) + '…'
}

// 目录必须自己也很省：每段一行，只给段号、类型、字数、开头；超预算就截断目录本身。
export function buildFoldIndex(record, options = {}) {
  const id = String((record && record.id) || '')
  const turn = record && typeof record.turn === 'number' ? record.turn : 0
  const parts = options.parts || foldParts(record)
  const previewChars = typeof options.previewChars === 'number' && options.previewChars > 0 ? options.previewChars : 100
  const maxChars = typeof options.maxChars === 'number' && options.maxChars > 0 ? options.maxChars : 12000
  const totalChars = parts.reduce((sum, part) => sum + part.chars, 0)
  const head =
    '折叠 ' + id + '（第 ' + turn + ' 轮，原文约 ' + fmt(totalChars) + ' 字，共 ' + parts.length + ' 段）超过直接返回上限，先给目录。\n' +
    '用 fold_recall({id:"' + id + '", parts:["1","3-5"]}) 多选段号；也可写类型：think（思考）、reply（回复）、tools（调用与工具结果）、all（全部）。'

  const lines = []
  for (const part of parts) {
    lines.push('#' + part.no + ' [' + part.label + '] ' + fmt(part.chars) + ' 字：' + previewOf(part, previewChars))
  }
  let body = head + '\n\n' + lines.join('\n')
  const summary = kindSummary(parts)
  if (summary.length > 0) body += '\n\n合计：' + summary.join('、')

  if (body.length > maxChars) {
    // 按行截断，别把一行切成半句；剩余段号仍然有效，用区间选。
    // 尾注也要算进预算：先粗筛，再逐行回退到真的放得下为止。
    const render = (kept) => {
      const omitted = parts.length - kept.length
      let text = head + '\n\n' + kept.join('\n')
      if (omitted > 0) {
        text += '\n…（目录已截断：还有 ' + omitted + ' 段没列出来；段号连续，直接用区间选，例如 "' + (kept.length + 1) + '-' + parts.length + '"）'
      }
      return text
    }
    const kept = []
    let size = head.length + 2
    for (const line of lines) {
      if (size + line.length + 1 > maxChars) break
      kept.push(line)
      size += line.length + 1
    }
    body = render(kept)
    while (body.length > maxChars && kept.length > 0) {
      kept.pop()
      body = render(kept)
    }
    if (body.length > maxChars) body = body.slice(0, maxChars - 1) + '…'
  }
  return body
}

// parts 允许数组或逗号/空白分隔的字符串，模型用哪种写法都能工作。
export function normalizePartSelectors(parts) {
  if (parts === undefined || parts === null) return null
  const tokens = []
  const push = (value) => {
    if (typeof value !== 'string') return
    for (const token of value.split(/[,，\s]+/)) {
      const trimmed = token.trim()
      if (trimmed) tokens.push(trimmed)
    }
  }
  if (Array.isArray(parts)) for (const item of parts) push(item)
  else push(parts)
  return tokens.length > 0 ? tokens : null
}

// 选择器支持单个段号、区间与类型别名；未知项原样返回，让工具层告诉模型哪里写错了。
export function selectFoldParts(parts, selectors) {
  const all = Array.isArray(parts) ? parts : []
  const tokens = Array.isArray(selectors) ? selectors : []
  const picked = new Map()
  const unknown = []
  for (const raw of tokens) {
    const token = String(raw).trim().toLowerCase()
    if (!token) continue
    if (token === 'all') {
      for (const part of all) picked.set(part.no, part)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(TYPE_ALIASES, token)) {
      const kinds = TYPE_ALIASES[token]
      const matched = all.filter((part) => kinds.indexOf(part.kind) >= 0)
      if (matched.length === 0) unknown.push(raw)
      else for (const part of matched) picked.set(part.no, part)
      continue
    }
    const range = token.match(/^(\d+)\s*[-~]\s*(\d+)$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      let hit = false
      for (const part of all) {
        if (part.no >= Math.min(from, to) && part.no <= Math.max(from, to)) {
          picked.set(part.no, part)
          hit = true
        }
      }
      if (!hit) unknown.push(raw)
      continue
    }
    if (/^\d+$/.test(token)) {
      const found = all.find((part) => part.no === Number(token))
      if (found) picked.set(found.no, found)
      else unknown.push(raw)
      continue
    }
    unknown.push(raw)
  }
  return { picked: [...picked.values()].sort((a, b) => a.no - b.no), unknown }
}

// 整段返回：保持旧格式（--- #seq ---），模型已经学会按这个形状读。
export function describeFold(record) {
  const id = String((record && record.id) || '')
  const turn = record && typeof record.turn === 'number' ? record.turn : 0
  const items = record && Array.isArray(record.items) ? record.items : []
  const lines = ['折叠 ' + id + '（第 ' + turn + ' 轮，原文约 ' + (record && record.chars ? record.chars : 0) + ' 字）']
  for (const item of items) {
    lines.push('--- #' + item.seq + ' ---')
    lines.push(String(item.text || ''))
  }
  return lines.join('\n')
}

// 二级召回：只返回选中的段；超预算时按段截断，并明确告诉模型漏了多少。
export function renderFoldParts(record, picked, options = {}) {
  const id = String((record && record.id) || '')
  const turn = record && typeof record.turn === 'number' ? record.turn : 0
  const total = typeof options.total === 'number' ? options.total : picked.length
  const maxChars = typeof options.maxChars === 'number' && options.maxChars > 0 ? options.maxChars : 24000
  const head = '折叠 ' + id + '（第 ' + turn + ' 轮）取回 ' + picked.length + '/' + total + ' 段：'
  const blocks = []
  let size = head.length
  let used = 0
  for (const part of picked) {
    const block = '--- #' + part.no + ' ' + part.label + ' ---\n' + part.text
    if (size + block.length + 2 > maxChars && used > 0) break
    blocks.push(block)
    size += block.length + 2
    used += 1
  }
  let body = head + '\n\n' + blocks.join('\n\n')
  const omitted = picked.length - used
  if (omitted > 0) {
    body += '\n\n（还有 ' + omitted + ' 段没取回：总字数超过单次召回上限；再调 fold_recall 选剩下的段。）'
  } else if (used < total) {
    body += '\n\n（本轮还有 ' + (total - used) + ' 段没有取回；需要时再调 fold_recall 选别的段。）'
  }
  return body
}

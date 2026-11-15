// 分级召回：原文短就整段返回，长就先给分段目录，再用 parts 多选取回。
//
// 为什么分级：一轮折叠的原文可能有几十万字（思考 + 工具输出），整段塞回去既贵又没必要。
// 目录只列段号、类型、字数与开头，模型先判断哪几段有用，再二级召回。
// 这里全是纯函数：不读会话、不落账；计数与存储由工具层负责。

import { splitSections } from './markdown.js'
import { blocksOfFoldItem } from './turns.js'
import { CHARS_PER_TOKEN } from './tokens.js'

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
export function foldParts(record, options = {}) {
  const items = record && Array.isArray(record.items) ? record.items : []
  // 检查点里已经完整保留了回复时，召回不再返回回复段：那是重复内容，白占上下文。
  // 只有回复被截断（检查点里只有开头/结尾或只有标题）时才召回得到全文。
  const skipReply = record && record.replyTruncated === false
  // markdown 回复超过单次召回预算时按标题切段；没超过预算的回复仍是一整段，保持原有召回规则。
  const replySplitChars = typeof options.replySplitChars === 'number' && options.replySplitChars > 0 ? options.replySplitChars : 0
  const parts = []
  for (const item of items) {
    const seq = item && typeof item.seq === 'number' ? item.seq : null
    const blocks = blocksOfFoldItem(item && typeof item.text === 'string' ? item.text : '')
    for (const block of blocks) {
      const kind = block.kind || 'text'
      const name = block.name || ''
      const body = typeof block.text === 'string' ? block.text : ''
      if (skipReply && kind === 'reply') continue
      // 一段回复太长时按标题切成小节：目录里每节一行，模型能只取需要的结论/改动。
      // 标题前的导语也单独成段；标题不足两个就切不开，退回整段。
      const sections = kind === 'reply' && replySplitChars > 0 && body.length > replySplitChars ? splitSections(body) : null
      if (sections) {
        for (const section of sections) {
          parts.push({
            no: parts.length + 1,
            seq,
            kind,
            name,
            label: labelOf(kind, name),
            text: prefixOf(kind, name) + section.text,
            chars: section.text.length,
          })
        }
        continue
      }
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
  if (think) lines.push('思考 ' + think.count + ' 段（' + fmt(think.chars) + ' 字，≈' + Math.ceil(think.chars / CHARS_PER_TOKEN) + ' token）')
  const call = stats.get('call')
  if (call) lines.push('调用 ' + call.count + ' 次')
  const result = stats.get('result')
  if (result) lines.push('工具结果 ' + result.count + ' 段（' + fmt(result.chars) + ' 字，≈' + Math.ceil(result.chars / CHARS_PER_TOKEN) + ' token）')
  const reply = stats.get('reply')
  if (reply) lines.push('回复 ' + reply.count + ' 段（' + fmt(reply.chars) + ' 字，≈' + Math.ceil(reply.chars / CHARS_PER_TOKEN) + ' token）')
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

// 类型别名只列这条折叠里真的有的类型：写了 reply 却没有回复段，模型会白调一次。
export function kindChoices(parts) {
  const present = new Set((Array.isArray(parts) ? parts : []).map((part) => part.kind))
  const items = []
  if (present.has('think')) items.push('think（思考）')
  if (present.has('reply')) items.push('reply（回复）')
  if (present.has('call') || present.has('result')) items.push('tools（调用与工具结果）')
  if (present.has('inject')) items.push('inject（注入消息）')
  if (present.has('developer')) items.push('developer（开发者消息）')
  items.push('all（全部）')
  return items.join('、')
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
    '折叠 ' + id + '（第 ' + turn + ' 轮，原文约 ' + fmt(totalChars) + ' 字，≈' + Math.ceil(totalChars / CHARS_PER_TOKEN) + ' token，共 ' + parts.length + ' 段）超过直接返回上限，先给目录。\n' +
    '用 fold_recall({id:"' + id + '", parts:["1","3-5"]}) 多选段号；也可写类型：' + kindChoices(parts) + '。'

  const lines = []
  for (const part of parts) {
    lines.push('#' + part.no + ' [' + part.label + '] ' + fmt(part.chars) + ' 字（≈' + Math.ceil(part.chars / CHARS_PER_TOKEN) + ' token）：' + previewOf(part, previewChars))
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
    // 模型有时会传数字段号（parts:[1,2]）；静默忽略会退化成整段召回，不如直接接受。
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      tokens.push(String(value))
      return
    }
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
  const charsOfRecord = record && record.chars ? record.chars : 0
  const lines = ['折叠 ' + id + '（第 ' + turn + ' 轮，原文约 ' + charsOfRecord + ' 字，≈' + Math.ceil(charsOfRecord / CHARS_PER_TOKEN) + ' token）']
  // 回复已完整写进检查点，整段召回时不再重复返回。
  const skipReply = record && record.replyTruncated === false
  for (const item of items) {
    const text = skipReply
      ? String(item.text || '').split('\n').filter((line) => !line.startsWith('[回复] ')).join('\n')
      : String(item.text || '')
    if (!text) continue
    lines.push('--- #' + item.seq + ' ---')
    lines.push(text)
  }
  return lines.join('\n')
}

// 二级召回：只返回选中的段；超预算时逐段裁剪，并明确告诉模型漏了多少。
// 单段也可能远超预算（一段 10 万字的工具结果），所以必须逐段裁剪——
// 早先「第一段无论多大都整段放入」会让分级召回在最需要它的时候失效，甚至一次打爆上下文。
export function renderFoldParts(record, picked, options = {}) {
  const id = String((record && record.id) || '')
  const turn = record && typeof record.turn === 'number' ? record.turn : 0
  const total = typeof options.total === 'number' ? options.total : picked.length
  const maxChars = typeof options.maxChars === 'number' && options.maxChars > 0 ? options.maxChars : 24000
  const head = '折叠 ' + id + '（第 ' + turn + ' 轮）取回 ' + picked.length + '/' + total + ' 段：'
  const blocks = []
  // 尾注（「还有 N 段没取回」「其中 N 段被截断」）也要算进预算：
  // 正文刚好贴住上限时，不能让尾注把整段顶出去。
  const room = Math.max(0, maxChars - 90)
  let size = head.length
  let used = 0
  let truncated = 0
  for (const part of picked) {
    const label = '--- #' + part.no + ' ' + part.label + ' ---\n'
    const budget = room - size - 2
    // 连标签都放不下就别硬塞了；剩下的段在尾注里说明没取回。
    if (budget <= label.length + 1) break
    const text = String(part.text || '')
    let block = label + text
    if (block.length > budget) {
      // 给截断提示留出字数，正文至少留 1 字：这一段仍然算「取回过」。
      const note = '\n…（本段已截断：原文 ' + text.length + ' 字，≈' + Math.ceil(text.length / CHARS_PER_TOKEN) + ' token，本次只返回前 {kept} 字。需要完整内容请再按段召回。）'
      const reserve = note.length + 8
      const kept = Math.max(1, budget - label.length - reserve)
      block = label + text.slice(0, kept) + note.replace('{kept}', String(kept))
      truncated += 1
      if (block.length > budget) block = block.slice(0, budget)
    }
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
  if (truncated > 0) {
    body += '\n\n（其中 ' + truncated + ' 段因超过单次上限被截断；按段再召回可取回原文。）'
  }
  if (body.length > maxChars) body = body.slice(0, Math.max(0, maxChars - 1)) + '…'
  return body
}

// ---- 检索：按关键词/文件名找折叠，只给编号与段号 ----
// 模型常常记得「我读过 lib/web.js」，却不记得那是第几轮折的。检索把这条线索接上：
// 先定位到折叠与段号，再用 id + parts 二级召回。检索不返回原文，也不计入召回次数。

export function normalizeQuery(query) {
  if (typeof query !== 'string') return []
  const tokens = []
  const seen = new Set()
  for (const raw of query.toLowerCase().split(/[\s,，;；、]+/)) {
    const token = raw.trim()
    if (!token || seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
  }
  return tokens.slice(0, 8)
}

function partHaystack(part) {
  const name = part && part.name ? part.name : ''
  return (name ? name + ' ' : '') + String((part && part.text) || '')
}

// 命中位置附近取一小段：比段首更能说明「是不是这一段」。
function snippetOf(text, tokens, limit) {
  const value = String(text || '')
  const lower = value.toLowerCase()
  let index = -1
  for (const token of tokens) {
    const at = lower.indexOf(token)
    if (at >= 0 && (index < 0 || at < index)) index = at
  }
  if (index < 0) index = 0
  const start = Math.max(0, index - Math.floor(limit / 3))
  let piece = value.slice(start, start + limit).replace(/\s+/g, ' ').trim()
  if (start > 0) piece = '…' + piece
  if (start + limit < value.length) piece += '…'
  return piece
}

function partMatches(part, tokens) {
  const lower = partHaystack(part).toLowerCase()
  for (const token of tokens) {
    if (lower.indexOf(token) < 0) return false
  }
  return true
}

// 一条折叠里命中的段号：用于「指定 id + 关键词」的有条件二级召回。
export function matchFoldPartNumbers(record, tokens, options = {}) {
  const list = Array.isArray(tokens) ? tokens : []
  if (list.length === 0) return []
  const numbers = []
  for (const part of foldParts(record, options)) {
    if (partMatches(part, list)) numbers.push(part.no)
  }
  return numbers
}

// records 直接喂 store.readAll()：坏行已经被存储层滤掉，这里只认 fold 记录。
export function searchFolds(records, query, options = {}) {
  const tokens = normalizeQuery(typeof query === 'string' ? query : '')
  const previewChars = typeof options.previewChars === 'number' && options.previewChars > 0 ? options.previewChars : 60
  const results = []
  let parts = 0
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.kind !== 'fold' || typeof record.id !== 'string') continue
    // 段号必须与 fold_recall 目录一致：目录里切开的标题小节，检索也按小节给段号。
    const all = foldParts(record, { replySplitChars: options.replySplitChars })
    const matched = []
    for (const part of all) {
      if (!partMatches(part, tokens)) continue
      matched.push({
        no: part.no,
        kind: part.kind,
        name: part.name,
        label: part.label,
        chars: part.chars,
        snippet: snippetOf(part.text, tokens, previewChars),
      })
    }
    if (matched.length === 0) continue
    parts += matched.length
    results.push({
      id: record.id,
      turn: typeof record.turn === 'number' && Number.isFinite(record.turn) ? record.turn : 0,
      totalParts: all.length,
      matched,
    })
  }
  // 最近的折叠在前：同一个文件往往在最后一轮被读过，重读也只该重读那一版。
  results.sort((a, b) => b.turn - a.turn || b.matched.length - a.matched.length)
  return { tokens, results, parts }
}

// 检索结果本身也要省：每条折叠最多列 3 段，整体受 maxChars 约束。
export function renderSearchResults(query, found, options = {}) {
  const toolName = options.toolName || 'fold_recall'
  const maxFolds = typeof options.maxFolds === 'number' && options.maxFolds > 0 ? options.maxFolds : 8
  const maxParts = typeof options.maxParts === 'number' && options.maxParts > 0 ? options.maxParts : 3
  const maxChars = typeof options.maxChars === 'number' && options.maxChars > 0 ? options.maxChars : 24000
  const results = found && Array.isArray(found.results) ? found.results : []
  const text = String(query || '')
  if (results.length === 0) {
    return (
      '检索「' + text + '」：没有命中。换个关键词（文件名、函数名、报错片段、参数名都行）；' +
      '检索只搜折叠里的原文，重要消息与用户原话本来就在上下文里，不用搜。'
    )
  }
  const shown = results.slice(0, maxFolds)
  const lines = [
    '检索「' + text + '」：命中 ' + results.length + ' 条折叠、共 ' +
    (found && typeof found.parts === 'number' ? found.parts : 0) + ' 段（按轮次从近到远）。检索不返回原文，也不算一次召回。',
  ]
  let size = lines[0].length
  let folded = 0
  for (const result of shown) {
    if (size > maxChars) break
    const matched = result.matched.slice(0, maxParts)
    const head = '- ' + result.id + '（第 ' + (result.turn || '?') + ' 轮）命中 ' + result.matched.length + '/' + result.totalParts + ' 段'
    lines.push(head)
    size += head.length + 1
    for (const part of matched) {
      const line = '  #' + part.no + ' [' + part.label + '] ' + fmt(part.chars) + ' 字：' + part.snippet
      if (size + line.length > maxChars) break
      lines.push(line)
      size += line.length + 1
    }
    if (result.matched.length > matched.length) {
      const note = '  …还有 ' + (result.matched.length - matched.length) + ' 段命中，用 parts 区间选'
      lines.push(note)
      size += note.length + 1
    }
    folded += 1
  }
  if (results.length > folded) {
    lines.push('（还有 ' + (results.length - folded) + ' 条更早的折叠命中，换更具体的关键词能收窄。）')
  }
  const first = shown[0]
  lines.push(
    '取回原文：' + toolName + '({id:"' + first.id + '", parts:["' +
    first.matched.slice(0, 2).map((part) => String(part.no)).join('","') + '"]})',
  )
  return lines.join('\n')
}

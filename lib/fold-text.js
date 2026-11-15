// 纯函数层：从一条 surface 节点里取文本、算一轮内容的体量、生成折叠摘要。
// 这里不碰会话、不写盘，测试可以单独覆盖。

import { checkpointPrefix, sourceCheckpoint, sourceCompactCheckpoint, sourcePin, sourceSchedule } from './constants.js'
import { outlineOf } from './markdown.js'
import { CHARS_PER_TOKEN } from './tokens.js'

// 五种 surface 事件里，只有 user/message 的 data 是消息本身，其余都包在 data.message 里
//（dsh-session/lib/surface.js:82-105）。
export function messageOf(node) {
  if (!node) return undefined
  const data = node.data
  if (!data || typeof data !== 'object') return undefined
  return node.type === 'user/message' ? data : data.message
}

export function blocksOf(message) {
  const content = message && message.content
  return Array.isArray(content) ? content : []
}

export function replyText(message) {
  let out = ''
  for (const block of blocksOf(message)) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

export function reasoningText(message) {
  let out = ''
  for (const block of blocksOf(message)) {
    if (block && block.type === 'reasoning' && typeof block.text === 'string') out += block.text
  }
  return out
}

// 工具调用块：{ type:'tool-call', id, name, arguments: JSON 字符串 }。
export function toolCallsOf(message) {
  const out = []
  for (const block of blocksOf(message)) {
    if (!block || block.type !== 'tool-call') continue
    out.push({
      id: typeof block.id === 'string' ? block.id : '',
      name: typeof block.name === 'string' ? block.name : 'unknown',
      arguments: typeof block.arguments === 'string' ? block.arguments : '',
    })
  }
  return out
}

// 折叠之后模型看不到工具原文，最容易犯的错是把同一个文件再读一遍。
// 摘要里点名「改过 / 读过」哪些文件，模型才能判断该重读（内容变了）还是该召回（只是忘了）。
const PATH_KEYS = new Set(['file_path', 'filePath', 'path', 'file', 'files', 'dir', 'target', 'output_path', 'outputPath'])
const CODE_KEYS = new Set(['code', 'command', 'script', 'source'])
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'patch', 'notebook_edit', 'str_replace'])
// 只认绝对路径：代码里的相对路径多半是模块名，写进摘要反而误导。
// Windows 盘符与 POSIX 路径各一套；macOS/Linux 上 run_code/bash 的参数里常是 /home/...。
const WIN_PATH_PATTERN = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'\`()<>|*?,;，；]+/g
// 至少两段、不认 // 开头（URL 协议）与 :\ 前导（URL 里的 /path 不算本地文件）。
const POSIX_PATH_PATTERN = /(?<![\w.~:\/-])\/(?!\/)(?:[\w.-]+\/)+[\w.-]+/g

function matchAbsPaths(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const win = text.match(WIN_PATH_PATTERN) || []
  // 先从文本里抹掉 Windows 路径，否则 E:/a/b 会再被 POSIX 规则命中一次 /a/b。
  const rest = win.length > 0 ? text.replace(WIN_PATH_PATTERN, ' ') : text
  return win.concat(rest.match(POSIX_PATH_PATTERN) || [])
}

function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function cleanPath(raw) {
  const value = String(raw || '').replace(/\\/g, '/').replace(/\/+$/, '').trim()
  if (value.length < 3) return ''
  if (value.startsWith('http')) return ''
  return value
}

// 参数里按常见键名取路径；代码/命令字段里再扫一遍绝对路径（run_code 是主力工具，参数里没有 file_path）。
function collectArgumentPaths(value, depth, push) {
  if (!value || typeof value !== 'object' || depth > 3) return
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') push(item)
      else collectArgumentPaths(item, depth + 1, push)
    }
    return
  }
  for (const key of Object.keys(value)) {
    const item = value[key]
    if (PATH_KEYS.has(key)) {
      if (typeof item === 'string') push(item)
      else if (Array.isArray(item)) for (const one of item) if (typeof one === 'string') push(one)
      continue
    }
    if (typeof item === 'string') {
      if (!CODE_KEYS.has(key)) continue
      for (const found of matchAbsPaths(item)) push(found)
      continue
    }
    if (item && typeof item === 'object') collectArgumentPaths(item, depth + 1, push)
  }
}

// 一次工具调用涉及的文件：改过（能判断内容变了）与读过（可能只是忘了）。
// run_code 这类工具的路径算「读过」——它也可能在写，但写没写只有模型自己知道，摘要不替它下结论。
export function filesOfToolCall(call, options = {}) {
  const changed = []
  const read = []
  const seenChanged = new Set()
  const seenRead = new Set()
  const name = call && typeof call.name === 'string' ? call.name : ''
  // 工具返回 isError 时写调用并没有改到文件：归到「读过」，
  // 否则摘要会告诉模型「改过」，它会跳过重读、拿着旧内容继续做。
  const writeCall = WRITE_TOOLS.has(name) && options.failed !== true
  const args = parseArguments(call && call.arguments)
  if (args) {
    collectArgumentPaths(args, 0, (raw) => {
      const path = cleanPath(raw)
      if (!path) return
      addOnce(writeCall ? changed : read, writeCall ? seenChanged : seenRead, path)
    })
  }
  return { changed, read }
}

function addOnce(list, seen, path) {
  const key = String(path || '').toLowerCase()
  if (!key || seen.has(key)) return
  seen.add(key)
  list.push(path)
}

// 摘要里只留路径尾部两段：'E:/a/b/lib/tools.js' -> 'lib/tools.js'，省字数也够认。
export function shortPath(path) {
  const parts = String(path || '').split('/').filter(Boolean)
  if (parts.length <= 2) return parts.join('/')
  return parts.slice(-2).join('/')
}

function shortPaths(list, limit) {
  const names = []
  const seen = new Set()
  let total = 0
  for (const path of Array.isArray(list) ? list : []) {
    const name = shortPath(path)
    if (!name || seen.has(name)) continue
    seen.add(name)
    total += 1
    if (names.length < limit) names.push(name)
  }
  return { names, more: total > names.length ? ' 等 ' + total + ' 个' : '' }
}

// 「· 文件：改过 a；读过 b、c」——一行写完，模型扫一眼就知道该不该重读。
export function noteFilesLine(files, limits) {
  const changedLimit = limits && limits.changed ? limits.changed : 3
  const readLimit = limits && limits.read ? limits.read : 4
  const changedAll = Array.isArray(files && files.changed) ? files.changed : []
  const changed = shortPaths(changedAll, changedLimit)
  // 先按完整路径剔除改过的文件，再截断：否则「读过」的计数会把它们也算进去。
  const changedSet = new Set(changedAll.map((path) => String(path).toLowerCase()))
  const readAll = Array.isArray(files && files.read) ? files.read : []
  const read = shortPaths(readAll.filter((path) => !changedSet.has(String(path).toLowerCase())), readLimit)
  const parts = []
  if (changed.names.length > 0) parts.push('改过 ' + changed.names.join('、') + changed.more)
  if (read.names.length > 0) parts.push('读过 ' + read.names.join('、') + read.more)
  if (parts.length === 0) return ''
  return '· 文件：' + parts.join('；')
}

// 永不折叠的消息：用户本人说的话、模型发布的重要消息、上一次折叠留下的摘要、
// 调度器投递的用户指令（它是这一轮的起点，折掉等于吞掉用户要求），以及全部上下文
// 注入与开发者消息。注入一概保留，包括「看起来会重放」的那几种：
//
// 宿主判断「发过没有」的依据是这条消息在 surface 上是否还看得见。折叠用 replace
// 把它移出 surface，宿主就当作没发过、下一步重发一份——折掉省多少、重发补回多少，
// 净收益为零，还多一条检查点；技能目录重发的是完整目录而不是增量，折它更是净亏。
// 一次性注入（审批变化、子代理通知、工具变更、模型切换……）则根本不会被补发。
// 真正值得折的是思考、工具输出与长回复。
export function isKeeper(node) {
  if (!node) return false
  return node.type === 'user/message' || node.type === 'developer/message'
}

export function clip(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  return value.slice(0, Math.max(0, limit)) + '…'
}

// 一轮内容的体量统计：决定折不折、摘要里写什么。
export function statsOf(nodes) {
  const stats = {
    steps: 0,
    thinkBlocks: 0,
    reasoningChars: 0,
    replyChars: 0,
    toolChars: 0,
    toolOutputs: 0,
    callNames: [],
    files: { changed: [], read: [] },
    head: '',
    tail: '',
    // 一轮里可能有多次回复（工具调用之间各一段）。检查点必须覆盖全部回复：
    // 只拿 head 判断「回复是否完整保留」会在「开头短、结尾长」时误标成已完整，
    // 召回据此跳过回复段，最终结论就取不回来了。
    replies: [],
  }
  const changedFiles = []
  const readFiles = []
  const seenChanged = new Set()
  const seenRead = new Set()
  // 先收一遍失败的工具调用：结果节点在调用之后，直接单遍处理会来不及。
  const failedCalls = new Set()
  for (const node of nodes) {
    if (!node || node.type !== 'tool/result') continue
    const message = messageOf(node)
    if (message && message.isError === true && typeof message.toolCallId === 'string') failedCalls.add(message.toolCallId)
  }
  for (const node of nodes) {
    const message = messageOf(node)
    if (node.type === 'assistant/message') {
      stats.steps += 1
      const reasoning = reasoningText(message)
      if (reasoning) {
        stats.thinkBlocks += 1
        stats.reasoningChars += reasoning.length
      }
      const reply = replyText(message)
      if (reply) {
        stats.replyChars += reply.length
        if (!stats.head) stats.head = reply
        stats.tail = reply
        stats.replies.push(reply)
      }
      for (const call of toolCallsOf(message)) {
        stats.callNames.push(call.name)
        const files = filesOfToolCall(call, { failed: failedCalls.has(call.id) })
        for (const path of files.changed) addOnce(changedFiles, seenChanged, path)
        for (const path of files.read) addOnce(readFiles, seenRead, path)
      }
      continue
    }
    if (node.type === 'tool/result') {
      stats.toolChars += replyText(message).length
      stats.toolOutputs += 1
    }
  }
  stats.files = {
    changed: changedFiles,
    // 同一个文件既改过又读过时只算「改过」：摘要里不必重复点名。
    read: readFiles.filter((path) => !seenChanged.has(path.toLowerCase())),
  }
  return stats
}

// 工具输出是否计入折叠体量由配置决定：不计入摘要的内容，也不该计入「折了划不划算」的判断。
export function totalChars(stats, includeToolOutputs = true) {
  return stats.reasoningChars + stats.replyChars + (includeToolOutputs === false ? 0 : stats.toolChars)
}

// 字数后面附 token 估算（模型视角同时看两种口径）：1 token ≈ CHARS_PER_TOKEN 个字符。
function charTokens(n) {
  return '（≈' + Math.ceil(Number(n) / CHARS_PER_TOKEN) + ' token）'
}

// 预览把换行压成空格，避免摘要被多行回复撑成好几行。
function previewText(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

// 折叠摘要：只留模型判断「要不要召回」所需的信息——几段思考、调了什么工具、回复预览。
// 编号必须出现在第一行，否则模型想召回时会去猜编号。
// 长度上限只约束回复预览，不按原文比例：编号、计数与文件行是判断依据，先保住它们。

// 元信息行：编号、思考、工具调用、文件、工具输出段数。长度只由 stats 决定，
// 与回复内容无关，所以比例估算可以精确复用这组行。
function noteMetaLines({ foldId, turn, stats, toolName, includeToolOutputs = true }) {
  const lines = []
  lines.push(checkpointPrefix + ' 第 ' + turn + ' 轮已折叠，原文用 ' + toolName + '("' + foldId + '") 召回')
  if (stats.thinkBlocks > 0) lines.push('· 思考 ' + stats.thinkBlocks + ' 段，约 ' + stats.reasoningChars + ' 字' + charTokens(stats.reasoningChars))
  if (stats.callNames.length > 0) {
    const names = unique(stats.callNames).slice(0, 8).join('、')
    lines.push('· 工具调用 ' + stats.callNames.length + ' 次：' + names)
  }
  // 文件清单放在回复预览之前：预算不够时先保住「该不该重读」这个判断依据。
  const filesLine = noteFilesLine(stats.files)
  if (filesLine) lines.push(filesLine)
  if (includeToolOutputs !== false && stats.toolChars > 0) {
    lines.push('· 工具输出 ' + stats.toolOutputs + ' 段，约 ' + stats.toolChars + ' 字' + charTokens(stats.toolChars))
  }
  return lines
}

// 回复预览：maxTokens（token 估算）只约束预览文字本身，元信息不占额度。
// 整段不超过上限时原样保留、只出现一次；超过时 markdown 回复按标题摘要，
// 其它回复取「开头 + 结尾」，合计不超过上限。
// 标题摘要的长度由原文标题结构直接算出（outlineOf），可以与原文比长短：
// 标题很少时「标题 / 标题」的连写可能比原文还长，这时保留原文，折不折交给折叠比例判断。
function replyPreviewLine({ stats, maxTokens }) {
  if (!(stats.replyChars > 0 && stats.head)) return { text: '', truncated: false, outline: false }
  const limit = Math.max(8, maxTokens * CHARS_PER_TOKEN)
  // 多段回复拼起来再判断：只看第一段会把「开头短、结尾长」误判成完整保留。
  const replies = Array.isArray(stats.replies) && stats.replies.length > 0 ? stats.replies : [stats.head]
  const joined = replies.join('\n')
  const desc = previewText(joined)
  if (desc.length <= limit) {
    // 回复完整保留时不再标字数：标了反而像被截断过；字数和 token 只在截断时才有信息量。
    return { text: '· 回复：' + desc, truncated: false, outline: false }
  }
  // markdown 回复：给「有哪些章节」而不是随机截出来的开头+结尾。摘要本身不截断，
  // 标题就是模型的导航；要正文再按段召回。
  const outline = outlineOf(joined)
  if (outline) {
    if (outline.text.length < joined.length) {
      return {
        text: '· 回复约 ' + stats.replyChars + ' 字' + charTokens(stats.replyChars) + '，按标题摘要（' + outline.count + ' 个标题）：' + outline.text,
        truncated: true,
        outline: true,
      }
    }
    // 标题并不比原文短（标题多、正文少时会发生）：保留原文，别用更长的「摘要」。
    return {
      text: '· 回复约 ' + stats.replyChars + ' 字' + charTokens(stats.replyChars) + '，原文如下：' + joined,
      truncated: false,
      outline: false,
    }
  }
  const tailLen = Math.max(4, Math.ceil(limit / 4))
  const headLen = Math.max(4, limit - tailLen)
  return {
    text:
      '· 回复约 ' + stats.replyChars + ' 字' + charTokens(stats.replyChars) + '，开头「' + desc.slice(0, headLen) + '…」，结尾「…' + desc.slice(-tailLen) + '」',
    truncated: true,
    outline: false,
  }
}

export function buildNoteEx({ foldId, turn, stats, maxTokens, toolName, includeToolOutputs = true }) {
  const lines = noteMetaLines({ foldId, turn, stats, toolName, includeToolOutputs })
  const reply = replyPreviewLine({ stats, maxTokens })
  if (reply.text) lines.push(reply.text)
  return { text: lines.join('\n'), replyTruncated: reply.truncated }
}

export function buildNote(args) {
  return buildNoteEx(args).text
}

// 摘要长度估算：元信息行精确相加；回复预览无论整段保留、标题摘要还是开头+结尾，
// 长度都由 stats 当场算出（标题清单也在这里列出来），所以不需要任何长度设置，
// 不含回复的检查点同样是精确长度。
export function estimateNoteChars({ foldId, turn, stats, maxTokens, toolName, includeToolOutputs = true }) {
  const meta = noteMetaLines({ foldId, turn, stats, toolName, includeToolOutputs }).join('\n')
  const reply = replyPreviewLine({ stats, maxTokens })
  if (!reply.text) return meta.length
  return meta.length + 1 + reply.text.length
}

// 折叠划算与否：摘要长度 / 原文长度低于阈值才折；等于阈值时保留原文。
export function isWorthFolding(summaryChars, originalChars, ratio) {
  const threshold = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0.5
  if (!(originalChars > 0) || !(summaryChars >= 0)) return false
  return summaryChars < originalChars * threshold
}

export function unique(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

// 召回载荷：按节点保留「角色 + 原文」，工具调用把参数一起留下，召回时模型才能判断值不值得重跑。
// includeToolOutputs=false 时整段丢弃工具结果：摘要里没提的内容，召回时也不该突然出现。
export function recallItems(nodes, maxChars, includeToolOutputs = true) {
  const items = []
  let budget = maxChars
  for (const node of nodes) {
    const message = messageOf(node)
    let text = ''
    if (node.type === 'assistant/message') {
      const reasoning = reasoningText(message)
      const reply = replyText(message)
      // 调用参数就是原文：模型常靠它判断「当时到底跑了什么」。别在这里截断，
      // 整段召回返回多少由 maxRecallTokens 决定（载具体量由 store 的会话上限兜底）。
      const calls = toolCallsOf(message).map((call) => '[调用 ' + call.name + '] ' + call.arguments)
      text = [reasoning ? '[思考] ' + reasoning : '', reply ? '[回复] ' + reply : '', ...calls].filter(Boolean).join('\n')
    } else if (node.type === 'tool/result') {
      if (includeToolOutputs === false) continue
      text = '[工具结果] ' + replyText(message)
    } else if (node.type === 'user/message') {
      text = '[注入消息] ' + replyText(message)
    } else if (node.type === 'developer/message') {
      text = '[开发者消息] ' + replyText(message)
    }
    if (!text) continue
    const cost = text.length
    if (cost > budget) {
      items.push({ seq: node.seq, text: clip(text, budget) })
      budget = 0
      break
    }
    items.push({ seq: node.seq, text })
    budget -= cost
    if (budget <= 0) break
  }
  return items
}

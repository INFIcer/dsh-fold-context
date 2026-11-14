// 纯函数层：从一条 surface 节点里取文本、算一轮内容的体量、生成折叠摘要。
// 这里不碰会话、不写盘，测试可以单独覆盖。

import { checkpointPrefix, sourceCheckpoint, sourcePin } from './constants.js'

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
const ABS_PATH_PATTERN = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'\`()<>|*?,;，；]+/g

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
      for (const found of item.match(ABS_PATH_PATTERN) || []) push(found)
      continue
    }
    if (item && typeof item === 'object') collectArgumentPaths(item, depth + 1, push)
  }
}

// 一次工具调用涉及的文件：改过（能判断内容变了）与读过（可能只是忘了）。
// run_code 这类工具的路径算「读过」——它也可能在写，但写没写只有模型自己知道，摘要不替它下结论。
export function filesOfToolCall(call) {
  const changed = []
  const read = []
  const seenChanged = new Set()
  const seenRead = new Set()
  const name = call && typeof call.name === 'string' ? call.name : ''
  const writeCall = WRITE_TOOLS.has(name)
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

// 永不折叠的消息：用户本人说的话、模型发布的重要消息、上一次折叠留下的摘要。
// 运行时注入、调度提醒都属于「上下文」，可以折——折掉的内容靠 fold_recall 取回，
// 下一轮 agent-loop 也会重新注入最新的一份。
export function isKeeper(node) {
  if (!node || node.type !== 'user/message') return false
  const message = messageOf(node)
  const kind = message && message.source && message.source.kind
  return kind === 'user' || kind === sourcePin || kind === sourceCheckpoint
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
  }
  const changedFiles = []
  const readFiles = []
  const seenChanged = new Set()
  const seenRead = new Set()
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
      }
      for (const call of toolCallsOf(message)) {
        stats.callNames.push(call.name)
        const files = filesOfToolCall(call)
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

// 折叠摘要：只留模型判断「要不要召回」所需的信息——几段思考、调了什么工具、回复的开头和结尾。
// 编号必须出现在第一行，否则模型想召回时会去猜编号。
export function buildNote({ foldId, turn, stats, maxChars, toolName, includeToolOutputs = true }) {
  const lines = []
  lines.push(checkpointPrefix + ' 第 ' + turn + ' 轮已折叠，原文用 ' + toolName + '("' + foldId + '") 召回')
  if (stats.thinkBlocks > 0) lines.push('· 思考 ' + stats.thinkBlocks + ' 段，约 ' + stats.reasoningChars + ' 字')
  if (stats.callNames.length > 0) {
    const names = unique(stats.callNames).slice(0, 8).join('、')
    lines.push('· 工具调用 ' + stats.callNames.length + ' 次：' + names)
  }
  // 文件清单放在回复预览之前：预算不够时先保住「该不该重读」这个判断依据。
  const filesLine = noteFilesLine(stats.files)
  if (filesLine) lines.push(filesLine)
  if (includeToolOutputs !== false && stats.toolChars > 0) {
    lines.push('· 工具输出 ' + stats.toolOutputs + ' 段，约 ' + stats.toolChars + ' 字')
  }
  if (stats.replyChars > 0) {
    const head = clip(stats.head, 60)
    const tail = stats.tail.length > 100 ? stats.tail.slice(-40) : ''
    lines.push('· 回复约 ' + stats.replyChars + ' 字，开头「' + head + '」' + (tail ? '，结尾「…' + tail + '」' : ''))
  }
  const joined = lines.join('\n')
  if (joined.length <= maxChars) return joined
  return joined.slice(0, Math.max(0, maxChars - 1)) + '…'
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
      const calls = toolCallsOf(message).map((call) => '[调用 ' + call.name + '] ' + clip(call.arguments, 300))
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

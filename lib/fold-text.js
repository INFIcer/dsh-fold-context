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

// 永不折叠的消息：用户本人说的话、模型发布的重要消息、上一次折叠留下的摘要。
// 前两种是原文，最后一种已经是摘要——再折一次只会把编号折没。
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
    head: '',
    tail: '',
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
      }
      for (const call of toolCallsOf(message)) stats.callNames.push(call.name)
      continue
    }
    if (node.type === 'tool/result') {
      stats.toolChars += replyText(message).length
      stats.toolOutputs += 1
    }
  }
  return stats
}

export function totalChars(stats) {
  return stats.reasoningChars + stats.replyChars + stats.toolChars
}

// 折叠摘要：只留模型判断「要不要召回」所需的信息——几段思考、调了什么工具、回复的开头和结尾。
// 编号必须出现在第一行，否则模型想召回时会去猜编号。
export function buildNote({ foldId, turn, stats, maxChars, toolName }) {
  const lines = []
  lines.push(checkpointPrefix + ' 第 ' + turn + ' 轮已折叠，原文用 ' + toolName + '("' + foldId + '") 召回')
  if (stats.thinkBlocks > 0) lines.push('· 思考 ' + stats.thinkBlocks + ' 段，约 ' + stats.reasoningChars + ' 字')
  if (stats.callNames.length > 0) {
    const names = unique(stats.callNames).slice(0, 8).join('、')
    lines.push('· 工具调用 ' + stats.callNames.length + ' 次：' + names)
  }
  if (stats.toolChars > 0) lines.push('· 工具输出 ' + stats.toolOutputs + ' 段，约 ' + stats.toolChars + ' 字')
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
export function recallItems(nodes, maxChars) {
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

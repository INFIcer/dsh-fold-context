// token 估算：和宿主 @deepseek-ai/dsh-token-meter 用同一套经验公式。
//
// CHARS_PER_TOKEN = 4、BLOCK_OVERHEAD = 4 来自 dsh-token-meter 的 estimateContent：
// 每个 text / reasoning 块算 ceil(长度 / 4) + 4。统计页按这个口径算，
// 数字才和宿主自己的进度条对得上；它不是分词器，只是同口径的估算。
//
// 侧栏「上下文」页（dsh-context）对每条消息也是这么算的，但它把 tool-call
// 的名字与参数各算一块，还额外加上系统提示词与工具定义；我们只给折叠产物计价，
// 所以两边的绝对数字不可直接比，口径本身是一致的。

export const CHARS_PER_TOKEN = 4
export const BLOCK_OVERHEAD = 4

// texts 里的每个字符串按一个内容块计；空串不计。
export function estimateTokens(texts) {
  const list = Array.isArray(texts) ? texts : [texts]
  let total = 0
  for (const text of list) {
    if (typeof text !== 'string' || text.length === 0) continue
    total += Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  return total
}

// 只知道字符数、不知道分块时用：按一个块估算，宁少不多。
export function estimateChars(chars) {
  const value = typeof chars === 'number' && Number.isFinite(chars) ? chars : 0
  if (value <= 0) return 0
  return Math.ceil(value / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

// 一个内容块：text / reasoning 按正文；tool-call 名字与参数分开算；其它按 JSON。
export function estimateBlockTokens(block) {
  if (!block || typeof block !== 'object') return 0
  if (block.type === 'text' || block.type === 'reasoning') {
    const text = typeof block.text === 'string' ? block.text : ''
    return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  if (block.type === 'tool-call') {
    const name = typeof block.name === 'string' ? block.name : ''
    const args = typeof block.arguments === 'string' ? block.arguments : ''
    return Math.ceil(name.length / CHARS_PER_TOKEN) + Math.ceil(args.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  let json = ''
  try {
    json = JSON.stringify(block) || ''
  } catch {
    json = ''
  }
  return Math.ceil(json.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

// 一条消息：各块相加，再算一条消息的固定开销。空消息不占上下文。
export function estimateMessageTokens(message) {
  if (!message || !Array.isArray(message.content) || message.content.length === 0) return 0
  let total = 0
  for (const block of message.content) total += estimateBlockTokens(block)
  return total + BLOCK_OVERHEAD
}

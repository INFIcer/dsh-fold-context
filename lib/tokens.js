// token 估算：和宿主 @deepseek-ai/dsh-token-meter 用同一套经验公式。
//
// CHARS_PER_TOKEN = 4、BLOCK_OVERHEAD = 4 来自 dsh-token-meter 的 estimateContent：
// 每个 text / reasoning 块算 ceil(长度 / 4) + 4。统计页按这个口径算，
// 数字才和宿主自己的进度条对得上；它不是分词器，只是同口径的估算。

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

// 真实用量：provider 回报的 token 账单，按轮累加。
//
// 两种形状都要认：provider 原始回报用 inputTokens / cacheReadTokens，
// 折叠记录里存的是归一化后的 input / cacheRead（字段更短，便于落盘）。
// 计费输入 = 未命中 + 缓存命中 + 写缓存；它与账本的字符估算口径不同，
// 所以只用来当 ground truth，不参与反事实推算。

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

// 同一个量在不同形状下的两个键：先认归一化键，再认 provider 原始键。
function pick(usage, key, alias) {
  if (!usage || typeof usage !== 'object') return 0
  if (usage[key] !== undefined) return num(usage[key])
  return num(usage[alias])
}

export function emptyUsage() {
  return { steps: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

// 一次模型调用的 usage 累加进本轮；没有 usage 的调用（极少见）不计步数。
export function addUsage(target, usage) {
  if (!target || !usage || typeof usage !== 'object') return target
  target.steps += 1
  target.input += pick(usage, 'input', 'inputTokens')
  target.cacheRead += pick(usage, 'cacheRead', 'cacheReadTokens')
  target.cacheWrite += pick(usage, 'cacheWrite', 'cacheWriteTokens')
  target.output += pick(usage, 'output', 'outputTokens')
  return target
}

// 从折叠记录里读回用量；老记录没有这个字段，返回 null 让调用方跳过。
export function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null
  const usage = {
    steps: num(value.steps),
    input: pick(value, 'input', 'inputTokens'),
    cacheRead: pick(value, 'cacheRead', 'cacheReadTokens'),
    cacheWrite: pick(value, 'cacheWrite', 'cacheWriteTokens'),
    output: pick(value, 'output', 'outputTokens'),
  }
  // 只给了 token 数、没给步数（provider 原始回报）时，按一次调用算。
  if (usage.steps === 0 && usage.input + usage.cacheRead > 0) usage.steps = 1
  if (usage.steps === 0 && usage.input === 0 && usage.cacheRead === 0) return null
  return usage
}

// 计费输入：未命中 + 命中 + 写缓存。
export function promptTokensOf(usage) {
  return pick(usage, 'input', 'inputTokens') + pick(usage, 'cacheRead', 'cacheReadTokens') + pick(usage, 'cacheWrite', 'cacheWriteTokens')
}

// 计价：token 数 × 单价 → 人民币。
//
// DeepSeek 的输入按「是否命中前缀缓存」分两档计价，输出再单独一档，所以三个价格都得能改：
// 换模型、走代理、官方调价，页面上的金额才跟着走。默认值取 2026-11 的官方价目表（谷时）：
// 缓存命中 0.02、未命中 1、输出 4，单位是「元 / 百万 token」；峰时按峰值倍率（默认 2）乘。
//
// 峰谷不是「按现在是不是峰时」一刀切：每条记录按它自己的时间戳判峰时还是谷时，
// 历史记录也按各自发生的那一刻还原。时段判定来自 fish-token 插件（见 peak.js），
// 这一层只做「单价 × 倍率」的纯换算。
//
// 这里只做换算，不负责取整展示：显示多少位小数是页面的事，
// 但所有累加都用未取整的原始值，避免逐行四舍五入把总额带偏。

export const TOKENS_PER_PRICE_UNIT = 1000000

// 三个价格键与它们在配置里的字段名一一对应；页面按这个顺序展示。
export const priceLabels = [
  { key: 'cacheHit', field: 'priceCacheHitInput', label: '缓存命中输入' },
  { key: 'input', field: 'priceInput', label: '输入（未命中）' },
  { key: 'output', field: 'priceOutput', label: '输出' },
]

export const defaultPrices = { cacheHit: 0.02, input: 1, output: 4 }

// 峰值倍率默认 2：与官方价目表的峰谷关系一致（峰时是谷时的两倍）。
// 设成 1 等于不区分峰谷，与「关掉按峰谷计价」在金额上等价。
export const defaultPeakMultiplier = 2
// 配置层把倍率钳在 1~10；这里是同一口径的兜底，保证坏配置不会把金额放大成天文数字。
const PEAK_MULTIPLIER_MAX = 10

// 前缀缓存的真实命中率：DeepSeek 实测约 97%。配置项 cacheHitRate 只在没有 provider 回报时用它兜底；
// 有回报时成本模型直接改用实测值。
export const defaultHitRate = 1

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function priceOf(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1000, Math.max(0, value))
}

// 配置 → 三档单价；缺项或非法值退回默认价，不让页面因为一个坏数字崩掉。
export function pricesOf(config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    cacheHit: priceOf(source.priceCacheHitInput, defaultPrices.cacheHit),
    input: priceOf(source.priceInput, defaultPrices.input),
    output: priceOf(source.priceOutput, defaultPrices.output),
  }
}

// 峰值倍率只接受 1~10；1 表示不区分峰谷。坏值退回默认，避免把金额放大成天文数字。
export function clampPeakMultiplier(value, fallback = defaultPeakMultiplier) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(PEAK_MULTIPLIER_MAX, Math.max(1, value))
}

// 配置里的峰值倍率。
export function peakMultiplierOf(config) {
  const source = config && typeof config === 'object' ? config : {}
  return clampPeakMultiplier(source.peakMultiplier)
}

// 单价只剩六位小数，乘完先按同一精度收口：页面上直接把单价拼进文字，
// 浮点尾巴会让 0.02 × 1.7 显示成一长串。
function scaledPrice(value, factor) {
  return Math.round(value * factor * TOKENS_PER_PRICE_UNIT) / TOKENS_PER_PRICE_UNIT
}

// 给定倍率下的三档单价；倍率 1 直接返回原对象，调用方不必关心浮点乘法。
export function pricesAtMultiplier(prices, multiplier) {
  const base = prices || defaultPrices
  const factor = typeof multiplier === 'number' && Number.isFinite(multiplier) ? Math.max(1, multiplier) : 1
  if (factor === 1) return base
  return {
    cacheHit: scaledPrice(num(base.cacheHit), factor),
    input: scaledPrice(num(base.input), factor),
    output: scaledPrice(num(base.output), factor),
  }
}

// 六个小数足够表示一分钱的千分之一，落进 JSON 也不会有浮点尾巴。
export function roundMoney(value) {
  const number = num(value)
  return Math.round(number * TOKENS_PER_PRICE_UNIT) / TOKENS_PER_PRICE_UNIT
}

// 三分类 token → 各自金额与合计；分类金额用来和单价并排展示，能逐项复核。
export function moneyOf(parts, prices) {
  const p = prices || defaultPrices
  const hitTokens = num(parts && parts.hit)
  const inputTokens = num(parts && parts.input)
  const outputTokens = num(parts && parts.output)
  const cacheHit = roundMoney((hitTokens * p.cacheHit) / TOKENS_PER_PRICE_UNIT)
  const input = roundMoney((inputTokens * p.input) / TOKENS_PER_PRICE_UNIT)
  const output = roundMoney((outputTokens * p.output) / TOKENS_PER_PRICE_UNIT)
  return { cacheHit, input, output, total: roundMoney(cacheHit + input + output) }
}

// 不取整的三档金额：峰谷混合时总价要先把每条记录按它自己的单价累加，
// 再统一取整；逐条 moneyOf 会让每条都舍入一次，总额与分项对不上。
export function rawMoneyOf(parts, prices) {
  const p = prices || defaultPrices
  const cacheHit = (num(parts && parts.hit) * num(p.cacheHit)) / TOKENS_PER_PRICE_UNIT
  const input = (num(parts && parts.input) * num(p.input)) / TOKENS_PER_PRICE_UNIT
  const output = (num(parts && parts.output) * num(p.output)) / TOKENS_PER_PRICE_UNIT
  return { cacheHit, input, output, total: cacheHit + input + output }
}

// 这里故意不再提供「命中率加权均价」：折叠省下的是重发的旧历史（命中价），
// 召回与摘要的首次上行是新内容（未命中价），两种方向相反的量共用一个均价，
// 必然一边高估一边低估。要算钱就分档乘各自单价，见 stats.js 与 cost.js。

// token 数 × 单价 → 元；账本里只有 token 量、不需要分类时用它。
export function yuanOf(tokens, price) {
  return roundMoney((num(tokens) * num(price)) / TOKENS_PER_PRICE_UNIT)
}

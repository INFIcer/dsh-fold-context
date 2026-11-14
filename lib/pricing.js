// 计价：token 数 × 单价 → 人民币。
//
// DeepSeek 的输入按「是否命中前缀缓存」分两档计价，输出再单独一档，所以三个价格都得能改：
// 换模型、走代理、官方调价，页面上的金额才跟着走。默认值取 2026-11 的官方价目表（空闲时段）：
// 缓存命中 0.02、未命中 1、输出 4，单位是「元 / 百万 token」；高峰时段是这套的两倍。
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

// 前缀缓存的真实命中率：DeepSeek 实测约 97%。配置项 cacheHitRate 只在没有 provider 回报时用它兜底；
// 有回报时成本模型直接改用实测值。
export const defaultHitRate = 0.97

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

// 上下文里的一个 token 平均值多少钱：命中与未命中按命中率加权。
// 账本用它给「常驻上下文」的增减压价（折叠省下的、召回取回的都在这一类）。
// 命中率用真实命中率（DeepSeek 实测约 0.97），不是「缓存价是输入价的几分之一」。
export function blendedInputPrice(prices, hitRate) {
  const p = prices || defaultPrices
  const ratio = Math.min(1, Math.max(0, num(hitRate, defaultHitRate)))
  return roundMoney(p.cacheHit * ratio + p.input * (1 - ratio))
}

// token 数 × 单价 → 元；账本里只有 token 量、不需要分类时用它。
export function yuanOf(tokens, price) {
  return roundMoney((num(tokens) * num(price)) / TOKENS_PER_PRICE_UNIT)
}

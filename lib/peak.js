// 峰谷计价的接入层：把 fish-token 插件的同步纯函数 getPricing(at) 包成「按时间点判峰谷」。
//
// 为什么要单独一层：cost.js / stats.js 是纯函数，测试只喂普通对象；服务发现属于宿主接线，
// 不该让成本模型直接摸 ctx。web.js 每次请求调一次 peakPricingOf，拿到的是普通对象。
//
// 服务可能不存在、可能抛错、可能返回坏形状。这里全部折成「不可用」：
// - 没有 fish.token，或它没有 getPricing：available=false、fallback=true；
// - 某次 getPricing 抛错 / 返回非对象 / ok 明确为 false / peak 不是布尔：pricingAt 返回 null，
//   成本模型把那一笔记成「时段未知」并按峰时算，不把异常带进统计路由。
//
// 拿不到时段时按峰值倍率算（保守）：宁可把谷时记成峰时，也不要把峰时的账算少。
// 面板与日志会标明这是回退估算，用户能看出这个数不是按时段查出来的。
//
// 倍率的出处只有一个：默认跟随 fish.token 报的 multiplier（它有自己的设置，默认 2）；
// 本插件的 peakMultiplier 在用户改过时覆盖它——留一个「1 = 不区分峰谷」的本地开关。
// 判断「改过」的口径是「不等于默认 2」，这样两条默认值不会写死成两份可能漂移的数字。

import { clampPeakMultiplier, defaultPeakMultiplier, peakMultiplierOf } from './pricing.js'

export const peakServiceId = 'fish.token'

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optionalTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

// 只接受契约里的字段；价格与时段判断用 peak / phase，别的字段只用于面板展示。
// 两种形状都认：冻结契约给 peak 布尔，后续版本若只给 phase 也不至于被当成「服务不可用」。
export function normalizePricingPoint(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.ok === false) return null
  const peak = raw.peak === true
    ? true
    : raw.peak === false
      ? false
      : raw.phase === 'peak'
        ? true
        : raw.phase === 'offpeak'
          ? false
          : null
  if (peak === null) return null
  return {
    ok: true,
    period: peak ? 'peak' : 'offpeak',
    peak,
    multiplier: typeof raw.multiplier === 'number' && Number.isFinite(raw.multiplier) && raw.multiplier >= 1
      ? raw.multiplier
      : null,
    timezone: typeof raw.timezone === 'string' ? raw.timezone : '',
    now: num(raw.now) || null,
    nextSwitchAt: optionalTime(raw.nextSwitchAt),
    nextPeakAt: optionalTime(raw.nextPeakAt),
    nextOffPeakAt: optionalTime(raw.nextOffPeakAt),
    // 以下只用于面板文案：为何是谷时（周末/节假日/午休/夜间），以及节假日历是否覆盖今年。
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    calendar: raw.calendar && typeof raw.calendar === 'object'
      ? {
          covered: raw.calendar.covered === false ? false : raw.calendar.covered === true ? true : null,
          year: num(raw.calendar.year) || null,
        }
      : null,
  }
}

// 惰性取服务：fish-token 可能晚于本插件就绪，所以每次请求都重新 ctx.get，取不到就当没有。
export function readPricingApi(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null
    const api = ctx.get(peakServiceId)
    if (!api || typeof api.getPricing !== 'function') return null
    return api
  } catch {
    return null
  }
}

// 返回成本模型/账本要的普通对象：
//   enabled     设置里的「按峰谷计价」是否打开
//   available   服务此刻是否可用（取得到当前时刻的合法判定）
//   multiplier  最终峰值倍率（默认跟随服务；用户改过设置时用设置值）
//   pricingAt(at) => 判定或 null（同步、绝不抛错）
//   now         当前时刻的判定，面板显示峰/谷与切换时间
export function peakPricingOf(ctx, config, now = Date.now()) {
  const enabled = !(config && config.peakPricing === false)
  const configured = peakMultiplierOf(config)
  if (!enabled) {
    return {
      enabled: false,
      available: false,
      fallback: false,
      multiplier: configured,
      configuredMultiplier: configured,
      serviceMultiplier: null,
      pricingAt: null,
      now: null,
    }
  }
  const api = readPricingApi(ctx)
  if (!api) {
    return {
      enabled: true,
      available: false,
      fallback: true,
      multiplier: configured,
      configuredMultiplier: configured,
      serviceMultiplier: null,
      pricingAt: null,
      now: null,
    }
  }
  // 逐条判定优先用 getWindow（没有切换时间计算，更便宜）；服务没给就退回 getPricing。
  // 两者都是同步纯函数，坏值/抛错一律折成 null，由成本模型按峰时保守兜底。
  const pricingAt = (at) => {
    const when = typeof at === 'number' ? at : now
    try {
      if (typeof api.getWindow === 'function') {
        const cheaper = normalizePricingPoint(api.getWindow(when))
        if (cheaper) return cheaper
      }
      return normalizePricingPoint(api.getPricing(when))
    } catch {
      return null
    }
  }
  // 当前时刻要展示「下次切换」，所以仍取完整判定（getPricing 带 next* 字段）。
  let current = null
  try {
    current = normalizePricingPoint(api.getPricing(typeof now === 'number' ? now : Date.now()))
  } catch {
    current = null
  }
  if (!current) current = pricingAt(typeof now === 'number' ? now : Date.now())
  const serviceMultiplier = current && typeof current.multiplier === 'number'
    ? clampPeakMultiplier(current.multiplier)
    : null
  // 默认值跟服务对齐；用户把设置改离默认值（例如 1）时以设置为准。
  const multiplier = configured === defaultPeakMultiplier && serviceMultiplier !== null
    ? serviceMultiplier
    : configured
  return {
    enabled: true,
    available: current !== null,
    // 服务在、但当前时刻判不出来，同样按峰时兜底。
    fallback: current === null,
    multiplier,
    configuredMultiplier: configured,
    serviceMultiplier,
    pricingAt,
    now: current,
  }
}

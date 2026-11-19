// 峰谷计价的接入层：服务发现、脏数据降级与回退口径。
// 这里用假的 ctx 与服务，不依赖 fish-token 真的在运行。

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizePricingPoint, peakPricingOf, readPricingApi } from '../lib/peak.js'

const HOUR = 3600 * 1000

function fakeCtx(api) {
  return {
    get(name) {
      assert.equal(name, 'fish.token')
      if (api instanceof Error) throw api
      return api
    },
  }
}

function point(extra) {
  return Object.assign({
    ok: true,
    period: 'peak',
    peak: true,
    multiplier: 2,
    timezone: 'Asia/Hong_Kong',
    now: 1000,
    nextSwitchAt: 2000,
    nextPeakAt: null,
    nextOffPeakAt: 3000,
  }, extra)
}

test('没有 fish.token 服务时降级成回退：按峰值倍率保守估算', () => {
  const peak = peakPricingOf(fakeCtx(undefined), {})
  assert.equal(peak.enabled, true)
  assert.equal(peak.available, false)
  assert.equal(peak.fallback, true)
  assert.equal(peak.multiplier, 2)
  assert.equal(peak.pricingAt, null)
  assert.equal(peak.now, null)
  // 没有 ctx / ctx.get 抛错同样是回退，不把异常带出去。
  assert.equal(peakPricingOf(null, {}).fallback, true)
  assert.equal(peakPricingOf(fakeCtx(new Error('boom')), {}).fallback, true)
})

test('服务没有 getPricing 时也按回退处理', () => {
  const peak = peakPricingOf(fakeCtx({ version: 1 }), {})
  assert.equal(peak.available, false)
  assert.equal(peak.fallback, true)
  assert.equal(readPricingApi(fakeCtx({ version: 1 })), null)
})

test('服务正常时透出时段、倍率与下次切换时间', () => {
  const api = {
    version: 1,
    getPricing(at) {
      const offset = at - 1000
      return point({
        peak: offset < HOUR,
        period: offset < HOUR ? 'peak' : 'offpeak',
        now: at,
        nextSwitchAt: 1000 + HOUR,
      })
    },
  }
  const peak = peakPricingOf(fakeCtx(api), {}, 1000)
  assert.equal(peak.available, true)
  assert.equal(peak.fallback, false)
  assert.equal(peak.now.peak, true)
  assert.equal(peak.now.period, 'peak')
  assert.equal(peak.now.timezone, 'Asia/Hong_Kong')
  assert.equal(peak.now.nextSwitchAt, 1000 + HOUR)
  assert.equal(peak.now.nextOffPeakAt, 3000)
  // 逐时间点查询：同一个服务按 at 返回不同时段，调用方不用自己写钟点判断。
  assert.equal(peak.pricingAt(1000 + 2 * HOUR).peak, false)
  assert.equal(peak.pricingAt(1000 + 2 * HOUR).period, 'offpeak')
})

test('getPricing 抛错或返回坏形状时只让那一次判定为空', () => {
  let calls = 0
  const api = {
    getPricing(at) {
      calls += 1
      if (calls === 1) return point({ now: at })
      if (calls === 2) throw new Error('upstream down')
      if (calls === 3) return { ok: false, error: 'no data' }
      if (calls === 4) return { ok: true, peak: 'yes' }
      return null
    },
  }
  const peak = peakPricingOf(fakeCtx(api), {}, 1000)
  assert.equal(peak.available, true)
  assert.equal(peak.now.peak, true)
  // 第一次调用（构造 current）成功；之后每次坏值都只让那一次判定为空。
  assert.equal(peak.pricingAt(2000), null)
  assert.equal(peak.pricingAt(3000), null)
  assert.equal(peak.pricingAt(4000), null)
  assert.equal(peak.pricingAt(5000), null)
})

test('当前时刻判不出来时也算回退，不能当成谷时', () => {
  const api = { getPricing() { throw new Error('down') } }
  const peak = peakPricingOf(fakeCtx(api), {}, 1000)
  assert.equal(peak.available, false)
  assert.equal(peak.fallback, true)
  assert.equal(peak.now, null)
})

test('设置里关掉按峰谷计价时不再碰服务', () => {
  let touched = false
  const api = { getPricing() { touched = true; return point() } }
  const peak = peakPricingOf(fakeCtx(api), { peakPricing: false })
  assert.equal(peak.enabled, false)
  assert.equal(peak.fallback, false)
  assert.equal(peak.available, false)
  assert.equal(touched, false)
})

test('峰值倍率来自设置并被钳制在 1~10', () => {
  assert.equal(peakPricingOf(fakeCtx(undefined), { peakMultiplier: 3 }).multiplier, 3)
  assert.equal(peakPricingOf(fakeCtx(undefined), { peakMultiplier: 0 }).multiplier, 1)
  assert.equal(peakPricingOf(fakeCtx(undefined), { peakMultiplier: 99 }).multiplier, 10)
  assert.equal(peakPricingOf(fakeCtx(undefined), { peakMultiplier: 'x' }).multiplier, 2)
})

test('倍率默认跟随服务报的 multiplier，设置改过时以设置为准', () => {
  const api = { getPricing(at) { return point({ multiplier: 3, now: at }) } }
  // 默认 2 且用户没改：采信服务报的倍率，两处默认值不会各写一份。
  const followed = peakPricingOf(fakeCtx(api), {})
  assert.equal(followed.multiplier, 3)
  assert.equal(followed.serviceMultiplier, 3)
  assert.equal(followed.configuredMultiplier, 2)
  // 用户改过设置：以设置为准，1 真的等于不区分峰谷。
  assert.equal(peakPricingOf(fakeCtx(api), { peakMultiplier: 1 }).multiplier, 1)
  assert.equal(peakPricingOf(fakeCtx(api), { peakMultiplier: 4 }).multiplier, 4)
  // 服务倍率不合契约（0 / 非数字）时不参与解析，退回设置值。
  const bad = { getPricing(at) { return point({ multiplier: 0, now: at }) } }
  assert.equal(peakPricingOf(fakeCtx(bad), {}).multiplier, 2)
})

test('服务提供 getWindow 时逐条判定走它，避免每条都算下次切换', () => {
  let windowCalls = 0
  let pricingCalls = 0
  const api = {
    getWindow(at) {
      windowCalls += 1
      return { ok: true, phase: 'peak', now: at, multiplier: 2 }
    },
    getPricing(at) {
      pricingCalls += 1
      return point({ now: at })
    },
  }
  const peak = peakPricingOf(fakeCtx(api), {}, 1000)
  // 当前时刻仍用 getPricing，面板要 nextSwitchAt。
  assert.equal(pricingCalls, 1)
  assert.equal(peak.now.nextSwitchAt, 2000)
  // 逐条判定走 getWindow（没有 next* 计算），结果仍是同一个时段。
  assert.equal(peak.pricingAt(5000).peak, true)
  assert.equal(windowCalls, 1)
})

test('getPricing 的 phase 形状也认，不把服务当成不可用', () => {
  const api = {
    getPricing(at) {
      return { ok: true, phase: 'offpeak', multiplier: 2, timezone: 'Asia/Hong_Kong', now: at }
    },
  }
  const peak = peakPricingOf(fakeCtx(api), {}, 1000)
  assert.equal(peak.available, true)
  assert.equal(peak.now.peak, false)
  assert.equal(peak.now.period, 'offpeak')
  assert.equal(peak.fallback, false)
})

test('normalizePricingPoint 只认契约字段，坏值折成 null', () => {
  assert.equal(normalizePricingPoint(null), null)
  assert.equal(normalizePricingPoint({ ok: false, peak: true }), null)
  assert.equal(normalizePricingPoint({ ok: true }), null)
  const normal = normalizePricingPoint(point({ peak: false, period: 'offpeak', multiplier: 0 }))
  assert.equal(normal.peak, false)
  assert.equal(normal.period, 'offpeak')
  // 服务报的倍率不合契约时置空，由设置里的倍率兜底。
  assert.equal(normal.multiplier, null)
  // 面板要用的原因与节假日历状态随判定一起透出。
  const holiday = normalizePricingPoint(point({ reason: 'holiday', calendar: { covered: false, year: 2028 } }))
  assert.equal(holiday.reason, 'holiday')
  assert.equal(holiday.calendar.covered, false)
  assert.equal(holiday.calendar.year, 2028)
})

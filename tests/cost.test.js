// 成本模型的单元测试：喂造出来的轮分组与折叠记录，核对重放口径、校准与三档金额。

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCost, normalizeLatest } from '../lib/cost.js'
import { roundMoney } from '../lib/pricing.js'
import { estimateChars } from '../lib/tokens.js'

function turn(extra) {
  return Object.assign({
    kind: 'turn',
    turn: 1,
    steps: 1,
    folded: true,
    chars: 1000,
    checkpointChars: 0,
    unfoldedChars: 1000,
    outputChars: 0,
  }, extra)
}

// 重放量：前缀每步发一次，轮内新增平均处在半步上下文里。
function resendOf(steps, baseChars, addedChars) {
  return steps * estimateChars(baseChars) + estimateChars(addedChars) * ((steps - 1) / 2)
}

test('buildCost 对折叠历史算出的开销低于不折叠', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000 }),
    turn({ turn: 2, steps: 1, chars: 300, checkpointChars: 300, unfoldedChars: 4000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: {} })
  assert.equal(cost.ok, true)
  assert.equal(cost.totals.turns, 2)
  assert.equal(cost.totals.steps, 3)
  assert.ok(cost.totals.foldedTokens > 0)
  assert.ok(cost.totals.unfoldedTokens > cost.totals.foldedTokens)
  assert.ok(cost.totals.netSavedTokens > 0)
  assert.ok(cost.totals.savedRate > 0 && cost.totals.savedRate < 1)
  assert.equal(cost.latest, null)
  // 没有 provider 回报时不做校准，系数是 1。
  assert.equal(cost.calibration.coveredTurns, 0)
  assert.equal(cost.calibration.promptScale, 1)
})

test('命中率为 0 时折叠视角的前缀全部按未命中计价', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 3, chars: 1200, checkpointChars: 200, unfoldedChars: 60000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRate: 0 } })
  const row = cost.turns[0]
  // 本轮请求里的内容 = 1200 - 200 = 1000 字；系统提示 4000 字是上一轮之后写入的，也算未命中。
  const added = estimateChars(1000)
  const fresh = estimateChars(4000)
  const resend = resendOf(3, 0, 1000)
  assert.equal(row.foldedHitTokens, 0)
  assert.equal(row.foldedInputTokens, resend + added + fresh)
  assert.equal(row.foldedTokens, 2 * added + fresh)
  // 不折叠视角的整体体积照旧：系统提示 4000 字每步一次，原文 60000 字平均半步。
  assert.equal(row.unfoldedTokens, resendOf(3, 4000, 60000) + estimateChars(60000))
  // 未命中不按体积再折一遍：两种视角每步的新增内容一样，没上一轮就没有轮边界差。
  assert.equal(row.unfoldedInputTokens, row.foldedInputTokens)
  assert.equal(row.netSavedTokens, row.unfoldedTokens - row.foldedTokens)
})

test('不折叠视角的未命中只比折叠视角多出轮边界那条回复', () => {
  // 第一轮长回复 800 字、折成 200 字摘要；第二轮原样。
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 3, chars: 1200, checkpointChars: 200, unfoldedChars: 60000, outputChars: 800 }),
    turn({ turn: 2, steps: 2, chars: 400, checkpointChars: 400, unfoldedChars: 8000, outputChars: 100 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRate: 0.9 } })
  const row = cost.turns[1]
  // 差 = 上一轮回复 − 上一轮摘要：多出来的只有这条边界，跟上下文涨到多大无关。
  assert.equal(row.boundaryDeltaTokens, estimateChars(800) - estimateChars(200))
  assert.equal(row.unfoldedInputTokens - row.foldedInputTokens, estimateChars(800) - estimateChars(200))
})

test('上下文体积翻倍不会放大两种视角的未命中差', () => {
  function build(prevUnfoldedChars) {
    return buildCost({
      groups: [
        turn({ turn: 1, steps: 6, chars: 1200, checkpointChars: 200, unfoldedChars: prevUnfoldedChars, outputChars: 800 }),
        turn({ turn: 2, steps: 2, chars: 400, checkpointChars: 400, unfoldedChars: 8000, outputChars: 100 }),
      ],
      folds: [],
      config: { cacheHitRate: 0.9 },
    })
  }
  const small = build(20000)
  const big = build(200000)
  const gapSmall = small.turns[1].unfoldedInputTokens - small.turns[1].foldedInputTokens
  const gapBig = big.turns[1].unfoldedInputTokens - big.turns[1].foldedInputTokens
  assert.equal(gapSmall, gapBig)
  // 体积差全落在命中的前缀里：折叠后整体仍然便宜。
  assert.ok(big.totals.netSavedTokens > small.totals.netSavedTokens)
})

test('命中率为 1 时前缀按命中价、且按步数重复计费', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 1, chars: 1000, checkpointChars: 0, unfoldedChars: 1000 }),
    turn({ turn: 2, steps: 4, chars: 400, checkpointChars: 400, unfoldedChars: 8000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRate: 1 } })
  const row = cost.turns[1]
  // 前缀 = 系统提示 + 上一次请求之后写入的历史（第 1 轮折叠后只剩 0 字检查点）。
  assert.equal(row.foldedTokens, 4 * estimateChars(5000))
  assert.equal(row.foldedInputTokens, 0)
})

test('没折叠的短回合整段仍算新内容，不进命中前缀', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, folded: false, chars: 900, checkpointChars: 0, unfoldedChars: 900 }),
    turn({ turn: 2, steps: 2, chars: 200, checkpointChars: 200, unfoldedChars: 5000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRate: 0 } })
  const row = cost.turns[1]
  assert.equal(row.foldedTokens, 2 * estimateChars(4000) + estimateChars(900))
})

test('用量的 steps 为 0 时退回 1 步，不出现除零', () => {
  const groups = [turn({ turn: 3, steps: 0, chars: 500, checkpointChars: 100, unfoldedChars: 5000 })]
  const cost = buildCost({ groups, folds: [], config: {} })
  assert.equal(cost.turns[0].steps, 1)
  assert.ok(Number.isFinite(cost.turns[0].foldedTokens))
})

test('按轮去重 usage，同一轮折成多段只算一次', () => {
  const folds = [
    { id: 'f1a', turn: 1, usage: { steps: 2, input: 100, cacheRead: 900, cacheWrite: 0, output: 50 } },
    { id: 'f1b', turn: 1, usage: { steps: 9, input: 1, cacheRead: 1, cacheWrite: 0, output: 1 } },
    { id: 'f2', turn: 2, usage: { steps: 1, input: 200, cacheRead: 0, cacheWrite: 0, output: 10 } },
  ]
  const groups = [turn({ turn: 1, steps: 2 }), turn({ turn: 2, steps: 1 })]
  const cost = buildCost({ groups, folds, config: {} })
  assert.equal(cost.turns[0].actualPromptTokens, 1000)
  assert.equal(cost.turns[0].actualSteps, 2)
  assert.equal(cost.turns[1].actualPromptTokens, 200)
  assert.equal(cost.totals.actualPromptTokens, 1200)
  assert.equal(cost.totals.actualSteps, 3)
  assert.equal(cost.totals.actualTurns, 2)
})

test('同一轮被切成两组时合并成一行，不重复计费', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 3, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000 }),
    turn({ turn: 3, steps: 3, chars: 300, checkpointChars: 100, unfoldedChars: 5000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: {} })
  assert.equal(cost.turns.length, 1)
  const row = cost.turns[0]
  assert.equal(row.turn, 3)
  assert.equal(row.steps, 5)
  assert.equal(row.foldedChars, 1500)
  assert.equal(row.checkpointChars, 300)
  assert.equal(row.unfoldedChars, 65000)
})

test('只有最后一条系统提示计入开销，旧版副本不计', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    { kind: 'system', chars: 6000 },
    turn({ turn: 1, steps: 1, chars: 1000, checkpointChars: 200, unfoldedChars: 5000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRate: 0 } })
  const row = cost.turns[0]
  assert.equal(row.foldedTokens, estimateChars(800) + estimateChars(6000))
})

test('drift 给出会话历史估算与 provider 实测的对照', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 2, chars: 1000, checkpointChars: 200, unfoldedChars: 5000 }),
  ]
  const cost = buildCost({
    groups,
    folds: [],
    config: {},
    actual: { input: 120, cacheRead: 900, cacheWrite: 0, output: 40, turn: 1, step: 2 },
  })
  assert.ok(cost.drift)
  assert.equal(cost.drift.estimateTokens, cost.totals.contextFoldedTokens)
  assert.equal(cost.drift.actualPromptTokens, 1020)
  assert.ok(cost.drift.ratio > 0)
  assert.equal(cost.drift.overEstimate, cost.totals.contextFoldedTokens > 1020 * 1.3)
  assert.equal(cost.drift.governedTokens, cost.totals.contextFoldedTokens)
  assert.equal(cost.drift.externalTokens, Math.max(0, 1020 - cost.totals.contextFoldedTokens))
})

test('drift 把插件生效前那一轮单列出来', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, prePlugin: true, chars: 40000, checkpointChars: 0, unfoldedChars: 40000 }),
    turn({ turn: 2, chars: 300, checkpointChars: 300, unfoldedChars: 4000 }),
  ]
  const cost = buildCost({
    groups,
    folds: [],
    config: {},
    actual: { input: 500, cacheRead: 3500, cacheWrite: 0, output: 10, turn: 2, step: 1 },
  })
  assert.equal(cost.totals.legacyTokens, estimateChars(40000))
  assert.equal(cost.drift.legacyTokens, estimateChars(40000))
  assert.equal(cost.drift.governedTokens, cost.drift.estimateTokens - estimateChars(40000))
  assert.equal(cost.drift.externalTokens, Math.max(0, 4000 - cost.drift.governedTokens))
})

test('normalizeLatest 把 tracker 的最近一次回报换成展示口径', () => {
  assert.equal(normalizeLatest(null), null)
  assert.equal(normalizeLatest({ input: 0, cacheRead: 0 }), null)
  const latest = normalizeLatest({ input: 1200, cacheRead: 95000, cacheWrite: 0, output: 800, turn: 7, step: 3, at: 123 })
  assert.equal(latest.promptTokens, 96200)
  assert.equal(latest.outputTokens, 800)
  assert.equal(latest.turn, 7)
  assert.equal(latest.at, 123)
})

test('没有回报时按配置的命中率，金额按三档单价结算', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000, outputChars: 800 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRate: 0.9 } })
  // 默认价 = 2026-11 空闲时段：命中 0.02、未命中 1、输出 4 元 / 百万 token。
  assert.deepEqual(cost.prices, { cacheHit: 0.02, input: 1, output: 4 })
  assert.equal(cost.hitRate, 0.9)
  const expected = roundMoney(
    (cost.totals.foldedHitTokens * 0.02 + cost.totals.foldedInputTokens * 1 + cost.totals.outputTokens * 4) / 1e6,
  )
  assert.equal(cost.totals.foldedMoney, expected)
  assert.equal(cost.totals.netSavedMoney, roundMoney(cost.totals.unfoldedMoney - cost.totals.foldedMoney))
  assert.ok(cost.totals.netSavedMoney > 0)
  // 行金额逐项可复核；行用未取整 token 算，与整数 token 的差不到一分钱。
  const row = cost.turns[0]
  const rowExpected = roundMoney(
    (row.foldedHitTokens * 0.02 + row.foldedInputTokens * 1 + row.outputTokens * 4) / 1e6,
  )
  assert.ok(Math.abs(row.foldedMoney - rowExpected) < 1e-4)
})

test('输出价同时作用于两种视角，做差时抵消', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000, outputChars: 800 }),
  ]
  const cheap = buildCost({ groups, folds: [], config: { priceOutput: 1 } })
  const dear = buildCost({ groups, folds: [], config: { priceOutput: 30 } })
  assert.ok(dear.totals.foldedMoney > cheap.totals.foldedMoney)
  assert.ok(dear.totals.unfoldedMoney > cheap.totals.unfoldedMoney)
  assert.equal(dear.totals.netSavedMoney, cheap.totals.netSavedMoney)
})

test('自定义未命中价按比例放大输入侧金额', () => {
  const groups = [turn({ turn: 1, steps: 1, chars: 1000, checkpointChars: 0, unfoldedChars: 4000 })]
  const base = buildCost({ groups, folds: [], config: { cacheHitRate: 0 } })
  const pricey = buildCost({ groups, folds: [], config: { cacheHitRate: 0, priceInput: 10 } })
  // 命中率为 0 时全部走未命中价，单价 ×10，金额也应 ×10（输出为 0，不受影响）。
  assert.ok(Math.abs(pricey.totals.foldedMoney - base.totals.foldedMoney * 10) < 1e-6)
})

test('校准：用实测总量反推系数，命中率也改用实测值', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000, outputChars: 800 }),
  ]
  const folds = [
    { id: 'f1', turn: 1, usage: { steps: 2, input: 600, cacheRead: 1400, cacheWrite: 0, output: 400 } },
  ]
  const cost = buildCost({ groups, folds, config: { cacheHitRate: 0.97 } })
  assert.equal(cost.calibration.coveredTurns, 1)
  assert.equal(cost.measuredHitRate, 0.7)
  assert.equal(cost.hitRate, 0.7)
  // 单轮：校准后重放量正好等于实测输入。
  assert.ok(Math.abs(cost.totals.foldedTokens - 2000) <= 2)
  // 输出也被校准到实测：1.96 倍，落在 0.2~8 的安全区间内。
  assert.ok(Math.abs(cost.calibration.outputScale - 400 / estimateChars(800)) < 1e-9)
  // 实测金额按同一套单价结算：1400 命中 + 600 未命中 + 400 输出。
  assert.equal(cost.totals.actualMoney, roundMoney(1400 * 0.02 / 1e6 + 600 * 1 / 1e6 + 400 * 4 / 1e6))
  assert.equal(cost.totals.actualPromptTokens, 2000)
  assert.equal(cost.totals.actualTurns, 1)
})

test('校准系数被钳制在安全区间', () => {
  const groups = [turn({ turn: 1, steps: 1, chars: 400000, checkpointChars: 0, unfoldedChars: 400000, outputChars: 400000 })]
  const folds = [{ id: 'f1', turn: 1, usage: { steps: 1, input: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }]
  const cost = buildCost({ groups, folds, config: {} })
  // 实测远小于估算：系数夹在 0.02，不会把整份账单算成 0。
  assert.equal(cost.calibration.promptScale, 0.02)
  assert.equal(cost.calibration.outputScale, 0.2)
})

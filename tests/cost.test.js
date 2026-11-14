// 成本模型的单元测试：喂造出来的轮分组与折叠记录，核对缓存命中口径与净节省的符号。

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
  }, extra)
}

test('buildCost 对折叠历史算出的开销低于不折叠', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000 }),
    turn({ turn: 2, steps: 1, chars: 300, checkpointChars: 300, unfoldedChars: 4000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRatio: 0.25 } })
  assert.equal(cost.ok, true)
  assert.equal(cost.totals.turns, 2)
  assert.equal(cost.totals.steps, 3)
  assert.ok(cost.totals.foldedTokens > 0)
  assert.ok(cost.totals.unfoldedTokens > cost.totals.foldedTokens)
  assert.ok(cost.totals.netSavedTokens > 0)
  assert.ok(cost.totals.savedRate > 0 && cost.totals.savedRate < 1)
  assert.equal(cost.latest, null)
})

test('缓存命中为 0 时单轮成本就是本轮新增 + 上一轮检查点', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 3, chars: 1200, checkpointChars: 200, unfoldedChars: 60000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRatio: 0 } })
  const row = cost.turns[0]
  // 本轮请求里的内容 = 1200 - 200 检查点 = 1000 字；系统提示 4000 字是上一轮之后写入的，未命中。
  assert.equal(row.foldedTokens, estimateChars(1000) + estimateChars(4000))
  assert.equal(row.unfoldedTokens, estimateChars(60000))
  assert.equal(row.netSavedTokens, row.unfoldedTokens - row.foldedTokens)
})

test('缓存命中为 1 时前缀按步数重复计费，检查点不再额外收费', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 1, chars: 1000, checkpointChars: 0, unfoldedChars: 1000 }),
    turn({ turn: 2, steps: 4, chars: 400, checkpointChars: 400, unfoldedChars: 8000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRatio: 1 } })
  const row = cost.turns[1]
  // 前缀 = 系统提示 + 上一轮的检查点（本轮请求里已经在上游缓存）；本轮自身内容为 0。
  const base = estimateChars(4000 + 1000)
  assert.equal(row.foldedTokens, 4 * base + estimateChars(0) * 1.5)
})

test('没折叠的短回合整段仍算新内容，不影响下一轮的命中前缀', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, folded: false, chars: 900, checkpointChars: 0, unfoldedChars: 900 }),
    turn({ turn: 2, steps: 2, chars: 200, checkpointChars: 200, unfoldedChars: 5000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRatio: 0 } })
  const row = cost.turns[1]
  assert.equal(row.foldedTokens, estimateChars(0) + estimateChars(900))
})

test('用量的 steps 为 0 时退回 1 步，不出现除零', () => {
  const groups = [turn({ turn: 3, steps: 2, chars: 500, checkpointChars: 100, unfoldedChars: 5000 })]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRatio: 0.5 } })
  assert.ok(Number.isFinite(cost.turns[0].foldedTokens))
})

test('按轮去重 usage，同一轮折成多段只算一次', () => {
  const folds = [
    { id: 'f1a', turn: 1, usage: { steps: 2, input: 100, cacheRead: 900, cacheWrite: 0, output: 50 } },
    { id: 'f1b', turn: 1, usage: { steps: 9, input: 1, cacheRead: 1, cacheWrite: 0, output: 1 } },
    { id: 'f2', turn: 2, usage: { steps: 1, input: 200, cacheRead: 0, cacheWrite: 0, output: 10 } },
  ]
  const groups = [turn({ turn: 1, steps: 2 }), turn({ turn: 2, steps: 1 })]
  const cost = buildCost({ groups, folds, config: { cacheHitRatio: 0.25 } })
  // 每行是该轮所有步的计费输入之和（不是平均到每步）。
  assert.equal(cost.turns[0].actualPromptTokens, 1000)
  assert.equal(cost.turns[0].actualSteps, 2)
  assert.equal(cost.turns[1].actualPromptTokens, 200)
  assert.equal(cost.totals.actualPromptTokens, 1200)
  assert.equal(cost.totals.coveredFoldedTokens, cost.turns[0].foldedTokens + cost.turns[1].foldedTokens)
  assert.equal(cost.totals.actualSteps, 3)
})

test('同一轮被切成两组时合并成一行，不重复计费', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 3, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000 }),
    turn({ turn: 3, steps: 3, chars: 300, checkpointChars: 100, unfoldedChars: 5000 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRatio: 0.25 } })
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
  const cost = buildCost({ groups, folds: [], config: { cacheHitRatio: 0 } })
  const row = cost.turns[0]
  // 本轮新增 800 字 + 本轮请求前写入的当前系统提示 6000 字（旧版 4000 字不上行）。
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
    config: { cacheHitRatio: 0.25 },
    actual: { input: 120, cacheRead: 900, cacheWrite: 0, output: 40, turn: 1, step: 2 },
  })
  assert.ok(cost.drift)
  assert.equal(cost.drift.estimateTokens, cost.totals.contextFoldedTokens)
  assert.equal(cost.drift.actualPromptTokens, 1020)
  assert.ok(cost.drift.ratio > 0)
  assert.equal(cost.drift.overEstimate, cost.totals.contextFoldedTokens > 1020 * 1.3)
  // 没有插件生效前的历史时，「归折叠管的部分」就是整份历史，实测差额全是历史之外的开销。
  assert.equal(cost.drift.governedTokens, cost.totals.contextFoldedTokens)
  assert.equal(cost.drift.externalTokens, Math.max(0, 1020 - cost.totals.contextFoldedTokens))
  assert.equal(cost.drift.underEstimate, cost.totals.contextFoldedTokens > 1020 * 1.3)
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
    config: { cacheHitRatio: 0.25 },
    actual: { input: 500, cacheRead: 3500, cacheWrite: 0, output: 10, turn: 2, step: 1 },
  })
  // 没折过的那一轮既不归折叠管，也不该藏在「估算偏高」里，所以单列。
  assert.equal(cost.totals.legacyTokens, estimateChars(40000))
  assert.equal(cost.drift.legacyTokens, estimateChars(40000))
  assert.equal(cost.drift.eraTokens, cost.drift.estimateTokens - estimateChars(40000))
  // 页面并排比的是 governedTokens 和实测：生效前那一轮不进这个口径。
  assert.equal(cost.drift.governedTokens, cost.drift.eraTokens)
  assert.equal(cost.drift.externalTokens, 4000 - cost.drift.governedTokens)
  assert.equal(cost.drift.underEstimate, false)
  assert.ok(cost.drift.governedRatio > 1)
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
function moneyOfParts(totals, prices) {
  return roundMoney(
    (totals.foldedHitTokens * prices.cacheHit + totals.foldedInputTokens * prices.input + totals.outputTokens * prices.output) / 1e6,
  )
}

test('金额按三档单价结算：命中 + 未命中 + 输出', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000, outputChars: 800 }),
    turn({ turn: 2, steps: 1, chars: 300, checkpointChars: 300, unfoldedChars: 4000, outputChars: 200 }),
  ]
  const cost = buildCost({ groups, folds: [], config: { cacheHitRatio: 0.25 } })
  // 默认价：命中 0.2、未命中 2、输出 3 元 / 百万 token。
  assert.equal(cost.prices.cacheHit, 0.2)
  assert.equal(cost.prices.input, 2)
  assert.equal(cost.prices.output, 3)
  // 输出按轮各算一次（每块 4 token 的固定开销），合计即各行之和。
  assert.equal(cost.turns[0].outputTokens, estimateChars(800))
  assert.equal(cost.totals.outputTokens, cost.turns.reduce((sum, row) => sum + row.outputTokens, 0))
  assert.equal(cost.totals.foldedMoney, moneyOfParts(cost.totals, cost.prices))
  assert.equal(cost.totals.netSavedMoney, roundMoney(cost.totals.unfoldedMoney - cost.totals.foldedMoney))
  assert.ok(cost.totals.netSavedMoney > 0)
  // 每一行也能逐项复核：三档金额之和 = 该行合计。
  // 行金额用未取整的 token 算，和「整数 token × 单价」有不到一分钱的差。
  const row = cost.turns[0]
  const expected = roundMoney(
    (row.foldedHitTokens * 0.2 + row.foldedInputTokens * 2 + row.outputTokens * 3) / 1e6,
  )
  assert.ok(Math.abs(row.foldedMoney - expected) < 1e-4)
})

test('输出价同时作用于两种视角，做差时抵消', () => {
  const groups = [
    { kind: 'system', chars: 4000 },
    turn({ turn: 1, steps: 2, chars: 1200, checkpointChars: 200, unfoldedChars: 60000, outputChars: 800 }),
  ]
  const cheap = buildCost({ groups, folds: [], config: { cacheHitRatio: 0.25, priceOutput: 1 } })
  const dear = buildCost({ groups, folds: [], config: { cacheHitRatio: 0.25, priceOutput: 30 } })
  assert.ok(dear.totals.foldedMoney > cheap.totals.foldedMoney)
  assert.ok(dear.totals.unfoldedMoney > cheap.totals.unfoldedMoney)
  // 净省只看输入侧，输出价怎么调都不该动它。
  assert.equal(dear.totals.netSavedMoney, cheap.totals.netSavedMoney)
})

test('自定义未命中价按比例放大输入侧金额', () => {
  const groups = [turn({ turn: 1, steps: 1, chars: 1000, checkpointChars: 0, unfoldedChars: 4000 })]
  const base = buildCost({ groups, folds: [], config: { cacheHitRatio: 0 } })
  const pricey = buildCost({ groups, folds: [], config: { cacheHitRatio: 0, priceInput: 20 } })
  // 命中为 0 时全部走未命中价，单价 ×10，金额也应 ×10。
  assert.ok(Math.abs(pricey.totals.foldedMoney - base.totals.foldedMoney * 10) < 1e-6)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStats, foldCost } from '../lib/stats.js'
import { estimateTokens } from '../lib/tokens.js'
import { pinPrefix } from '../lib/constants.js'
import { roundMoney } from '../lib/pricing.js'

function fold(id, turn, text, note, extra) {
  return Object.assign({
    kind: 'fold',
    id,
    turn,
    at: 1000 + turn,
    chars: text.length,
    note,
    items: [{ seq: 1, text }],
  }, extra || {})
}

test('foldCost 用载荷与摘要的 token 差算收益', () => {
  const record = fold('f1', 1, 'a'.repeat(400), 'b'.repeat(40))
  const cost = foldCost(record)
  assert.equal(cost.originalTokens, estimateTokens(['a'.repeat(400)]))
  assert.equal(cost.noteTokens, estimateTokens(['b'.repeat(40)]))
  assert.equal(cost.savedTokens, cost.originalTokens - cost.noteTokens)
  assert.equal(cost.savedChars, 360)
  assert.equal(cost.estimated, false)
})

test('foldCost 对缺载荷的旧记录退回字面量估算', () => {
  const cost = foldCost({ kind: 'fold', id: 'f9', turn: 2, chars: 400, note: 'b'.repeat(40), items: [] })
  assert.equal(cost.estimated, true)
  assert.ok(cost.savedTokens > 0)
  assert.equal(cost.savedChars, 360)
})

test('buildStats 按轮收拢收益与成本', () => {
  const pinText = 'cccc'
  const records = [
    fold('f1', 1, 'a'.repeat(400), 'b'.repeat(40)),
    fold('f2', 2, 'x'.repeat(200), 'y'.repeat(20)),
    { kind: 'recall', id: 'f1', turn: 2, at: 2002, chars: 40, tokens: 14 },
    { kind: 'pin', id: 'P', turn: 1, at: 2001, text: pinText },
  ]
  const stats = buildStats({ records, config: { minFoldTokens: 1200 }, now: 3000 })
  assert.equal(stats.ok, true)
  assert.equal(stats.totals.folds, 2)
  assert.equal(stats.totals.recalls, 1)
  assert.equal(stats.totals.pins, 1)
  assert.equal(stats.totals.savedTokens, foldCost(records[0]).savedTokens + foldCost(records[1]).savedTokens)
  assert.equal(stats.totals.recallTokens, 14)
  assert.equal(stats.totals.pinTokens, estimateTokens([pinPrefix + ' P\n' + pinText]))
  assert.equal(stats.totals.netTokens, stats.totals.savedTokens - 14 - stats.totals.pinTokens)
  assert.equal(stats.totals.recalledFolds, 1)
  assert.equal(stats.rows[0].recallCount, 1)
  assert.equal(stats.rows[0].recallTokens, 14)

  const t1 = stats.turns.find((row) => row.turn === 1)
  const t2 = stats.turns.find((row) => row.turn === 2)
  assert.equal(t1.foldCount, 1)
  assert.equal(t1.pinCount, 1)
  assert.equal(t1.recallCount, 0)
  assert.equal(t2.foldCount, 1)
  assert.equal(t2.recallCount, 1)
  assert.equal(t2.netTokens, foldCost(records[1]).savedTokens - 14)
})

test('缺 turn 的旧召回记到被召回折叠那一轮并标记估算', () => {
  const records = [
    fold('f1', 3, 'a'.repeat(400), 'b'.repeat(40)),
    { kind: 'recall', id: 'f1', at: 99 },
  ]
  const stats = buildStats({ records, config: {}, now: 1 })
  assert.equal(stats.recalls.length, 1)
  assert.equal(stats.recalls[0].turn, 3)
  assert.equal(stats.recalls[0].estimated, true)
  assert.equal(stats.recalls[0].chars, 400)
  assert.equal(stats.recalls[0].tokens, estimateTokens(['a'.repeat(400)]))
  assert.equal(stats.rows[0].recallCount, 1)
})

test('没有记录时给空账本而不是报错', () => {
  const stats = buildStats({ records: [], config: null, now: 5 })
  assert.equal(stats.ok, true)
  assert.equal(stats.totals.folds, 0)
  assert.equal(stats.totals.netTokens, 0)
  assert.equal(stats.turns.length, 0)
  assert.deepEqual(stats.current, {
    checkpointChars: 0,
    checkpointTokens: 0,
    checkpointMoney: 0,
    pinChars: 0,
    pinTokens: 0,
    pinMoney: 0,
    tokens: 0,
    money: 0,
  })
  // 空账本也要给出单价，页面不必自己兜底。
  assert.equal(stats.pricing.prices.input, 1)
  assert.equal(stats.pricing.cacheHitRate, 0.97)
})

// 金额曾经用「命中率加权均价」把两种方向相反的量压成一个价，下面几条把它钉住。
test('金额分档：折叠按命中价乘重发次数，摘要首次上行按未命中价', () => {
  const f1 = fold('f1', 1, 'a'.repeat(4000), 'b'.repeat(200), { usage: { steps: 2 } })
  const f2 = fold('f2', 2, 'x'.repeat(400), 'y'.repeat(40), { usage: { steps: 3 } })
  const stats = buildStats({ records: [f1, f2], config: {}, now: 1 })
  const c1 = foldCost(f1)
  // 第 1 轮折叠后，第 2 轮的 3 步都要重发它，按缓存命中价 0.02 计。
  assert.equal(stats.rows[0].requests, 3)
  assert.equal(stats.rows[1].requests, 0)
  assert.equal(stats.totals.savedMoney, roundMoney((c1.savedTokens * 3 * 0.02) / 1e6))
  // 摘要是新内容：第 2 轮首请求按未命中价 1 付一次；之后没有请求就不再收。
  assert.equal(stats.totals.checkpointMoney, roundMoney((c1.noteTokens * 1) / 1e6))
  assert.equal(stats.totals.netMoney, roundMoney(stats.totals.savedMoney - stats.totals.checkpointMoney))
  assert.equal(stats.pricing.steps.lastTurn, 2)
  assert.equal(stats.pricing.steps.knownTurns, 2)
})

test('目录与检索照算成本，但不算内容召回', () => {
  const records = [
    fold('f1', 1, 'a'.repeat(400), 'b'.repeat(40)),
    { kind: 'recall', id: 'f1', turn: 1, at: 10, chars: 30, tokens: 10, mode: 'index' },
    { kind: 'recall', id: 'f1', turn: 1, at: 11, chars: 40, tokens: 12, mode: 'parts' },
  ]
  const stats = buildStats({ records, config: {} })
  // 和 store.recallCount 一致：只有真的把原文读回来的那次才算召回次数。
  assert.equal(stats.rows[0].recallCount, 1)
  assert.equal(stats.rows[0].probeCount, 1)
  assert.equal(stats.totals.recalls, 1)
  assert.equal(stats.totals.probes, 1)
  // 但两者都占 token，成本照算。
  assert.equal(stats.totals.recallTokens, 22)
  assert.ok(stats.totals.recallMoney > 0)
})

test('重要消息 = 首次未命中 + 之后每步按命中价常驻', () => {
  const pinText = 'c'.repeat(100)
  const records = [
    fold('f1', 1, 'a'.repeat(400), 'b'.repeat(40), { usage: { steps: 2 } }),
    { kind: 'pin', id: 'P', turn: 1, at: 2001, text: pinText },
  ]
  const stats = buildStats({ records, config: {} })
  const row = stats.pins[0]
  // 字数与 token 用同一个字符串算：chars 以前漏了前缀与标题，和 tokens 对不上。
  const full = pinPrefix + ' P\n' + pinText
  const tokens = estimateTokens([full])
  assert.equal(row.chars, full.length)
  assert.equal(row.tokens, tokens)
  // 第 1 轮 2 步：重要消息写在轮内，之后还有半步（(2-1)/2）会重发它；轮后没有请求。
  assert.equal(row.requests, 0.5)
  assert.equal(row.pinMoney, roundMoney((tokens * 1 + tokens * 0.5 * 0.02) / 1e6))
})

test('buildStats 标记被压缩卷走的 pin，并从当前常驻里扣掉', () => {
  const records = [
    fold('f1', 1, 'a'.repeat(400), 'b'.repeat(40)),
    { kind: 'pin', id: 'P1', turn: 1, at: 2001, text: 'still here' },
    { kind: 'pin', id: 'P2', turn: 1, at: 2002, text: 'swallowed' },
  ]
  const stats = buildStats({ records, config: {}, presentPins: new Set(['P1']) })
  assert.equal(stats.totals.pins, 2)
  assert.equal(stats.totals.pinsPresent, 1)
  assert.equal(stats.totals.pinsLost, 1)
  const lost = stats.pins.find((row) => row.id === 'P2')
  assert.equal(lost.present, false)
  const kept = stats.pins.find((row) => row.id === 'P1')
  assert.equal(kept.present, true)
  // 常驻只算还看得见的 pin：否则账本会继续给模型看不到的内容计费。
  assert.equal(stats.current.pinChars, kept.chars)
  assert.equal(stats.current.pinTokens, kept.tokens)
})

test('没有 provider 回报时按平均步数补，并标记估算', () => {
  const records = [
    fold('f1', 1, 'a'.repeat(400), 'b'.repeat(40)),
    fold('f2', 2, 'x'.repeat(200), 'y'.repeat(20)),
  ]
  const stats = buildStats({ records, config: {} })
  assert.equal(stats.pricing.steps.estimated, true)
  assert.equal(stats.pricing.steps.averageSteps, 1)
  // 第 2 轮按平均 1 步补，所以第 1 轮的省下只乘 1 次。
  assert.equal(stats.rows[0].requests, 1)
  assert.equal(stats.rows[0].moneyEstimated, true)
})

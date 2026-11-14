import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStats, foldCost } from '../lib/stats.js'
import { estimateTokens } from '../lib/tokens.js'
import { pinPrefix } from '../lib/constants.js'

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
  const stats = buildStats({ records, config: { minFoldChars: 1200 }, now: 3000 })
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
  assert.deepEqual(stats.current, { checkpointChars: 0, checkpointTokens: 0, pinChars: 0, pinTokens: 0, tokens: 0 })
})

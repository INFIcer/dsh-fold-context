// 评测纯计算的测试：只喂事件与记录，不碰文件系统。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionEval, callsOfFolds, compareEvals, repeatedCallsOf, stepUsageOf } from '../lib/eval.js'

function assistant(turn, step, usage) {
  return { type: 'assistant/message', seq: turn * 100 + step, data: { turn, step, message: { role: 'assistant', content: [] }, usage } }
}

function usage(input, cacheRead, output) {
  return { inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output, totalTokens: input + cacheRead + output }
}

test('stepUsageOf 认原始字段，没有用量返回 null', () => {
  assert.deepEqual(stepUsageOf(assistant(1, 1, usage(100, 900, 50))), { turn: 1, step: 1, input: 100, cacheRead: 900, cacheWrite: 0, output: 50 })
  assert.equal(stepUsageOf({ type: 'assistant/message', data: { turn: 1, step: 1 } }), null)
  assert.equal(stepUsageOf({ type: 'assistant/message', data: { turn: 1, step: 1, usage: usage(0, 0, 0) } }), null)
})

test('buildSessionEval 汇总实测用量、命中率与金额', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    assistant(1, 1, usage(1000, 9000, 500)),
    assistant(1, 2, usage(200, 9800, 300)),
    { type: 'turn/start', data: { turn: 2 } },
    assistant(2, 1, usage(2000, 18000, 900)),
  ]
  const result = buildSessionEval({ sessionId: 's1', events, records: [], config: { priceCacheHitInput: 0.02, priceInput: 1, priceOutput: 4 } })
  assert.equal(result.turns, 2)
  assert.equal(result.steps, 3)
  assert.equal(result.inputTokens, 3200)
  assert.equal(result.cacheReadTokens, 36800)
  assert.equal(result.outputTokens, 1700)
  assert.equal(result.promptTokens, 40000)
  assert.ok(Math.abs(result.hitRate - 0.92) < 1e-9)
  // 命中 36800 * 0.02/M + 未命中 3200 * 1/M + 输出 1700 * 4/M
  const expected = (36800 * 0.02 + 3200 * 1 + 1700 * 4) / 1000000
  assert.ok(Math.abs(result.money.total - expected) < 1e-9)
  assert.equal(result.perTurn.length, 2)
  assert.equal(result.perTurn[0].steps, 2)
  assert.equal(result.perTurn[0].firstInput, 1000)
  assert.equal(result.perTurn[0].promptLast, 10000)
  assert.equal(result.contextMax, 20000)
  // 首步未命中 1000 + 2000 = 3000，占全部未命中 3200 的 93.75%。
  assert.ok(Math.abs(result.firstInputShare - 3000 / 3200) < 1e-9)
})

test('缺用量的步骤单独计数，不参与总计', () => {
  const result = buildSessionEval({
    sessionId: 's1',
    events: [{ type: 'turn/start', data: { turn: 1 } }, assistant(1, 1, usage(10, 90, 5)), { type: 'assistant/message', data: { turn: 1, step: 2 } }],
    records: [],
    config: {},
  })
  assert.equal(result.steps, 1)
  assert.equal(result.missingUsage, 1)
})

test('折叠、召回、重要消息按记录汇总', () => {
  const records = [
    { kind: 'fold', id: 'f1', turn: 1, chars: 4000, note: 'x'.repeat(120) },
    { kind: 'fold', id: 'f2', turn: 2, chars: 6000, note: 'y'.repeat(180) },
    { kind: 'recall', id: 'f1', turn: 3, chars: 400, tokens: 100, mode: 'direct' },
    { kind: 'recall', id: 'f1', turn: 4, chars: 800, tokens: 200, mode: 'parts' },
    { kind: 'recall', id: 'f2', turn: 5, chars: 200, mode: 'index' },
    { kind: 'recall', id: '', turn: 5, chars: 80, mode: 'search' },
    { kind: 'pin', id: 'p1', text: '重要结论' },
  ]
  const result = buildSessionEval({ sessionId: 's1', events: [], records, config: {} })
  assert.equal(result.folds.count, 2)
  assert.equal(result.folds.chars, 10000)
  assert.equal(result.folds.checkpointChars, 300)
  assert.equal(result.recalls.count, 4)
  assert.equal(result.recalls.modes.direct, 1)
  assert.equal(result.recalls.modes.parts, 1)
  assert.equal(result.recalls.modes.index, 1)
  assert.equal(result.recalls.modes.search, 1)
  // 缺 tokens 的两条按 chars 估：200/4+4=54，80/4+4=24。
  assert.equal(result.recalls.tokens, 100 + 200 + 54 + 24)
  assert.equal(result.recalls.repeatedRecallFolds, 1)
  assert.equal(result.pins.count, 1)
  assert.equal(result.pins.chars, 4)
})

test('跨轮重复调用只数「更早轮次出现过」的那些', () => {
  const records = [
    {
      kind: 'fold',
      id: 'f1',
      turn: 1,
      chars: 100,
      note: '',
      items: [{ seq: 1, text: '[思考] a\n[调用 run_code] {"code":"x"}\n[调用 run_code] {"code":"y"}' }],
    },
    {
      kind: 'fold',
      id: 'f2',
      turn: 2,
      chars: 100,
      note: '',
      items: [{ seq: 2, text: '[调用 run_code] {"code":"x"}\n[调用 run_code] {"code":"y"}\n[调用 run_code] {"code":"z"}' }],
    },
  ]
  const calls = callsOfFolds(records)
  assert.equal(calls.length, 5)
  // x 与 y 在第 2 轮又出现一次，z 是新的。
  assert.equal(repeatedCallsOf(calls), 2)
})

test('同一轮里重复调用不算折叠导致的遗忘', () => {
  const records = [{ kind: 'fold', id: 'f1', turn: 1, chars: 10, note: '', items: [{ seq: 1, text: '[调用 run_code] {"code":"x"}\n[调用 run_code] {"code":"x"}' }] }]
  assert.equal(repeatedCallsOf(callsOfFolds(records)), 0)
})

test('compareEvals 给差值，缺项不炸', () => {
  const a = buildSessionEval({ sessionId: 'a', events: [assistant(1, 1, usage(100, 900, 50))], records: [], config: {} })
  const b = buildSessionEval({ sessionId: 'b', events: [assistant(1, 1, usage(200, 1800, 100))], records: [], config: {} })
  const rows = compareEvals(a, b)
  const money = rows.find((row) => row.label === '合计金额')
  assert.ok(money.delta < 0)
  const steps = rows.find((row) => row.label === '步数')
  assert.equal(steps.delta, 0)
  // 缺 money 的对象（老数据）也要能比。
  const empty = { turns: 0, steps: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, money: null, recalls: null, contextMax: 0 }
  assert.doesNotThrow(() => compareEvals(empty, empty))
})

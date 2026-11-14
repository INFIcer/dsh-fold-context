// 载荷修复脚本的规则：只补「区间里有节点、载荷里没有」的那部分，补齐后不丢已有内容。
// 这段逻辑一旦错，召回会把旧的一轮悄悄换成残缺版本，所以用假日志单独覆盖。

import test from 'node:test'
import assert from 'node:assert/strict'

import { expectedSeqs, planRepair, rebuildItems } from '../tools/repair-payloads.mjs'

function assistant(seq, patch) {
  const options = patch || {}
  const content = []
  if (options.think) content.push({ type: 'reasoning', text: options.think })
  if (options.reply) content.push({ type: 'text', text: options.reply })
  for (const call of options.calls || []) {
    content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments || '{}' })
  }
  return { seq, type: 'assistant/message', data: { message: { role: 'assistant', content, source: { kind: 'model' } } } }
}

function toolResult(seq, id, text) {
  return {
    seq,
    type: 'tool/result',
    data: { message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }], source: { kind: 'tool', callId: id } } },
  }
}

function bySeqOf(events) {
  const map = new Map()
  for (const event of events) map.set(event.seq, event)
  return map
}

// 一轮的典型形状：思考 + 调用 + 工具结果 + 最终回复。
function turnLog() {
  return [
    assistant(11, { think: '先看目录', calls: [{ id: 'c1', name: 'run_code' }] }),
    toolResult(12, 'c1', '目录：lib、tests'),
    { seq: 13, type: 'turn/start', data: { turn: 3 } },
    assistant(14, { think: '现在写', reply: '改完了，测试全过' }),
  ]
}

function foldRecord(items) {
  return {
    kind: 'fold',
    id: 'f3',
    turn: 3,
    startSeq: 11,
    endSeq: 14,
    chars: 100,
    note: '【已折叠历史】 第 3 轮',
    items,
  }
}

test('expectedSeqs 只收表层节点，跳过日志事件', () => {
  const bySeq = bySeqOf(turnLog())
  assert.deepEqual(expectedSeqs(foldRecord([]), bySeq, true), [11, 12, 14])
  assert.deepEqual(expectedSeqs(foldRecord([]), bySeq, false), [11, 14])
})

test('载荷已完整时 planRepair 不动记录', () => {
  const bySeq = bySeqOf(turnLog())
  const record = foldRecord(rebuildItems(foldRecord([]), bySeq, true))
  const plan = planRepair({ records: [record], bySeq })
  assert.equal(plan.changes.length, 0)
  assert.equal(plan.records[0], record)
})

test('缺尾部节点的载荷会被补齐，最终回复回到载荷里', () => {
  const bySeq = bySeqOf(turnLog())
  // 旧载荷只留了前两个节点，最后一步与最终回复都被截掉了。
  const record = foldRecord([
    { seq: 11, text: '[思考] 先看目录\n[调用 run_code] {}' },
    { seq: 12, text: '[工具结果] 目录：lib、tests' },
  ])
  const plan = planRepair({ records: [record], bySeq })
  assert.equal(plan.changes.length, 1)
  const change = plan.changes[0]
  assert.equal(change.id, 'f3')
  assert.equal(change.missing, 1)
  assert.equal(change.before, 2)
  assert.equal(change.after, 3)
  const items = plan.records[0].items
  assert.equal(items.length, 3)
  assert.ok(items[2].text.indexOf('改完了，测试全过') >= 0)
})

test('记录里本来收了工具结果时，即使配置关掉工具输出也不丢', () => {
  const bySeq = bySeqOf(turnLog())
  const record = foldRecord([{ seq: 11, text: '[思考] 先看目录' }, { seq: 12, text: '[工具结果] 目录：lib、tests' }])
  const plan = planRepair({ records: [record], bySeq, includeToolOutputs: false })
  const seqs = plan.records[0].items.map((item) => item.seq)
  assert.ok(seqs.indexOf(12) >= 0)
})

test('配置关掉工具输出且记录里没有时，不补工具结果', () => {
  const bySeq = bySeqOf(turnLog())
  const record = foldRecord([{ seq: 11, text: '[思考] 先看目录' }])
  const plan = planRepair({ records: [record], bySeq, includeToolOutputs: false })
  const seqs = plan.records[0].items.map((item) => item.seq)
  assert.ok(seqs.indexOf(12) < 0)
  assert.ok(seqs.indexOf(14) >= 0)
})

test('非折叠记录原样透传', () => {
  const bySeq = bySeqOf(turnLog())
  const pin = { kind: 'pin', id: 'p1', text: '重要', at: 1 }
  const recall = { kind: 'recall', id: 'f2', at: 2 }
  const plan = planRepair({ records: [pin, recall], bySeq })
  assert.deepEqual(plan.records, [pin, recall])
  assert.equal(plan.changes.length, 0)
})

test('区间里找不到任何事件时保持原样', () => {
  const record = foldRecord([{ seq: 11, text: '[思考] 先看目录' }])
  const plan = planRepair({ records: [record], bySeq: new Map() })
  assert.equal(plan.changes.length, 0)
  assert.equal(plan.records[0], record)
})
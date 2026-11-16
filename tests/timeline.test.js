// 时间线：按事件重放 surface，压缩/折叠处要留下台阶。
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTimeline } from '../lib/timeline.js'

function textMessage(seq, type, role, text, extra = {}) {
  const message = { id: 'm' + seq, role, content: [{ type: 'text', text }], source: { kind: 'user' } }
  if (role === 'assistant') message.source = { kind: 'model' }
  if (role === 'system') message.source = { kind: 'system-prompt' }
  return Object.assign({ type, seq, data: { message } }, extra)
}
function userMessage(seq, text, extra = {}) {
  return Object.assign({ type: 'user/message', seq, data: { id: 'u' + seq, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }, extra)
}

test('压缩点让折叠/不折叠两条趋势都掉一个台阶', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    textMessage(2, 'system/message', 'system', 's'.repeat(400)),
    userMessage(3, 'u'.repeat(400)),
    textMessage(4, 'assistant/message', 'assistant', 'a'.repeat(400)),
    { type: 'turn/end', seq: 5, data: { turn: 1 } },
    // 压缩：把 3、4 换成一条摘要。
    userMessage(6, '【压缩摘要】', {
      data: { id: 'c1', role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'sum'.repeat(20) }] },
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
    }),
    { type: 'turn/start', seq: 7, data: { turn: 2 } },
    userMessage(8, '继续'),
    textMessage(9, 'assistant/message', 'assistant', 'ok'),
    { type: 'turn/end', seq: 10, data: { turn: 2 } },
  ]
  const timeline = buildTimeline({ events, folds: new Map() })
  const labels = timeline.points.map((point) => point.label)
  assert.ok(labels.includes('T1'))
  assert.ok(labels.includes('C1'))
  assert.ok(labels.includes('T2'))
  const t1 = timeline.points.find((point) => point.label === 'T1')
  const c1 = timeline.points.find((point) => point.label === 'C1')
  assert.ok(c1.tokensTotals.folded < t1.tokensTotals.folded, '压缩后应低于压缩前')
  // 没折叠：两条视角相等；压缩切掉的内容两边都不还原。
  assert.equal(timeline.totals.tokens.sum.folded, timeline.totals.tokens.sum.unfolded)
})

test('折叠检查点在折叠视角变小，不折叠视角按原文还原', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    userMessage(2, '开始'),
    textMessage(3, 'assistant/message', 'assistant', 'r'.repeat(4000)),
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    userMessage(5, '【已折叠历史】f1', {
      data: { id: 'f1', role: 'user', source: { kind: 'fold-checkpoint', foldId: 'f1' }, content: [{ type: 'text', text: '【已折叠历史】f1' }] },
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
    }),
    { type: 'turn/start', seq: 6, data: { turn: 2 } },
    userMessage(7, '继续'),
    { type: 'turn/end', seq: 8, data: { turn: 2 } },
  ]
  // 真实载荷形状：items 是 {seq, text}（不是已切好的 blocks）。
  const folds = new Map([['f1', { kind: 'fold', id: 'f1', turn: 1, chars: 4000, items: [{ seq: 3, text: '[回复] ' + 'r'.repeat(4000) }] }]])
  const timeline = buildTimeline({ events, folds })
  assert.ok(timeline.totals.tokens.sum.folded < timeline.totals.tokens.sum.unfolded)
  const f1 = timeline.points.find((point) => point.label === 'F1')
  assert.ok(f1, '折叠事件应留下一个点')
  // 折叠视角留「折叠摘要」一档；不折叠视角还原成「思考与回复」。
  assert.ok(f1.tokensTotals.folded > 0)
  const lastFolded = timeline.totals.tokens.folded
  const lastUnfolded = timeline.totals.tokens.unfolded
  assert.equal(Math.round(lastFolded.checkpoint), 11, '检查点消息本身很小（9 字：ceil(9/4)+4+4）')
  assert.ok(lastUnfolded.assistant > 900, '原文还原到助手档：' + lastUnfolded.assistant)
  assert.equal(Math.round(lastUnfolded.checkpoint), 0)
})

test('系统提示只算最后一条，不落进注入档', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    textMessage(2, 'system/message', 'system', 'a'.repeat(400)),
    userMessage(3, '开始'),
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    // 新的系统提示版本追加进来；请求只带最后一条。
    textMessage(5, 'system/message', 'system', 'b'.repeat(800)),
    { type: 'turn/end', seq: 6, data: { turn: 1 } },
  ]
  const timeline = buildTimeline({ events, folds: new Map() })
  const last = timeline.totals.tokens.folded
  assert.equal(Math.round(last.system), 204, '当前系统提示按整段一次 ceil+4：ceil(800/4)+4')
  assert.equal(Math.round(last.inject), 0, '系统提示不再落进注入档')
  // 合计 = 当前系统 + 用户消息（开始 = ceil(2/4)+4+4 = 9）。
  assert.equal(Math.round(timeline.totals.tokens.sum.folded), 204 + 9)
})

test('系统提示节点被压缩卷走后，请求里仍然带着它', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    textMessage(2, 'system/message', 'system', 's'.repeat(800)),
    userMessage(3, '开始'),
    textMessage(4, 'assistant/message', 'assistant', '答'.repeat(200)),
    { type: 'turn/end', seq: 5, data: { turn: 1 } },
    // 压缩把系统提示和第一轮一起卷走。
    userMessage(6, '【压缩摘要】', {
      data: { id: 'c1', role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'sum'.repeat(20) }] },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 },
    }),
    { type: 'turn/end', seq: 7, data: { turn: 1 } },
  ]
  const timeline = buildTimeline({ events, folds: new Map() })
  assert.equal(Math.round(timeline.totals.tokens.folded.system), 204, '压缩后系统提示仍计入请求')
})

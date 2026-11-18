// 全量历史账本：压缩之后，之前各轮的账不能被一起卷走。
//
// 这里直接铺事件（和会话日志同形状），不依赖宿主：turn/start 标轮次，surface 事件进上下文，
// surfaceOp=replace 表示「这段被换掉了」（折叠检查点和压缩都是这个形状）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildHistoryGroups } from '../lib/history.js'

function textBlock(text) {
  return { type: 'text', text }
}

function messageEvent(seq, role, text, extra = {}) {
  const message = { role, content: [textBlock(text)] }
  if (extra.source) message.source = extra.source
  return Object.assign({ type: role === 'system' ? 'system/message' : 'assistant/message', seq, data: { message } }, extra.event || {})
}

function userEvent(seq, text, extra = {}) {
  const message = { role: 'user', content: [textBlock(text)] }
  if (extra.source) message.source = extra.source
  return Object.assign({ type: 'user/message', seq, data: message }, extra.event || {})
}

function assistantEvent(seq, text) {
  return messageEvent(seq, 'assistant', text)
}

function systemEvent(seq, text) {
  return { type: 'system/message', seq, data: { message: { role: 'system', content: [textBlock(text)] } } }
}

function turnStart(seq, turn) {
  return { type: 'turn/start', seq, data: { turn } }
}

function stepStart(seq, turn) {
  return { type: 'step/start', seq, data: { turn } }
}

function byTurn(groups) {
  const map = new Map()
  for (const group of groups) map.set(group.turn, group)
  return map
}

test('history: 普通轮次按步计数，基准逐轮累积', () => {
  const events = [
    turnStart(1, 1),
    systemEvent(2, 'S'.repeat(40)),
    userEvent(3, '用户原话'),
    stepStart(4, 1),
    assistantEvent(5, 'A'.repeat(20)),
    stepStart(6, 1),
    assistantEvent(7, 'B'.repeat(20)),
    turnStart(8, 2),
    stepStart(9, 2),
    assistantEvent(10, 'C'.repeat(10)),
  ]
  const groups = buildHistoryGroups({ events, folds: new Map() })
  const map = byTurn(groups)
  const first = map.get(1)
  const second = map.get(2)
  assert.equal(first.steps, 2, '两次 step/start 就这两步')
  assert.equal(first.folded, false)
  assert.equal(first.chars, first.unfoldedChars, '没折过的轮次两种视角一样大')
  assert.equal(first.chars, '用户原话'.length + 40, '上一轮 = 用户原话 + 两条助手消息')
  assert.equal(second.baseFoldedChars, 40 + first.chars, '基准 = 系统提示 + 之前各轮')
})

test('history: 折叠轮只留检查点，不折叠视角保留原文', () => {
  const originals = 'X'.repeat(200) + 'Y'.repeat(100)
  const folds = new Map([
    ['f1', { kind: 'fold', id: 'f1', turn: 1, items: [{ seq: 5, text: originals }] }],
  ])
  const events = [
    turnStart(1, 1),
    systemEvent(2, 'S'.repeat(20)),
    userEvent(3, '问题'),
    stepStart(4, 1),
    assistantEvent(5, 'X'.repeat(200)),
    assistantEvent(6, 'Y'.repeat(100)),
    // 轮末折叠：把两条助手消息换成一条检查点
    userEvent(7, '摘要', { source: { kind: 'fold-checkpoint', foldId: 'f1' }, event: { surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 } } }),
    turnStart(8, 2),
    assistantEvent(9, '下一轮'),
  ]
  const groups = buildHistoryGroups({ events, folds })
  const first = byTurn(groups).get(1)
  assert.equal(first.folded, true)
  assert.equal(first.checkpointChars, '摘要'.length)
  assert.equal(first.chars, '问题'.length + '摘要'.length, '折叠后只剩用户原话 + 检查点')
  assert.equal(first.unfoldedChars, '问题'.length + 300, '不折叠视角 = 用户原话 + 原文')
  const second = byTurn(groups).get(2)
  assert.equal(second.baseFoldedChars, 20 + first.chars)
  assert.equal(second.baseUnfoldedChars, 20 + first.unfoldedChars)
})

test('history: 压缩换掉旧轮之后，旧轮的账还在，新轮基准变小', () => {
  const folds = new Map([
    ['f1', { kind: 'fold', id: 'f1', turn: 1, items: [{ seq: 5, text: 'Z'.repeat(400) }] }],
  ])
  const events = [
    turnStart(1, 1),
    systemEvent(2, 'S'.repeat(20)),
    userEvent(3, '第一问'),
    stepStart(4, 1),
    assistantEvent(5, 'Z'.repeat(400)),
    userEvent(6, '摘要一', { source: { kind: 'fold-checkpoint', foldId: 'f1' }, event: { surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 } } }),
    turnStart(7, 2),
    userEvent(8, '第二问'),
    assistantEvent(9, 'W'.repeat(50)),
    // 官方压缩：把前两轮整段换成一条摘要
    userEvent(10, '压缩摘要', { source: { kind: 'compact-checkpoint', compactionId: 'c1' }, event: { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 9 } } }),
    turnStart(11, 3),
    assistantEvent(12, '第三轮的回复'),
  ]
  const groups = buildHistoryGroups({ events, folds })
  const map = byTurn(groups)
  const first = map.get(1)
  const second = map.get(2)
  const third = map.get(3)
  // 前两轮的账已按当时的基准结算，压缩不能把它们清零。
  assert.ok(first.chars > 0, '被压缩卷走的第一轮仍要有字符数')
  assert.ok(second.chars > 0)
  // 第三轮的基准跟着压缩台阶下降：只剩系统提示 + 压缩摘要。
  assert.equal(third.baseFoldedChars, 20 + '压缩摘要'.length)
  assert.equal(third.baseUnfoldedChars, 20 + '压缩摘要'.length)
  assert.ok(third.baseFoldedChars < second.baseFoldedChars + second.chars)
})

test('history: 折叠轮被压缩卷走后，不折叠视角仍按原文计', () => {
  const folds = new Map([
    ['f1', { kind: 'fold', id: 'f1', turn: 1, items: [{ seq: 4, text: 'Q'.repeat(500) }] }],
  ])
  const events = [
    turnStart(1, 1),
    systemEvent(2, 'S'.repeat(20)),
    userEvent(3, '问'),
    assistantEvent(4, 'Q'.repeat(500)),
    userEvent(5, '摘要一', { source: { kind: 'fold-checkpoint', foldId: 'f1' }, event: { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } } }),
    turnStart(6, 2),
    userEvent(7, '摘要二', { source: { kind: 'compact-checkpoint', compactionId: 'c1' }, event: { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 5 } } }),
    assistantEvent(8, '第二轮'),
  ]
  const groups = buildHistoryGroups({ events, folds })
  const first = byTurn(groups).get(1)
  assert.equal(first.folded, true, '这一轮确实折过')
  assert.ok(first.chars > 0, '整轮被压缩卷走也不能记成 0')
  assert.equal(first.unfoldedChars, '问'.length + 500)
})

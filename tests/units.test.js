// 纯逻辑与落账的单元测试：不依赖宿主，直接喂假 session。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildNote, isKeeper, recallItems, statsOf, totalChars } from '../lib/fold-text.js'
import { planSegments } from '../lib/plan.js'
import { foldTurn, publishPin } from '../lib/commit.js'
import { FoldStore, safeFileName } from '../lib/store.js'
import { normalizeConfig, defaultConfig } from '../lib/config.js'
import { FakeSession, assistantNode, toolNode, userNode } from './fakes.js'

const silent = { info() {}, warn() {}, error() {} }

test('statsOf 只统计思考、回复与工具输出', () => {
  const nodes = [
    assistantNode(2, { reasoning: '想'.repeat(10), text: '答'.repeat(5), calls: [{ id: 'c1', name: 'read' }] }),
    toolNode(3, 'c1', '果'.repeat(7)),
  ]
  const stats = statsOf(nodes)
  assert.equal(stats.reasoningChars, 10)
  assert.equal(stats.replyChars, 5)
  assert.equal(stats.toolChars, 7)
  assert.equal(stats.thinkBlocks, 1)
  assert.deepEqual(stats.callNames, ['read'])
  assert.equal(totalChars(stats), 22)
})

test('buildNote 带上编号与召回入口，且不超过上限', () => {
  const stats = statsOf([assistantNode(2, { reasoning: 'x'.repeat(300), text: 'y'.repeat(80) })])
  const note = buildNote({ foldId: 'f7', turn: 7, stats, maxChars: 200, toolName: 'fold_recall' })
  assert.ok(note.startsWith('【已折叠历史】'))
  assert.ok(note.includes('f7'))
  assert.ok(note.includes('fold_recall'))
  assert.ok(note.length <= 200)
})

test('isKeeper 只放行用户原话、重要消息与上一次摘要', () => {
  assert.equal(isKeeper(userNode(1, 'hi', 'user')), true)
  assert.equal(isKeeper(userNode(1, 'hi', 'fold-pin')), true)
  assert.equal(isKeeper(userNode(1, 'hi', 'fold-checkpoint')), true)
  assert.equal(isKeeper(userNode(1, 'hi', 'runtime-context')), false)
})

test('planSegments 在用户消息处断开，且片段总从 assistant 开始', () => {
  const nodes = [
    userNode(1, '开始', 'user'),
    assistantNode(2, { calls: [{ id: 'c1', name: 'read' }] }),
    toolNode(3, 'c1', '内容'),
    userNode(4, '补充要求', 'user'),
    assistantNode(5, { calls: [{ id: 'c2', name: 'edit' }] }),
    toolNode(6, 'c2', 'ok'),
  ]
  const segments = planSegments(nodes)
  assert.equal(segments.length, 2)
  assert.deepEqual(segments[0].map((n) => n.seq), [2, 3])
  assert.deepEqual(segments[1].map((n) => n.seq), [5, 6])
})

test('planSegments 丢掉没走完的那一步，不把调用和结果切开', () => {
  const nodes = [
    assistantNode(1, { calls: [{ id: 'c1', name: 'read' }] }),
    toolNode(2, 'c1', '有结果'),
    assistantNode(3, { calls: [{ id: 'c2', name: 'bash' }] }),
  ]
  const segments = planSegments(nodes)
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0].map((n) => n.seq), [1, 2])
})

test('runtime-context 注入跟着片段一起折叠，fold-pin 则切断片段', () => {
  const nodes = [
    assistantNode(1, { text: 'a' }),
    userNode(2, '注入的上下文', 'runtime-context'),
    assistantNode(3, { text: 'b' }),
    userNode(4, '重要结论', 'fold-pin'),
    assistantNode(5, { text: 'c' }),
  ]
  const segments = planSegments(nodes)
  assert.deepEqual(segments[0].map((n) => n.seq), [1, 2, 3])
  assert.deepEqual(segments[1].map((n) => n.seq), [5])
})

test('foldTurn 折叠够长的一轮，并留下可召回的载荷', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-a')
  const nodes = [
    userNode(1, '帮我改代码', 'user'),
    assistantNode(2, { reasoning: '思'.repeat(800), calls: [{ id: 'c1', name: 'read' }] }),
    toolNode(3, 'c1', '果'.repeat(600)),
  ]
  session.seed(nodes)
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const config = normalizeConfig({ minFoldChars: 1200 })

  const result = foldTurn({ session, turn: 1, nodes, config, store, log: silent })
  assert.equal(result.folded, 1)
  assert.deepEqual(result.ids, ['f1'])

  const checkpoint = session.events.at(-1)
  assert.equal(checkpoint.type, 'user/message')
  assert.equal(checkpoint.data.source.kind, 'fold-checkpoint')
  assert.equal(checkpoint.data.source.foldId, 'f1')
  assert.equal(checkpoint.surfaceOp.op, 'replace')
  assert.deepEqual(session.nodes, [1, checkpoint.seq])

  const record = store.findFold('f1')
  assert.ok(record)
  assert.equal(record.chars, 1400)
  assert.ok(record.items.some((item) => item.text.includes('思')))
})

test('foldTurn 对短回合与关闭开关都不动手', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-b')
  const nodes = [userNode(1, 'hi', 'user'), assistantNode(2, { text: '短回复' })]
  session.seed(nodes)
  const store = new FoldStore({ homeDir, sessionId: session.id })

  const short = foldTurn({ session, turn: 1, nodes, config: normalizeConfig({ minFoldChars: 1200 }), store, log: silent })
  assert.equal(short.folded, 0)

  const off = foldTurn({ session, turn: 1, nodes, config: normalizeConfig({ enabled: false }), store, log: silent })
  assert.equal(off.folded, 0)
  assert.equal(session.events.length, 0)
})

test('publishPin 受条数与预算约束，成功时写成 fold-pin 消息', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-c')
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const config = normalizeConfig({ maxPins: 1, pinBudgetChars: 5000 })

  const first = publishPin({ session, label: '部署路径', text: '在 E:\\x', config, store, log: silent })
  assert.equal(first.ok, true)
  const message = session.events.at(-1)
  assert.equal(message.data.source.kind, 'fold-pin')
  assert.ok(message.data.content[0].text.includes('【重要·永不折叠】'))

  const second = publishPin({ session, label: '再多一条', text: '内容', config, store, log: silent })
  assert.equal(second.ok, false)
  assert.ok(second.reason.includes('上限'))
})

test('FoldStore 忽略半行、按会话隔离、能统计召回次数', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const store = new FoldStore({ homeDir, sessionId: 'a/b c' })
  assert.ok(safeFileName('a/b c').includes('a_b_c'))
  store.append({ kind: 'fold', id: 'f1', turn: 1, chars: 2000, items: [] })
  store.appendRecall('f1')
  store.appendRecall('f1')
  assert.equal(store.recallCount('f1'), 2)
  const raw = readFileSync(store.filePath, 'utf8') + '{broken\n'
  assert.equal(raw.includes('broken'), true)
  assert.equal(store.readAll().length, 3)
})

test('recallItems 按预算截断', () => {
  const items = recallItems([assistantNode(1, { text: 'x'.repeat(500) })], 100)
  assert.equal(items.length, 1)
  assert.ok(items[0].text.length <= 101)
})

test('normalizeConfig 把越界值钳进合法区间', () => {
  const config = normalizeConfig({ minFoldChars: 1, maxPins: 999 })
  assert.equal(config.minFoldChars, 200)
  assert.equal(config.maxPins, 200)
  assert.equal(defaultConfig().enabled, true)
})

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
import {
  ConfigStore,
  defaultConfig,
  defaultRecallReminderText,
  normalizeConfig,
  noteBudget,
  validateConfigPatch,
} from '../lib/config.js'
import { promptSection, systemPromptText } from '../lib/prompt.js'
import { recallReminder, registerTools } from '../lib/tools.js'
import { FakeSession, assistantNode, makeCtx, toolNode, userNode } from './fakes.js'

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
  // 调度提醒和运行时注入都是上下文，不是用户此刻说的话：折掉后仍能召回，下一轮还会重新注入。
  assert.equal(isKeeper(userNode(1, 'hi', 'schedule')), false)
  assert.equal(isKeeper(userNode(1, 'hi', 'runtime-context')), false)
})

test('planSegments 在用户消息处断开，片段从第一条非 keeper 消息开始', () => {
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

test('每轮开头的运行时注入自己开一个片段，不再永久留在上下文里', () => {
  const nodes = [
    userNode(1, '这次会话的上下文', 'runtime-context'),
    assistantNode(2, { text: 'a' }),
    toolNode(3, 'c1', '结果'),
  ]
  const segments = planSegments(nodes)
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0].map((n) => n.seq), [1, 2, 3])
})

test('调度提醒也当上下文折叠', () => {
  const nodes = [userNode(1, '重启完成', 'schedule'), assistantNode(2, { text: 'a' })]
  const segments = planSegments(nodes)
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

test('normalizeConfig 覆盖新增字段的钳制与类型守卫', () => {
  const low = normalizeConfig({
    noteRatio: 0.001,
    maxNoteChars: 10,
    recallReminderAfter: 0,
    maxFoldsPerTurn: 99,
    promptOrder: -5000,
    foldToolOutputs: 'no',
  })
  assert.equal(low.noteRatio, 0.02)
  assert.equal(low.maxNoteChars, 80)
  assert.equal(low.recallReminderAfter, 1)
  assert.equal(low.maxFoldsPerTurn, 32)
  assert.equal(low.promptOrder, -1000)
  assert.equal(low.foldToolOutputs, true, '类型不对时保留原值')

  const high = normalizeConfig({ noteRatio: 0.99, maxNoteChars: 99999, promptOrder: 99999 })
  assert.equal(high.noteRatio, 0.5)
  assert.equal(high.maxNoteChars, 4000)
  assert.equal(high.promptOrder, 10000)
})

test('normalizeConfig 忽略未知键并回调 warn', () => {
  const warnings = []
  const config = normalizeConfig({ bogus: 1, minFoldChars: 300 }, defaultConfig(), (message) => warnings.push(message))
  assert.equal(config.minFoldChars, 300)
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'bogus'), false)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('bogus'))
  assert.ok(warnings[0].includes('已忽略'))
})

test('noteBudget 按比例计算，并受 80 与 maxNoteChars 两头夹住', () => {
  assert.equal(noteBudget(100000, normalizeConfig({})), 320)
  assert.equal(noteBudget(2000, normalizeConfig({ noteRatio: 0.1, maxNoteChars: 320 })), 200)
  assert.equal(noteBudget(1000, normalizeConfig({ noteRatio: 0.05 })), 80)
  assert.equal(noteBudget(5000, normalizeConfig({ noteRatio: 0.5, maxNoteChars: 2000 })), 2000)
})

test('ConfigStore 落盘后能被下一次 load 读到，文件覆盖 profile 配置', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const store = new ConfigStore({ homeDir, log: silent })
  store.load({ minFoldChars: 900 })
  assert.equal(store.get().minFoldChars, 900)

  const saved = store.save({ noteRatio: 0.2 })
  assert.equal(saved.noteRatio, 0.2)
  const raw = JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8'))
  assert.equal(raw.noteRatio, 0.2)
  assert.equal(raw.minFoldChars, 900)

  const again = new ConfigStore({ homeDir, log: silent })
  const loaded = again.load({ minFoldChars: 300 })
  assert.equal(loaded.minFoldChars, 900, '文件里的值优先')
  assert.equal(loaded.noteRatio, 0.2)
})

test('validateConfigPatch 只收白名单键，且逐项拒绝非法值', () => {
  const ok = validateConfigPatch({ noteRatio: 0.2, foldToolOutputs: false })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.patch, { noteRatio: 0.2, foldToolOutputs: false })

  const unknown = validateConfigPatch({ nope: 1 })
  assert.equal(unknown.ok, false)
  assert.ok(unknown.errors.join(' ').includes('未知配置项 nope'))

  const range = validateConfigPatch({ noteRatio: 1 })
  assert.equal(range.ok, false)
  assert.ok(range.errors.join(' ').includes('0.02~0.5'))

  const integer = validateConfigPatch({ maxFoldsPerTurn: 2.5 })
  assert.equal(integer.ok, false)
  assert.ok(integer.errors.join(' ').includes('整数'))

  assert.equal(validateConfigPatch({}).ok, false)
  assert.equal(validateConfigPatch(null).ok, false)
})

test('systemPromptText 支持占位替换与自定义文案', () => {
  const text = systemPromptText(defaultConfig())
  assert.equal(text.includes('{{'), false)
  assert.ok(text.includes('fold_recall'))
  assert.ok(text.includes('fold_pin'))
  assert.ok(text.includes('fold_config'))
  assert.ok(text.includes('10%'))

  const custom = systemPromptText({ noteRatio: 0.25, systemPromptText: '召回 {{recallTool}}，固化 {{pinTool}}，比率 {{ratio}}，调 {{configTool}}，未知 {{keep}}' })
  assert.ok(custom.includes('召回 fold_recall'))
  assert.ok(custom.includes('25%'))
  assert.ok(custom.includes('{{keep}}'), '未知占位原样保留')
  assert.equal(systemPromptText({ systemPromptText: '' }), '')
})

test('promptSection 用配置里的 order，默认 order 是 300', () => {
  const fallback = promptSection(defaultConfig())
  assert.equal(fallback.name, 'fold-compression')
  assert.equal(fallback.order, 300)
  assert.equal(fallback.interpolate, false)
  const moved = promptSection(normalizeConfig({ promptOrder: 120 }))
  assert.equal(moved.order, 120)
})

test('recallReminder 支持阈值与自定义文案占位', () => {
  assert.equal(recallReminder(3, 3), '')
  const text = recallReminder(4, 3)
  assert.equal(defaultRecallReminderText.length > 0, true)
  assert.ok(text.includes('4 次'))
  assert.ok(text.includes('fold_pin'))
  assert.equal(recallReminder(4, 3, '召回 {count} 次就用 {tool}'), '召回 4 次就用 fold_pin')
  assert.equal(recallReminder(9, 3, ''), '')
})

test('foldToolOutputs=false 时摘要、体量与召回载荷都不含工具输出', () => {
  const stats = statsOf([
    assistantNode(1, { reasoning: 'x'.repeat(300), text: 'y'.repeat(100), calls: [{ id: 'c1', name: 'read' }] }),
    toolNode(2, 'c1', 'z'.repeat(500)),
  ])
  assert.equal(totalChars(stats), 900)
  assert.equal(totalChars(stats, false), 400)
  const note = buildNote({ foldId: 'f1', turn: 1, stats, maxChars: 300, toolName: 'fold_recall', includeToolOutputs: false })
  assert.equal(note.includes('工具输出'), false)
  const items = recallItems([toolNode(3, 'c1', '秘密')], 1000, false)
  assert.equal(items.length, 0)

  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-no-tools')
  const nodes = [
    userNode(1, '开始', 'user'),
    assistantNode(2, { reasoning: '思'.repeat(800), calls: [{ id: 'c1', name: 'read' }] }),
    toolNode(3, 'c1', '果'.repeat(600)),
  ]
  session.seed(nodes)
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const result = foldTurn({
    session,
    turn: 1,
    nodes,
    config: normalizeConfig({ minFoldChars: 1200, foldToolOutputs: false }),
    store,
    log: silent,
  })
  assert.equal(result.folded, 0, '只算思考的 800 字，不到阈值')
})

test('foldTurn 用 maxFoldsPerTurn 限制每轮折几段', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-limit')
  const nodes = [
    userNode(1, '一', 'user'),
    assistantNode(2, { reasoning: 'a'.repeat(300) }),
    userNode(3, '二', 'user'),
    assistantNode(4, { reasoning: 'b'.repeat(300) }),
    userNode(5, '三', 'user'),
    assistantNode(6, { reasoning: 'c'.repeat(300) }),
  ]
  session.seed(nodes)
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const result = foldTurn({
    session,
    turn: 1,
    nodes,
    config: normalizeConfig({ minFoldChars: 200, maxFoldsPerTurn: 2 }),
    store,
    log: silent,
  })
  assert.equal(result.folded, 2)
  assert.deepEqual(result.ids, ['f1a', 'f1b'])
})

test('fold_config 支持 get/set/reset，并拒绝非法键', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const configStore = new ConfigStore({ homeDir, log: silent })
  configStore.load({})
  const ctx = makeCtx()
  const updates = []
  registerTools({
    ctx,
    getStore: () => undefined,
    getConfig: () => configStore.get(),
    resolveSession: () => undefined,
    log: silent,
    homeDir,
    updateConfig: (patch) => {
      updates.push(patch)
      return configStore.save(patch)
    },
  })
  const tool = ctx.registrations.find((item) => item.name === 'fold_config')
  assert.ok(tool, 'fold_config 应当已注册')

  const got = await tool.execute({ action: 'get' }, {})
  assert.equal(got.ok, true)
  assert.ok(got.text.includes('noteRatio'))
  assert.ok(got.text.includes('0.02~0.5'))
  assert.equal(got.config.noteRatio, 0.1)
  assert.equal(got.filePath, join(homeDir, 'fold-config.json'))

  const set = await tool.execute({ action: 'set', patch: { noteRatio: 0.2 } }, {})
  assert.equal(set.ok, true)
  assert.equal(updates.length, 1)
  assert.equal(configStore.get().noteRatio, 0.2)
  assert.equal(JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8')).noteRatio, 0.2)

  const badKey = await tool.execute({ action: 'set', patch: { nope: 1 } }, {})
  assert.equal(badKey.ok, false)
  assert.ok(badKey.text.includes('未知配置项 nope'))
  assert.equal(updates.length, 1, '非法 patch 不能触发热更新')
  assert.equal(configStore.get().noteRatio, 0.2)

  const badRange = await tool.execute({ action: 'set', patch: { noteRatio: 9 } }, {})
  assert.equal(badRange.ok, false)
  assert.ok(badRange.text.includes('0.02~0.5'))

  const reset = await tool.execute({ action: 'reset' }, {})
  assert.equal(reset.ok, true)
  assert.equal(configStore.get().noteRatio, 0.1)
  assert.equal(JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8')).noteRatio, 0.1)
})


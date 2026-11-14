// 纯逻辑与落账的单元测试：不依赖宿主，直接喂假 session。

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildNote, filesOfToolCall, isKeeper, noteFilesLine, recallItems, shortPath, statsOf, totalChars } from '../lib/fold-text.js'
import { planSegments } from '../lib/plan.js'
import { foldTurn, publishPin } from '../lib/commit.js'
import { FoldStore, safeFileName } from '../lib/store.js'
import {
  ConfigStore,
  defaultConfig,
  defaultRecallReminderText,
  normalizeConfig,
  noteChars,
  validateConfigPatch,
} from '../lib/config.js'
import { promptSection, systemPromptText } from '../lib/prompt.js'
import { moneyOf, pricesOf, roundMoney, yuanOf } from '../lib/pricing.js'
import {
  matchFoldPartNumbers,
  normalizeQuery,
  renderSearchResults,
  searchFolds,
} from '../lib/recall.js'
import { recallReminder, registerTools } from '../lib/tools.js'
import { TurnTracker } from '../lib/turn-tracker.js'
import { FakeSession, assistantNode, eventOf, makeCtx, toolNode, userNode } from './fakes.js'

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

test('buildNote 带上编号与召回入口，短回复整段保留', () => {
  const stats = statsOf([assistantNode(2, { reasoning: 'x'.repeat(300), text: 'y'.repeat(80) })])
  const note = buildNote({ foldId: 'f7', turn: 7, stats, maxTokens: 50, toolName: 'fold_recall' })
  assert.ok(note.startsWith('【已折叠历史】'))
  assert.ok(note.includes('f7'))
  assert.ok(note.includes('fold_recall'))
  // 回复 80 字、上限 200：整段原样保留一次，不拆成开头+结尾。
  assert.ok(note.includes('y'.repeat(80)), note)
  assert.ok(!note.includes('结尾'), note)
})

test('回复超过上限才拆成开头+结尾，且预览合计不超上限', () => {
  const stats = statsOf([assistantNode(2, { reasoning: 'x'.repeat(300), text: 'y'.repeat(400) })])
  const note = buildNote({ foldId: 'f8', turn: 8, stats, maxTokens: 50, toolName: 'fold_recall' })
  const match = note.match(/开头「([^」]*)…」，结尾「…([^」]*)」/)
  assert.ok(match, note)
  assert.ok(match[1].length + match[2].length <= 200, note)
  assert.ok(match[1].length > match[2].length, '开头分到约 3/4 的篇幅')
})

test('maxNoteTokens 调大后预览随之变长，且不重复展示', () => {
  const stats = statsOf([assistantNode(2, { reasoning: 'x'.repeat(300), text: 'y'.repeat(500) })])
  const small = buildNote({ foldId: 'f9', turn: 9, stats, maxTokens: 20, toolName: 'fold_recall' })
  const large = buildNote({ foldId: 'f9', turn: 9, stats, maxTokens: 150, toolName: 'fold_recall' })
  const preview = (note) => {
    const m = note.match(/· 回复(?:约 500 字(?:（≈\d+ token）)?)?：([\s\S]*)$/)
    if (m) return m[1]
    const mm = note.match(/开头「([^」]*)…」，结尾「…([^」]*)」/)
    return mm ? mm[1] + mm[2] : ''
  }
  assert.ok(preview(small).length <= 80, small)
  // 600 上限大于回复本身：整段原样保留，且不再标字数（标了像被截断过）。
  assert.equal(preview(large), 'y'.repeat(500))
  assert.ok(!large.includes('回复约'), large)
})

test('isKeeper 只放行用户原话、重要消息与上一次摘要', () => {
  assert.equal(isKeeper(userNode(1, 'hi', 'user')), true)
  assert.equal(isKeeper(userNode(1, 'hi', 'fold-pin')), true)
  assert.equal(isKeeper(userNode(1, 'hi', 'fold-checkpoint')), true)
  // 官方压缩的检查点也是一次摘要：再折一次模型就看不见「哪段被压过」了。
  assert.equal(isKeeper(userNode(1, 'hi', 'compact-checkpoint')), true)
  // 调度器投递的是用户指令：折掉等于吞掉用户要求，所以和用户原话一样保留。
  assert.equal(isKeeper(userNode(1, 'hi', 'schedule')), true)
  // 运行时注入是上下文，下一轮会重新注入最新的一份。
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

test('调度指令是 keeper，不进入折叠片段', () => {
  const nodes = [userNode(1, '重启完成', 'schedule'), assistantNode(2, { text: 'a' })]
  const segments = planSegments(nodes)
  assert.deepEqual(segments[0].map((n) => n.seq), [2])
})

test('system/message 在片段之间断开，不会被替换区间扫掉', () => {
  const systemNode = { type: 'system/message', seq: 2, data: { message: { role: 'system', content: [{ type: 'text', text: '新版提示词' }] } } }
  const nodes = [assistantNode(1, { text: 'x'.repeat(300) }), systemNode, assistantNode(3, { text: 'y'.repeat(300) })]
  const segments = planSegments(nodes)
  assert.equal(segments.length, 2)
  assert.deepEqual(segments[0].map((n) => n.seq), [1])
  assert.deepEqual(segments[1].map((n) => n.seq), [3])
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
  const config = normalizeConfig({ minFoldTokens: 300 })

  const result = foldTurn({
    session,
    turn: 1,
    nodes,
    usage: { inputTokens: 1200, cacheReadTokens: 8000, outputTokens: 300 },
    config,
    store,
    log: silent,
  })
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
  assert.deepEqual(record.usage, { steps: 1, input: 1200, cacheRead: 8000, cacheWrite: 0, output: 300 })
  assert.ok(record.items.some((item) => item.text.includes('思')))
})

test('foldTurn 对短回合与关闭开关都不动手', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-b')
  const nodes = [userNode(1, 'hi', 'user'), assistantNode(2, { text: '短回复' })]
  session.seed(nodes)
  const store = new FoldStore({ homeDir, sessionId: session.id })

  const short = foldTurn({ session, turn: 1, nodes, config: normalizeConfig({ minFoldTokens: 300 }), store, log: silent })
  assert.equal(short.folded, 0)

  const off = foldTurn({ session, turn: 1, nodes, config: normalizeConfig({ enabled: false }), store, log: silent })
  assert.equal(off.folded, 0)
  assert.equal(session.events.length, 0)
})

test('TurnTracker 累加每步 provider 回报，snapshot 一并交出并清空', () => {
  const tracker = new TurnTracker()
  tracker.observe(eventOf('turn/start', { turn: 2 }, 1))
  tracker.observe(eventOf('step/start', { turn: 2, step: 1 }, 2))
  const assistant = assistantNode(3, { text: '我先看看' })
  assistant.data.turn = 2
  assistant.data.step = 1
  assistant.data.usage = { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 40 }
  tracker.observe(assistant)
  assert.equal(tracker.latest.prompt, 1000)
  assert.equal(tracker.latest.turn, 2)
  assert.equal(tracker.latest.step, 1)

  tracker.observe(eventOf('step/end', { turn: 2, step: 1 }, 4))
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.turn, 2)
  assert.deepEqual(snapshot.usage, { steps: 1, input: 100, cacheRead: 900, cacheWrite: 0, output: 40 })
  // 取走之后本轮用量清零，下一轮从头算。
  assert.equal(tracker.snapshot().usage.steps, 0)
})

test('publishPin 默认不设条数与长度上限，软上限只提示不拒绝', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-c')
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const config = normalizeConfig({})

  // 默认配置：十几条、单条六千字都照常发布，正文不截断。
  const long = '长'.repeat(6000)
  for (let i = 1; i <= 15; i += 1) {
    const result = publishPin({ session, label: '结论' + i, text: i === 15 ? long : '短结论' + i, config, store, log: silent })
    assert.equal(result.ok, true)
    assert.equal(result.pins, i)
  }
  const message = session.events.at(-1)
  assert.equal(message.data.source.kind, 'fold-pin')
  assert.ok(message.data.content[0].text.includes('【重要·永不折叠】'))
  assert.ok(message.data.content[0].text.includes(long), '默认不截断正文')

  // 显式设成软上限后仍然发布，只在返回里提示。
  const soft = normalizeConfig({ maxPins: 2, pinBudgetTokens: 10 })
  const over = publishPin({ session, label: '再多一条', text: '内容', config: soft, store, log: silent })
  assert.equal(over.ok, true)
  assert.ok(over.note.includes('软上限'))
  assert.ok(over.note.includes('软预算'))

  // 显式设长度上限时只截断，不拒绝。
  const clipped = publishPin({ session, label: '截断', text: '字'.repeat(50), config: normalizeConfig({ maxPinTextTokens: 10 }), store, log: silent })
  assert.equal(clipped.ok, true)
  assert.ok(clipped.chars <= 41, '截断后是 40 字加省略号')
  assert.ok(clipped.note.includes('截断'))
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

test('重要消息按 label 去重：保留最新内容，不重复计数', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const store = new FoldStore({ homeDir, sessionId: 'session-pins' })
  store.append({ kind: 'pin', id: '接口约定', text: '旧内容', at: 1 })
  store.append({ kind: 'pin', id: '另一条', text: '另一个', at: 2 })
  store.append({ kind: 'pin', id: '接口约定', text: '新内容', at: 3 })
  const pins = store.pins()
  assert.equal(pins.length, 2)
  assert.equal(pins[0].id, '接口约定')
  assert.equal(pins[0].text, '新内容')
  assert.equal(pins[1].id, '另一条')
})

test('注入消息撑满预算时，载荷仍然保住最终回复', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-c')
  const nodes = [userNode(1, '帮我查一下', 'user')]
  let seq = 2
  // 20 步：每步有思考、工具结果，再加一条 3 千字的运行时注入。
  for (let i = 0; i < 20; i += 1) {
    nodes.push(userNode(seq, '注入'.repeat(1500), 'runtime-context'))
    seq += 1
    nodes.push(assistantNode(seq, { reasoning: '想'.repeat(400), calls: [{ id: 'c' + i, name: 'run_code' }] }))
    seq += 1
    nodes.push(toolNode(seq, 'c' + i, '果'.repeat(600)))
    seq += 1
  }
  nodes.push(assistantNode(seq, { reasoning: '收尾'.repeat(50), text: '本轮结论：载荷必须保住这句话。' }))
  const last = nodes[nodes.length - 1]
  session.seed(nodes)
  const store = new FoldStore({ homeDir, sessionId: session.id })

  const result = foldTurn({
    session,
    turn: 1,
    nodes,
    config: normalizeConfig({ minFoldTokens: 300 }),
    store,
    log: silent,
  })
  assert.deepEqual(result.ids, ['f1'])
  const record = store.findFold('f1')
  // 注入消息与调用参数不计入 chars，载荷必须完整覆盖整段，所以载荷比 chars 长。
  assert.ok(record.chars < record.items.reduce((sum, item) => sum + item.text.length, 0))
  assert.ok(record.items.some((item) => item.text.includes('[回复] 本轮结论')))
  assert.equal(record.items.at(-1).seq, last.seq)
})

test('recallItems 按预算截断', () => {
  const items = recallItems([assistantNode(1, { text: 'x'.repeat(500) })], 100)
  assert.equal(items.length, 1)
  assert.ok(items[0].text.length <= 101)
})

test('normalizeConfig 把越界值钳进合法区间', () => {
  const config = normalizeConfig({ minFoldTokens: 1, maxPins: 999 })
  assert.equal(config.minFoldTokens, 50)
  assert.equal(config.maxPins, 999)
  assert.equal(normalizeConfig({ maxPins: 1000000 }).maxPins, 100000)
  assert.equal(normalizeConfig({ maxPinTextTokens: -5 }).maxPinTextTokens, 0)
  assert.equal(defaultConfig().enabled, true)
})

test('normalizeConfig 覆盖新增字段的钳制与类型守卫', () => {
  const low = normalizeConfig({
    maxNoteTokens: 10,
    recallReminderAfter: 0,
    maxFoldsPerTurn: 99,
    promptOrder: -5000,
    foldToolOutputs: 'no',
  })
  assert.equal(low.maxNoteTokens, 20)
  assert.equal(low.recallReminderAfter, 1)
  assert.equal(low.maxFoldsPerTurn, 32)
  assert.equal(low.promptOrder, -1000)
  assert.equal(low.foldToolOutputs, true, '类型不对时保留原值')

  const high = normalizeConfig({ maxNoteTokens: 99999, promptOrder: 99999 })
  assert.equal(high.maxNoteTokens, 1000)
  assert.equal(high.promptOrder, 10000)
})

test('单价字段有默认值，越界钳制，严格校验拒绝非数字', () => {
  const base = defaultConfig()
  assert.equal(base.priceCacheHitInput, 0.02)
  assert.equal(base.priceInput, 1)
  assert.equal(base.priceOutput, 4)
  assert.equal(base.cacheHitRate, 1)

  const clamped = normalizeConfig({ priceOutput: 9999, priceInput: -5 })
  assert.equal(clamped.priceOutput, 1000)
  assert.equal(clamped.priceInput, 0)

  // 单价保留六位小数，落盘时不带浮点尾巴。
  const rounded = normalizeConfig({ priceInput: 0.123456789 })
  assert.equal(rounded.priceInput, 0.123457)

  const ok = validateConfigPatch({ priceCacheHitInput: 0.5, priceInput: 4, priceOutput: 8 })
  assert.equal(ok.ok, true)
  assert.equal(ok.patch.priceInput, 4)

  const tooHigh = validateConfigPatch({ priceOutput: 5000 })
  assert.equal(tooHigh.ok, false)
  assert.ok(tooHigh.errors.join(' ').includes('0~1000'))

  const notNumber = validateConfigPatch({ priceInput: '2' })
  assert.equal(notNumber.ok, false)
  assert.ok(notNumber.errors.join(' ').includes('必须是数字'))
})

test('pricing 用默认价兜底，金额按百万 token 折算', () => {
  const prices = pricesOf({})
  assert.deepEqual(prices, { cacheHit: 0.02, input: 1, output: 4 })
  // 非法与缺项都退回默认，不让 NaN 流进金额。
  assert.deepEqual(pricesOf({ priceInput: 'x', priceOutput: NaN }), { cacheHit: 0.02, input: 1, output: 4 })

  assert.equal(yuanOf(1000000, 2), 2)
  assert.equal(roundMoney(2.3456789), 2.345679)
  assert.deepEqual(moneyOf({ hit: 1000000, input: 1000000, output: 1000000 }, prices), {
    cacheHit: 0.02,
    input: 1,
    output: 4,
    total: 5.02,
  })
  // 三档单价各乘各的，不再提供「命中率加权均价」：折叠省下的是重发的旧历史（命中价），
  // 召回与摘要的首次上行是新内容（未命中价），一个均价会同时高估一方、低估另一方。
  assert.equal(yuanOf(1000000, prices.cacheHit), 0.02)
  assert.equal(yuanOf(1000000, prices.input), 1)
})

test('normalizeConfig 忽略未知键并回调 warn', () => {
  const warnings = []
  const config = normalizeConfig({ bogus: 1, minFoldTokens: 300 }, defaultConfig(), (message) => warnings.push(message))
  assert.equal(config.minFoldTokens, 300)
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'bogus'), false)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('bogus'))
  assert.ok(warnings[0].includes('已忽略'))
})

test('noteChars 取固定上限，不随原文长短变化', () => {
  assert.equal(noteChars(normalizeConfig({})), 300)
  assert.equal(noteChars(normalizeConfig({ maxNoteTokens: 900 })), 900)
  assert.equal(noteChars({}), 300)
})

test('buildNote 的长度上限只约束回复行，元信息不被截断', () => {
  const stats = statsOf([
    assistantNode(2, {
      reasoning: 'r'.repeat(5000),
      text: 'y'.repeat(4000),
      calls: [{ id: 'c1', name: 'read', args: { file_path: 'E:/repo/lib/web.js' } }],
    }),
  ])
  const long = buildNote({ foldId: 'f3', turn: 3, stats, maxTokens: 30, toolName: 'fold_recall' })
  assert.ok(long.includes('【已折叠历史】 第 3 轮'), long)
  assert.ok(long.includes('· 文件：读过 lib/web.js'), long)
  const match = long.match(/· 回复约 4000 字(?:（≈\d+ token）)?，开头「([^」]*)…」，结尾「…([^」]*)」/)
  assert.ok(match, long)
  // 预览文字本身不超过上限；元信息（编号/文件行）在它之外，不被挤掉。
  assert.ok(match[1].length + match[2].length <= 120, long)
  const short = buildNote({ foldId: 'f4', turn: 4, stats: { ...stats, replyChars: 0 }, maxTokens: 20, toolName: 'fold_recall' })
  assert.ok(short.includes('· 文件：读过 lib/web.js'), short)
})

test('ConfigStore 只把显式改过的键写进文件层，profile 的其它值不被冻结', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const store = new ConfigStore({ homeDir, log: silent })
  store.load({ minFoldTokens: 900 })
  assert.equal(store.get().minFoldTokens, 900)

  const saved = store.save({ maxNoteTokens: 400 })
  assert.equal(saved.maxNoteTokens, 400)
  const raw = JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8'))
  assert.equal(raw.maxNoteTokens, 400)
  // 早先把合并后的 current 整份写盘，profile 的 900 会被冻结进文件，之后改 profile 永远不生效。
  assert.equal(raw.minFoldTokens, undefined, 'profile 的值不写进文件')

  const again = new ConfigStore({ homeDir, log: silent })
  const loaded = again.load({ minFoldTokens: 300 })
  assert.equal(loaded.minFoldTokens, 300, 'profile 改了，文件没覆盖这个键，就跟着 profile 走')
  assert.equal(loaded.maxNoteTokens, 400)

  // reset 必须是「显式写入默认值」：只清文件层的话，重启后 profile 又把它盖回去。
  again.reset()
  assert.equal(again.get().minFoldTokens, 300)
  const resetRaw = JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8'))
  assert.equal(resetRaw.minFoldTokens, 300)
  const third = new ConfigStore({ homeDir, log: silent })
  assert.equal(third.load({ minFoldTokens: 300 }).minFoldTokens, 300, '默认值压过 profile')
})

test('validateConfigPatch 只收白名单键，且逐项拒绝非法值', () => {
  const ok = validateConfigPatch({ maxNoteTokens: 400, foldToolOutputs: false })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.patch, { maxNoteTokens: 400, foldToolOutputs: false })

  const unknown = validateConfigPatch({ nope: 1 })
  assert.equal(unknown.ok, false)
  assert.ok(unknown.errors.join(' ').includes('未知配置项 nope'))

  const range = validateConfigPatch({ maxNoteTokens: 5000 })
  assert.equal(range.ok, false)
  assert.ok(range.errors.join(' ').includes('20~1000'))

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
  assert.ok(text.includes('maxNoteTokens'))

  const custom = systemPromptText({ maxNoteTokens: 400, systemPromptText: '召回 {{recallTool}}，固化 {{pinTool}}，调 {{configTool}}，未知 {{keep}}' })
  assert.ok(custom.includes('召回 fold_recall'))
  assert.ok(custom.includes('未知 {{keep}}'), '未知占位原样保留')
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
  const note = buildNote({ foldId: 'f1', turn: 1, stats, maxTokens: 75, toolName: 'fold_recall', includeToolOutputs: false })
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
    config: normalizeConfig({ minFoldTokens: 300, foldToolOutputs: false }),
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
    config: normalizeConfig({ minFoldTokens: 50, maxFoldsPerTurn: 2 }),
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
  assert.ok(got.text.includes('maxNoteTokens'))
  assert.ok(got.text.includes('20~1000'))
  assert.equal(got.config.maxNoteTokens, 300)
  assert.equal(got.filePath, join(homeDir, 'fold-config.json'))

  const set = await tool.execute({ action: 'set', patch: { maxNoteTokens: 400 } }, {})
  assert.equal(set.ok, true)
  assert.equal(updates.length, 1)
  assert.equal(configStore.get().maxNoteTokens, 400)
  assert.equal(JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8')).maxNoteTokens, 400)

  const badKey = await tool.execute({ action: 'set', patch: { nope: 1 } }, {})
  assert.equal(badKey.ok, false)
  assert.ok(badKey.text.includes('未知配置项 nope'))
  assert.equal(updates.length, 1, '非法 patch 不能触发热更新')
  assert.equal(configStore.get().maxNoteTokens, 400)

  const badRange = await tool.execute({ action: 'set', patch: { maxNoteTokens: 10 } }, {})
  assert.equal(badRange.ok, false)
  assert.ok(badRange.text.includes('20~1000'))

  const reset = await tool.execute({ action: 'reset' }, {})
  assert.equal(reset.ok, true)
  assert.equal(configStore.get().maxNoteTokens, 300)
  // reset 把默认值显式写进文件层，所以 maxNoteTokens 是 320 而不是「键消失」。
  assert.equal(JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8')).maxNoteTokens, 300)
})

test('statsOf 记下改过与读过的文件', () => {
  const nodes = [
    assistantNode(2, {
      reasoning: '想',
      text: '答',
      calls: [
        { id: 'c1', name: 'read', args: { file_path: 'E:/repo/lib/web.js' } },
        { id: 'c2', name: 'edit', args: { file_path: 'E:/repo/lib/turns.js' } },
        { id: 'c3', name: 'run_code', args: { code: 'const p = "E:/repo/tests/units.test.js"' } },
      ],
    }),
    toolNode(3, 'c1', 'x'.repeat(400)),
  ]
  const stats = statsOf(nodes)
  assert.deepEqual(stats.files.changed, ['E:/repo/lib/turns.js'])
  // run_code 的代码里扫到的路径算「读过」：它也可能在写，但摘要不替模型下结论。
  assert.deepEqual(stats.files.read, ['E:/repo/lib/web.js', 'E:/repo/tests/units.test.js'])
  // 同一文件既读又写时，只出现在「改过」里。
  const both = filesOfToolCall({ name: 'read', arguments: JSON.stringify({ path: 'E:/repo/lib/turns.js' }) })
  assert.deepEqual(both.read, ['E:/repo/lib/turns.js'])
})

test('noteFilesLine 用短路径拼一行，读过的去掉已改过的', () => {
  assert.equal(shortPath('E:/大肥鱼的窝/x/lib/tools.js'), 'lib/tools.js')
  assert.equal(noteFilesLine({ changed: [], read: [] }), '')
  const line = noteFilesLine({
    changed: ['E:/repo/lib/turns.js'],
    read: ['E:/repo/lib/turns.js', 'E:/repo/lib/web.js', 'E:/repo/lib/a.js', 'E:/repo/lib/b.js', 'E:/repo/lib/c.js'],
  })
  assert.equal(line, '· 文件：改过 lib/turns.js；读过 lib/web.js、lib/a.js、lib/b.js、lib/c.js')
  const manyRead = noteFilesLine({
    changed: [],
    read: ['E:/r/a/1.js', 'E:/r/a/2.js', 'E:/r/a/3.js', 'E:/r/a/4.js', 'E:/r/a/5.js', 'E:/r/a/6.js'],
  })
  assert.ok(manyRead.includes('等 6 个'), manyRead)
  const many = noteFilesLine({
    changed: ['E:/r/a/1.js', 'E:/r/a/2.js', 'E:/r/a/3.js', 'E:/r/a/4.js'],
    read: [],
  })
  assert.ok(many.includes('等 4 个'), many)
})

test('buildNote 带上文件行，且在预算内优先保住它', () => {
  const stats = statsOf([
    assistantNode(2, {
      reasoning: 'r'.repeat(400),
      text: 'y'.repeat(400),
      calls: [{ id: 'c1', name: 'read', args: { file_path: 'E:/repo/lib/web.js' } }],
    }),
  ])
  const note = buildNote({ foldId: 'f9', turn: 9, stats, maxTokens: 150, toolName: 'fold_recall' })
  assert.ok(note.includes('· 文件：读过 lib/web.js'), note)
  // 回复 400 字没超过 600 上限：整段保留，不重复展示。
  assert.ok(note.includes('y'.repeat(400)), note)
  assert.ok(!note.includes('结尾'), note)
})

function foldRecord(id, turn, items) {
  return { kind: 'fold', id, turn, at: 1, startSeq: 1, endSeq: 2, chars: 100, note: '', items }
}

const SEARCH_RECORDS = [
  foldRecord('f2', 2, [
    { seq: 10, text: '[思考] 先看看 lib/store.js 怎么写\n[调用 read] {"file_path":"E:/dsh-fold-context/lib/store.js"}' },
    { seq: 11, text: '[工具结果] 读到了，record 用 jsonl' },
  ]),
  foldRecord('f5', 5, [
    { seq: 20, text: '[思考] 修 router\n[调用 edit] {"file_path":"E:/dsh-fold-context/lib/web.js"}' },
    { seq: 21, text: '[工具结果] register({kind:"exact", path}) 已生效' },
  ]),
]

test('normalizeQuery 小写、切词、去重、限长', () => {
  assert.deepEqual(normalizeQuery('  Lib/Web.js,  Router  router  '), ['lib/web.js', 'router'])
  assert.deepEqual(normalizeQuery('a b c d e f g h i j'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  assert.deepEqual(normalizeQuery(undefined), [])
})

test('searchFolds 按关键词命中段，最近的折叠在前', () => {
  const found = searchFolds(SEARCH_RECORDS, 'lib/web.js')
  assert.equal(found.results.length, 1)
  assert.equal(found.results[0].id, 'f5')
  assert.equal(found.results[0].totalParts, 3)
  assert.ok(found.results[0].matched.length >= 1)
  assert.ok(found.results[0].matched[0].snippet.includes('web.js'))

  // 多个词是 AND：只有同时出现才算命中。
  assert.equal(searchFolds(SEARCH_RECORDS, 'lib/web.js 不存在的东西').results.length, 0)
  // 调用名也参与匹配。
  const byCall = searchFolds(SEARCH_RECORDS, 'edit')
  assert.equal(byCall.results[0].id, 'f5')
  // 大小写不敏感。
  assert.equal(searchFolds(SEARCH_RECORDS, 'LIB/WEB.JS').results.length, 1)
})

test('renderSearchResults 只给编号与段号，不给原文', () => {
  const found = searchFolds(SEARCH_RECORDS, 'lib/web.js')
  const text = renderSearchResults('lib/web.js', found, { maxChars: 4000 })
  assert.ok(text.includes('检索「lib/web.js」'), text)
  assert.ok(text.includes('f5'), text)
  assert.ok(text.includes('取回原文：fold_recall({id:"f5"'), text)
  assert.ok(text.includes('不算一次召回'), text)
  assert.ok(!text.includes('exact'), '检索结果不能贴原文')

  const miss = renderSearchResults('没有命中', searchFolds(SEARCH_RECORDS, '没命中'), {})
  assert.ok(miss.includes('没有命中'), miss)
})

test('matchFoldPartNumbers 只在一条折叠里筛段', () => {
  const numbers = matchFoldPartNumbers(SEARCH_RECORDS[1], normalizeQuery('register'))
  assert.deepEqual(numbers, [3])
  assert.deepEqual(matchFoldPartNumbers(SEARCH_RECORDS[1], []), [])
})

test('fold_recall 用 query 检索，且不增加召回次数', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const store = new FoldStore({ homeDir, sessionId: 'session-search' })
  for (const record of SEARCH_RECORDS) store.append(record)
  const session = new FakeSession('session-search')
  const ctx = makeCtx()
  registerTools({
    ctx,
    getStore: () => store,
    getConfig: () => defaultConfig(),
    resolveSession: () => session,
    getTurn: () => 6,
    log: silent,
    homeDir,
  })
  const tool = ctx.registrations.find((item) => item.name === 'fold_recall')
  assert.ok(tool, 'fold_recall 应当已注册')

  const found = await tool.execute({ query: 'lib/web.js' }, {})
  assert.equal(found.ok, true)
  assert.equal(found.mode, 'search')
  assert.ok(found.text.includes('f5'), found.text)
  assert.equal(store.recallCount('f5'), 0, '检索不算召回')

  const badPart = await tool.execute({ id: 'f5', parts: ['9'] }, {})
  assert.equal(badPart.ok, false)
  assert.ok(badPart.text.includes('没有匹配的段'), badPart.text)

  // 编号 + 关键词：只取命中段。
  const filtered = await tool.execute({ id: 'f5', query: 'register' }, {})
  assert.equal(filtered.ok, true)
  assert.equal(filtered.mode, 'parts')
  assert.ok(filtered.text.includes('#3'), filtered.text)
  assert.ok(!filtered.text.includes('#1 '), filtered.text)
  assert.equal(store.recallCount('f5'), 1, '取回原文才算一次召回')

  const empty = await tool.execute({}, {})
  assert.equal(empty.ok, false)
  assert.ok(empty.text.includes('query'), empty.text)
})

test('recallItems 保留完整工具调用参数（不再截到 300 字）', () => {
  const args = 'x'.repeat(5000)
  const items = recallItems(
    [assistantNode(1, { calls: [{ id: 'c1', name: 'run_code', args: { code: args } }] })],
    Number.MAX_SAFE_INTEGER,
  )
  assert.equal(items.length, 1)
  assert.ok(items[0].text.includes(args), '参数原文必须完整')
})

test('失败的工具调用不会把文件报成「改过」', () => {
  const call = assistantNode(1, { calls: [{ id: 'c1', name: 'edit', args: { file_path: 'E:/repo/lib/x.js' } }] })
  const failure = toolNode(2, 'c1', '权限不足')
  failure.data.message.isError = true
  const stats = statsOf([call, failure])
  assert.deepEqual(stats.files.changed, [])
  assert.deepEqual(stats.files.read, ['E:/repo/lib/x.js'])
})

test('POSIX 绝对路径也能进文件清单，URL 不会被当成路径', () => {
  const call = { name: 'run_code', arguments: JSON.stringify({ code: 'cat /home/me/project/lib/a.js && echo http://x/y/z' }) }
  const files = filesOfToolCall(call)
  assert.ok(files.read.some((path) => path.endsWith('/home/me/project/lib/a.js')))
  assert.ok(files.read.every((path) => !path.includes('http')))
})

test('载荷写失败时不写检查点，避免留下召回不到的死引用', () => {
  const session = new FakeSession('sess-store-fail')
  const nodes = [
    userNode(1, '做点事', 'user'),
    assistantNode(2, { reasoning: '想'.repeat(800) }),
  ]
  session.seed(nodes)
  const store = { append: () => false, findFold: () => undefined, pins: () => [] }
  const result = foldTurn({ session, turn: 1, nodes, config: normalizeConfig({}), store, log: silent })
  assert.equal(result.folded, 0)
  assert.equal(session.events.length, 0, '没有载荷就不该出现检查点')
})

test('同一轮超过 26 段时段号后缀继续 aa、ab', () => {
  const session = new FakeSession('sess-suffix')
  const nodes = []
  for (let i = 0; i < 28; i += 1) {
    nodes.push(userNode(i * 2 + 1, '继续', 'user'))
    nodes.push(assistantNode(i * 2 + 2, { reasoning: 'r'.repeat(1300) }))
  }
  session.seed(nodes)
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const result = foldTurn({ session, turn: 1, nodes, config: normalizeConfig({ maxFoldsPerTurn: 32 }), store, log: silent })
  assert.equal(result.ids.length, 28)
  assert.equal(result.ids[0], 'f1a')
  assert.equal(result.ids[25], 'f1z')
  assert.equal(result.ids[26], 'f1aa')
  assert.equal(result.ids[27], 'f1ab')
})

test('FoldStore 超过上限时清理最旧的折叠、保留 pin，并记住被清理的编号', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const store = new FoldStore({ homeDir, sessionId: 'cap', maxChars: 4000 })
  const big = (id, turn) => ({ kind: 'fold', id, turn, chars: 3000, items: [{ seq: turn, text: 'x'.repeat(3000) }] })
  store.append(big('f1', 1))
  store.append(big('f2', 2))
  assert.equal(store.findFold('f2') !== undefined, true, '最新一条必须保留')
  assert.equal(store.findFold('f1'), undefined)
  assert.equal(store.isPruned('f1'), true)
  store.append({ kind: 'pin', id: 'P', text: '别丢' })
  assert.equal(store.pins().length, 1)
})

test('上次写到一半的末行不会把新记录接坏', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const store = new FoldStore({ homeDir, sessionId: 'half' })
  store.append({ kind: 'pin', id: 'A', text: '1' })
  appendFileSync(store.filePath, '{"kind":"pin"')
  const again = new FoldStore({ homeDir, sessionId: 'half' })
  again.append({ kind: 'pin', id: 'B', text: '2' })
  const records = again.readAll()
  assert.equal(records.length, 2)
  assert.equal(records[1].id, 'B')
})

test('ConfigStore 写盘失败时抛错，不假装成功', () => {
  const base = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const blocker = join(base, 'blocker')
  writeFileSync(blocker, 'x')
  const store = new ConfigStore({ homeDir: blocker, log: silent })
  store.load({})
  assert.throws(() => store.save({ maxNoteTokens: 400 }), /写配置文件失败/)
})

// 纯逻辑与落账的单元测试：不依赖宿主，直接喂假 session。

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildNote, buildNoteEx, estimateNoteChars, filesOfToolCall, isKeeper, isWorthFolding, noteFilesLine, recallItems, shortPath, statsOf, totalChars } from '../lib/fold-text.js'
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
import { createPinMessage, pinBodyOf, pinCharsOf, resolvePins } from '../lib/pins.js'
import { pinPrefix, recentPinPrefix, recentPinSuffix } from '../lib/constants.js'
import { moneyOf, pricesOf, roundMoney, yuanOf } from '../lib/pricing.js'
import {
  foldParts,
  matchFoldPartNumbers,
  normalizeQuery,
  renderSearchResults,
  searchFolds,
} from '../lib/recall.js'
import { recallReminder, registerTools } from '../lib/tools.js'
import { TurnTracker } from '../lib/turn-tracker.js'
import { FakeSession, assistantNode, developerNode, eventOf, makeCtx, toolNode, userNode } from './fakes.js'

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

test('一轮多次回复：检查点覆盖全部回复，不再误标为完整保留', () => {
  // 第一条回复短、最后一条长：旧实现只看 stats.head，会返回 replyTruncated=false，
  // 召回据此跳过所有回复段，最终结论就永远取不回来了。
  const nodes = [
    assistantNode(2, { text: '先说明一下' }),
    toolNode(3, 'c1', '工具输出'),
    assistantNode(4, { text: '最终结论' + '。'.repeat(300) }),
  ]
  const stats = statsOf(nodes)
  const { text, replyTruncated } = buildNoteEx({ foldId: 'f9', turn: 9, stats, maxTokens: 20, toolName: 'fold_recall' })
  assert.equal(replyTruncated, true)
  assert.ok(text.includes('先说明一下'), text)
  assert.ok(text.includes('回复约'), text)
  // 截断标注必须让召回真的返回回复段，否则等于把最终回复弄丢。
  const record = { id: 'f9', turn: 9, replyTruncated, items: recallItems(nodes, Number.MAX_SAFE_INTEGER) }
  assert.ok(foldParts(record).some((part) => part.kind === 'reply'))

  // 两段都短时拼在一起完整保留，并明确标成未截断。
  const short = statsOf([assistantNode(5, { text: '甲' }), toolNode(6, 'c2', 'x'), assistantNode(7, { text: '乙' })])
  const whole = buildNoteEx({ foldId: 'f10', turn: 10, stats: short, maxTokens: 50, toolName: 'fold_recall' })
  assert.equal(whole.replyTruncated, false)
  assert.ok(whole.text.includes('甲 乙'), whole.text)
})

test('长 markdown 回复按标题摘要，短回复仍整段保留', () => {
  const long = '## 结论\n' + '甲'.repeat(80) + '\n## 改动\n' + '乙'.repeat(80) + '\n## 验证\n' + '丙'.repeat(80)
  const stats = statsOf([assistantNode(2, { text: long })])
  const { text: note, replyTruncated } = buildNoteEx({ foldId: 'f11', turn: 11, stats, maxTokens: 20, toolName: 'fold_recall' })
  assert.equal(replyTruncated, true)
  assert.ok(note.includes('按标题摘要（3 个标题）'), note)
  assert.ok(note.includes('## 结论 / ## 改动 / ## 验证'), note)
  // 标题摘要里不带正文：正文仍要靠召回去拿。
  assert.ok(!note.includes('甲'.repeat(80)), note)
  assert.ok(!note.includes('开头「'), note)

  const short = statsOf([assistantNode(3, { text: '## 甲\n内容\n## 乙\n更多' })])
  const whole = buildNoteEx({ foldId: 'f12', turn: 12, stats: short, maxTokens: 50, toolName: 'fold_recall' })
  assert.equal(whole.replyTruncated, false)
  assert.ok(whole.text.includes('· 回复：## 甲 内容 ## 乙 更多'), whole.text)
  assert.ok(!whole.text.includes('按标题摘要'), whole.text)
})

test('isKeeper 保留一切注入与开发者消息，只折叠助手段', () => {
  assert.equal(isKeeper(userNode(1, 'hi', 'user')), true)
  assert.equal(isKeeper(userNode(1, 'hi', 'fold-pin')), true)
  assert.equal(isKeeper(userNode(1, 'hi', 'fold-checkpoint')), true)
  // 官方压缩的检查点也是一次摘要：再折一次模型就看不见「哪段被压过」了。
  assert.equal(isKeeper(userNode(1, 'hi', 'compact-checkpoint')), true)
  // 调度器投递的是用户指令：折掉等于吞掉用户要求，所以和用户原话一样保留。
  assert.equal(isKeeper(userNode(1, 'hi', 'schedule')), true)
  // 一次性注入：宿主不会在下一轮补回来，折掉就永久失去。
  assert.equal(isKeeper(userNode(1, '审批策略变了', 'user-approval')), true)
  assert.equal(isKeeper(userNode(1, '子代理完成', 'subagent-settled')), true)
  assert.equal(isKeeper(userNode(1, '模型切换了', 'model-selection', 'notice')), true)
  // 会重放的注入同样保留：折叠把它移出 surface 后，宿主当作没发过再发一份，
  // 折掉省多少就补回多少；技能目录重发的还是完整目录。
  assert.equal(isKeeper(userNode(1, 'hi', 'runtime-context', 'snapshot')), true)
  assert.equal(isKeeper(userNode(1, '时间上下文', 'time-context', 'snapshot')), true)
  assert.equal(isKeeper(userNode(1, '技能目录', 'skill-catalog', 'catalog')), true)
  // 工具注册表变化也是一次性通知。
  assert.equal(isKeeper(developerNode(1, '工具变了')), true)
  assert.equal(isKeeper({ type: 'assistant/message', seq: 1, data: { message: {} } }), false)
  assert.equal(isKeeper({ type: 'tool/result', seq: 2, data: { message: {} } }), false)
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

test('可重放注入也是 keeper：折掉只会在下一步重发一份', () => {
  const nodes = [
    userNode(1, '这次会话的上下文', 'runtime-context', 'snapshot'),
    assistantNode(2, { text: 'a' }),
    toolNode(3, 'c1', '结果'),
  ]
  const segments = planSegments(nodes)
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0].map((n) => n.seq), [2, 3])
})

test('调度指令是 keeper，不进入折叠片段', () => {
  const nodes = [userNode(1, '重启完成', 'schedule'), assistantNode(2, { text: 'a' })]
  const segments = planSegments(nodes)
  assert.deepEqual(segments[0].map((n) => n.seq), [2])
})

test('一次性上下文注入与开发者消息也是 keeper，不进入折叠片段', () => {
  const nodes = [
    assistantNode(1, { text: 'a' }),
    userNode(2, '审批策略变了', 'user-approval'),
    assistantNode(3, { text: 'b' }),
    developerNode(4, '工具变更'),
    assistantNode(5, { text: 'c' }),
  ]
  const segments = planSegments(nodes)
  assert.deepEqual(segments.map((segment) => segment.map((n) => n.seq)), [[1], [3], [5]])
})

test('技能目录与时间上下文留在原处，不进入折叠片段', () => {
  const nodes = [
    userNode(1, '技能目录', 'skill-catalog', 'catalog'),
    assistantNode(2, { text: 'a' }),
    userNode(3, '时间上下文', 'time-context', 'snapshot'),
    assistantNode(4, { text: 'b' }),
  ]
  const segments = planSegments(nodes)
  assert.deepEqual(segments.map((segment) => segment.map((n) => n.seq)), [[2], [4]])
})

test('system/message 在片段之间断开，不会被替换区间扫掉', () => {
  const systemNode = { type: 'system/message', seq: 2, data: { message: { role: 'system', content: [{ type: 'text', text: '新版提示词' }] } } }
  const nodes = [assistantNode(1, { text: 'x'.repeat(300) }), systemNode, assistantNode(3, { text: 'y'.repeat(300) })]
  const segments = planSegments(nodes)
  assert.equal(segments.length, 2)
  assert.deepEqual(segments[0].map((n) => n.seq), [1])
  assert.deepEqual(segments[1].map((n) => n.seq), [3])
})

test('fold-pin 切断片段，前面的内容仍可整段折叠', () => {
  const nodes = [
    assistantNode(1, { text: 'a' }),
    assistantNode(2, { text: 'b' }),
    userNode(3, '重要结论', 'fold-pin'),
    assistantNode(4, { text: 'c' }),
  ]
  const segments = planSegments(nodes)
  assert.deepEqual(segments.map((segment) => segment.map((n) => n.seq)), [[1, 2], [4]])
})

test('foldTurn 折叠够长的一轮，并留下可召回的载荷', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-a')
  const nodes = [
    userNode(1, '帮我改代码', 'user'),
    assistantNode(2, { reasoning: '思'.repeat(800), calls: [{ id: 'c1', name: 'bash' }] }),
    toolNode(3, 'c1', '果'.repeat(600)),
  ]
  session.seed(nodes)
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const config = normalizeConfig({})

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

  const short = foldTurn({ session, turn: 1, nodes, config: normalizeConfig({}), store, log: silent })
  assert.equal(short.folded, 0)

  const off = foldTurn({ session, turn: 1, nodes, config: normalizeConfig({ enabled: false }), store, log: silent })
  assert.equal(off.folded, 0)
  assert.equal(session.events.length, 0)
})

test('foldTurn 按 minFoldRatio 保留不划算的原文，调低阈值后才折', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  // 原文 2000 字、回复预览被截成约 1200 字：摘要 / 原文约 0.62，默认阈值 0.5 不折。
  const build = (sessionId) => {
    const session = new FakeSession(sessionId)
    const nodes = [userNode(1, '说点长的', 'user'), assistantNode(2, { text: '长'.repeat(2000) })]
    session.seed(nodes)
    return { session, nodes }
  }

  const kept = build('sess-ratio-keep')
  const keptResult = foldTurn({
    session: kept.session,
    turn: 1,
    nodes: kept.nodes,
    config: normalizeConfig({}),
    store: new FoldStore({ homeDir, sessionId: kept.session.id }),
    log: silent,
  })
  assert.equal(keptResult.folded, 0, '省不到一半就保留原文')
  assert.equal(kept.session.events.length, 0)

  const folded = build('sess-ratio-fold')
  const foldedResult = foldTurn({
    session: folded.session,
    turn: 1,
    nodes: folded.nodes,
    config: normalizeConfig({ minFoldRatio: 0.9 }),
    store: new FoldStore({ homeDir, sessionId: folded.session.id }),
    log: silent,
  })
  assert.equal(foldedResult.folded, 1, '阈值调高后同一轮就会折')
})

test('isWorthFolding 严格低于阈值才折', () => {
  assert.equal(isWorthFolding(499, 1000, 0.5), true)
  assert.equal(isWorthFolding(500, 1000, 0.5), false, '等于阈值保留原文')
  assert.equal(isWorthFolding(501, 1000, 0.5), false)
  assert.equal(isWorthFolding(899, 1000, 0.9), true)
  assert.equal(isWorthFolding(0, 0, 0.5), false, '原文为空不折')
  assert.equal(isWorthFolding(400, 1000), true, '省略比例时用默认 0.5')
})

test('estimateNoteChars 与实际长度一致：标题摘要按实际标题算，不按 maxNoteTokens 预留', () => {
  const toolOnly = statsOf([
    assistantNode(2, { reasoning: 'x'.repeat(300), calls: [{ id: 'c1', name: 'grep' }] }),
    toolNode(3, 'c1', 'y'.repeat(200)),
  ])
  const opts = { foldId: 'f3', turn: 3, stats: toolOnly, maxTokens: 300, toolName: 'fold_recall' }
  assert.equal(estimateNoteChars(opts), buildNoteEx(opts).text.length)

  const outlineStats = statsOf([
    assistantNode(2, {
      text: '# 甲\n' + '正文'.repeat(800) + '\n## 乙\n' + '正文'.repeat(800) + '\n## 丙\n' + '正文'.repeat(800),
    }),
  ])
  const outlineOpts = { foldId: 'f4', turn: 4, stats: outlineStats, maxTokens: 50, toolName: 'fold_recall' }
  const note = buildNoteEx(outlineOpts)
  assert.equal(estimateNoteChars(outlineOpts), note.text.length)

  // 标题连起来不比原文短（标题多、正文少）：保留原文，长度仍然精确。
  const headingOnly = statsOf([
    assistantNode(2, { text: Array.from({ length: 20 }, (_, index) => '# t' + index).join('\n') }),
  ])
  const headingOpts = { foldId: 'f5', turn: 5, stats: headingOnly, maxTokens: 10, toolName: 'fold_recall' }
  const headingNote = buildNoteEx(headingOpts)
  assert.equal(estimateNoteChars(headingOpts), headingNote.text.length)
  assert.equal(headingNote.text.includes('按标题摘要'), false, headingNote.text)
  assert.ok(headingNote.text.includes('# t19'), '标题摘要不更短时保留原文：' + headingNote.text)
})

test('系统提示词的自定义文案可以引用 minFoldRatio', () => {
  const text = systemPromptText({ minFoldRatio: 0.35, systemPromptText: '阈值 {{minFoldRatio}}，召回 {{recallTool}}' })
  assert.ok(text.includes('0.35'), text)
  assert.ok(text.includes('fold_recall'), text)
  assert.equal(text.includes('{{'), false, text)
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

test('publishPin 交给宿主投递时，账本等消息真的写进会话后才落', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-pin-queue')
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const queued = []
  const result = publishPin({
    session,
    label: '接口约定',
    text: '字段同名同义',
    config: normalizeConfig({}),
    store,
    log: silent,
    onPublish: (pin) => queued.push(pin),
  })
  assert.equal(result.ok, true)
  assert.equal(result.pins, 1)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].label, '接口约定')
  // 消息还没投递：会话与账本都不该先出现它，否则投递失败会留下幽灵记录。
  assert.equal(session.events.length, 0)
  assert.equal(store.pins().length, 0)
  assert.equal(store.append(queued[0].record), true)
  assert.equal(store.pins().length, 1)

  // 同名重发会覆盖旧记录，条数不变；返回值也不能把新旧两条都算进去。
  const again = publishPin({
    session,
    label: '接口约定',
    text: '改了个说法',
    config: normalizeConfig({}),
    store,
    log: silent,
    onPublish: (pin) => queued.push(pin),
  })
  assert.equal(again.ok, true)
  assert.equal(again.pins, 1)
  assert.equal(store.pins().length, 1)
})

test('fold_pin 的消息头按 level 生成：省略仍是旧头，recent 带发布轮次', () => {
  const permanent = createPinMessage({ label: '部署路径', text: 'E:\\dsh' })
  assert.equal(permanent.content[0].text, pinPrefix + ' 部署路径\nE:\\dsh')
  assert.equal(permanent.source.kind, 'fold-pin')
  assert.equal(permanent.role, 'user')

  const recent = createPinMessage({ label: '部署路径', text: 'E:\\dsh', level: 'recent', turn: 12 })
  assert.equal(recent.content[0].text, recentPinPrefix + '12' + recentPinSuffix + ' 部署路径\nE:\\dsh')
  assert.ok(recent.content[0].text.startsWith('【近期重要·第12轮·可能过时】 '))
  // 省略 level 与显式 permanent 产生同一种头。
  assert.equal(createPinMessage({ label: 'X', text: 'y', level: 'permanent' }).content[0].text, pinPrefix + ' X\ny')
})

test('pinBodyOf 认两种头：旧消息、recent 与无头正文都能解析', () => {
  assert.equal(pinBodyOf(pinPrefix + ' X\nhello\nworld'), 'hello\nworld')
  assert.equal(pinBodyOf('【近期重要·第12轮·可能过时】 X\nhello'), 'hello')
  assert.equal(pinBodyOf(pinPrefix + ' X'), '')
  assert.equal(pinBodyOf('【近期重要·第3轮·可能过时】 X'), '')
  assert.equal(pinBodyOf('没有前缀的正文'), '没有前缀的正文')
  // 正文里引用头字样不是头：只有整行完全匹配才剥。
  assert.equal(pinBodyOf('说明\n' + pinPrefix + ' X\n正文'), '说明\n' + pinPrefix + ' X\n正文')
  assert.equal(pinBodyOf(''), '')
})

test('pinCharsOf 按实际头长算：recent 的轮次位数不同，长度跟着变', () => {
  const body = 'abc'
  assert.equal(pinCharsOf('X', body), (pinPrefix + ' X\n' + body).length)
  assert.equal(pinCharsOf('X', body, 'recent', 9), ('【近期重要·第9轮·可能过时】 X\n' + body).length)
  assert.equal(pinCharsOf('X', body, 'recent', 100), ('【近期重要·第100轮·可能过时】 X\n' + body).length)
  // 轮次多一位，整条消息就多一个字：头长不是固定公式。
  assert.equal(pinCharsOf('X', body, 'recent', 100), pinCharsOf('X', body, 'recent', 9) + 2)
})

test('publishPin 记录 level：只有 recent 才写，回执说明可能过时', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-pin-level')
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const config = normalizeConfig({})

  const recent = publishPin({ session, label: '临时结论', text: '先用 A 方案', level: 'recent', turn: 7, config, store, log: silent })
  assert.equal(recent.ok, true)
  assert.ok(recent.note.includes('近期重要'), recent.note)
  assert.ok(recent.note.includes('可能过时'), recent.note)
  const recentMessage = session.events.at(-1).data.content[0].text
  assert.ok(recentMessage.startsWith('【近期重要·第7轮·可能过时】 临时结论\n'), recentMessage)
  const recentRecord = store.pins().find((record) => record.id === '临时结论')
  assert.equal(recentRecord.level, 'recent')
  assert.equal(recentRecord.turn, 7)

  const permanent = publishPin({ session, label: '长期结论', text: '改用 B 方案', config, store, log: silent })
  assert.equal(permanent.ok, true)
  assert.equal(permanent.note, undefined, '永久记录不带「可能过时」回执')
  const permanentRecord = store.pins().find((record) => record.id === '长期结论')
  assert.equal(permanentRecord.level, undefined, '永久是默认，记录里不写 level')
})

test('轮内发布 recent 时待投递记录与队列都带 level 与轮次', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-pin-pending-level')
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const queued = []
  const result = publishPin({
    session,
    label: '临时约定',
    text: '这一版接口先用 snake_case',
    level: 'recent',
    turn: 4,
    config: normalizeConfig({}),
    store,
    log: silent,
    onPublish: (pin) => queued.push(pin),
  })
  assert.equal(result.ok, true)
  assert.equal(result.pending, true)
  const pending = store.pendingPins()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].level, 'recent')
  assert.equal(pending[0].turn, 4)
  // 队列里的消息要带同样两项，补投时 createPinMessage 才能还原同一条消息。
  assert.equal(queued[0].level, 'recent')
  assert.equal(queued[0].turn, 4)
})

test('非法 level 不发布，回执说明只支持两个值且省略即 permanent', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-pin-bad-level')
  const store = new FoldStore({ homeDir, sessionId: session.id })
  for (const level of ['temporary', 'RECENT', 'soon']) {
    const result = publishPin({ session, label: 'X', text: 'Y', level, config: normalizeConfig({}), store, log: silent })
    assert.equal(result.ok, false, level + ' 应当被拒绝')
    assert.ok(result.reason.includes('permanent'), result.reason)
    assert.ok(result.reason.includes('recent'), result.reason)
    assert.ok(result.reason.includes('省略'), result.reason)
    assert.ok(result.reason.includes(level), '回执写明收到的值')
  }
  assert.equal(session.events.length, 0, '拒绝时不写会话')
  assert.equal(store.pins().length, 0, '拒绝时不落账')
  assert.equal(store.pendingPins().length, 0, '拒绝时不留待投递记录')
})

test('resolvePins 按 label + level 配对：同名 recent 与 permanent 不互相套错', () => {
  const records = [
    { kind: 'pin', id: 'P', text: '永久正文', turn: 2, at: 200 },
    { kind: 'pin', id: 'P', text: '近期正文', level: 'recent', turn: 9, at: 900 },
  ]
  const surface = [
    { label: 'P', text: '【近期重要·第9轮·可能过时】 P\n近期正文' },
    { label: 'P', text: pinPrefix + ' P\n永久正文' },
  ]
  const list = resolvePins(records, surface)
  assert.equal(list.length, 2)
  const recent = list.find((row) => row.level === 'recent')
  assert.equal(recent.text, '近期正文')
  assert.equal(recent.turn, 9)
  assert.equal(recent.present, true)
  assert.equal(recent.recorded, true)
  assert.equal(recent.chars, surface[0].text.length)
  const permanent = list.find((row) => row.level === 'permanent')
  assert.equal(permanent.text, '永久正文')
  assert.equal(permanent.turn, 2)
  assert.ok(list.every((row) => row.present === true), '两条都配对上了，没有「被卷走」')

  // 记录里只有一条时也能带上 level；旧记录没有 level 一律按 permanent。
  const [only] = resolvePins([{ kind: 'pin', id: 'Q', text: 'x', level: 'recent', turn: 5 }], null)
  assert.equal(only.level, 'recent')
  assert.equal(only.chars, pinCharsOf('Q', 'x', 'recent', 5))
  const [legacy] = resolvePins([{ kind: 'pin', id: 'Q', text: 'x' }], null)
  assert.equal(legacy.level, 'permanent')
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

test('调用参数不计入体量，载荷仍然完整覆盖到最终回复', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-c')
  const nodes = [userNode(1, '帮我查一下', 'user')]
  let seq = 2
  // 20 步：每步有思考与工具结果，调用参数里再带 3 千字代码（参数不计入 chars）。
  for (let i = 0; i < 20; i += 1) {
    nodes.push(assistantNode(seq, {
      reasoning: '想'.repeat(400),
      calls: [{ id: 'c' + i, name: 'run_code', args: { code: 'x'.repeat(3000) } }],
    }))
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
    config: normalizeConfig({}),
    store,
    log: silent,
  })
  assert.deepEqual(result.ids, ['f1'])
  const record = store.findFold('f1')
  // 调用参数不计入 chars，载荷必须完整覆盖整段，所以载荷比 chars 长。
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
  const config = normalizeConfig({ maxNoteTokens: 1, maxPins: 999 })
  assert.equal(config.maxNoteTokens, 20)
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
  const config = normalizeConfig({ bogus: 1, maxRecallTokens: 1000 }, defaultConfig(), (message) => warnings.push(message))
  assert.equal(config.maxRecallTokens, 1000)
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
  store.load({ maxRecallTokens: 1200 })
  assert.equal(store.get().maxRecallTokens, 1200)

  const saved = store.save({ maxNoteTokens: 400 })
  assert.equal(saved.maxNoteTokens, 400)
  const raw = JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8'))
  assert.equal(raw.maxNoteTokens, 400)
  // 早先把合并后的 current 整份写盘，profile 的 1200 会被冻结进文件，之后改 profile 永远不生效。
  assert.equal(raw.maxRecallTokens, undefined, 'profile 的值不写进文件')

  const again = new ConfigStore({ homeDir, log: silent })
  const loaded = again.load({ maxRecallTokens: 800 })
  assert.equal(loaded.maxRecallTokens, 800, 'profile 改了，文件没覆盖这个键，就跟着 profile 走')
  assert.equal(loaded.maxNoteTokens, 400)

  // reset 必须是「显式写入默认值」：只清文件层的话，重启后 profile 又把它盖回去。
  again.reset()
  assert.equal(again.get().maxRecallTokens, 1000)
  const resetRaw = JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8'))
  assert.equal(resetRaw.maxRecallTokens, 1000)
  const third = new ConfigStore({ homeDir, log: silent })
  assert.equal(third.load({ maxRecallTokens: 800 }).maxRecallTokens, 1000, '默认值压过 profile')
})

test('文本默认值随代码升级：文件里的默认文案换回当前默认值，自定义文案不受影响', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const file = join(homeDir, 'fold-config.json')
  const defaults = defaultConfig()

  const store = new ConfigStore({ homeDir, log: silent })
  store.load({})
  store.reset()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.systemPromptText, defaults.systemPromptText)
  assert.ok(raw._fromCodeDefault.includes('systemPromptText'), '默认文案要被记成派生值')

  // 模拟「文件里留着旧版本默认文案，代码已经升级」：清单说它当初等于默认值。
  raw.systemPromptText = '旧版本的默认文案'
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
  const loaded = new ConfigStore({ homeDir, log: silent }).load({ systemPromptText: 'profile 里的旧文案' })
  assert.equal(loaded.systemPromptText, defaults.systemPromptText, '跟随当前默认值，并压过 profile')

  // 用户自己写过的文案不等于默认值，不进清单，重启后保持原样。
  store.save({ systemPromptText: '自定义文案' })
  const custom = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(custom._fromCodeDefault.includes('systemPromptText'), false)
  assert.equal(custom.systemPromptText, '自定义文案')
  const kept = new ConfigStore({ homeDir, log: silent }).load({})
  assert.equal(kept.systemPromptText, '自定义文案')
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
  // 记忆、技能这类「以后还要照着用」的内容靠 pin 逐字固化。
  assert.ok(text.includes('逐字'), '允许逐字抄原文')
  assert.ok(text.includes('加载技能'), '技能规则要先固化再执行')
  assert.equal(text.includes('读文件、写文件、加载技能的步骤不折叠'), false, '自动保护的说法已撤回')
  // 长回复按标题分节：检查点与召回都靠它定位。
  assert.ok(text.includes('markdown'), '长回复按标题分节')
  // 近期重要：level 传 recent，头里带发布轮次，跨几轮后按可能过时处理。
  assert.ok(text.includes('level 传 "recent"'))
  assert.ok(text.includes('【近期重要·第N轮·可能过时】'))
  // 不写 pin 的代价，只给正向许可。
  for (const word of ['占上下文', '更省', '划算', '只固化真会再用', '只记必要', '不敢记']) {
    assert.equal(text.includes(word), false, '不出现代价措辞：' + word)
  }

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
  // 关掉总开关 = 不注入提示段（段名与 order 还在，文本为空，宿主据此跳过注册）。
  const off = promptSection(normalizeConfig({ enabled: false, promptOrder: 120 }))
  assert.equal(off.text, '')
  assert.equal(off.name, 'fold-compression')
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
    assistantNode(1, { reasoning: 'x'.repeat(300), text: 'y'.repeat(100), calls: [{ id: 'c1', name: 'bash' }] }),
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
    assistantNode(2, { reasoning: '思'.repeat(30), calls: [{ id: 'c1', name: 'bash' }] }),
    toolNode(3, 'c1', '果'.repeat(600)),
  ]
  session.seed(nodes)
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const withoutTools = foldTurn({
    session,
    turn: 1,
    nodes,
    config: normalizeConfig({ foldToolOutputs: false }),
    store,
    log: silent,
  })
  // 只算 30 字思考：摘要（元信息）比原文还长，不折。
  assert.equal(withoutTools.folded, 0, '工具输出不计入体量，100 字上下的一轮省不下来')

  const withTools = foldTurn({
    session,
    turn: 1,
    nodes,
    config: normalizeConfig({ foldToolOutputs: true }),
    store,
    log: silent,
  })
  assert.equal(withTools.folded, 1, '计入 600 字工具输出后，摘要能省下一半以上')
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
    config: normalizeConfig({ maxFoldsPerTurn: 2 }),
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
  assert.ok(text.includes('用来定位'), text)
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

test('检查点写入失败时撤回载荷，不留占号的孤儿', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const nodes = [
    userNode(1, '帮我改代码', 'user'),
    assistantNode(2, { reasoning: '思'.repeat(1600) }),
  ]
  const session = new FakeSession('sess-rollback')
  session.seed(nodes)
  // 载荷先落盘、检查点后写：检查点这一步失败时，刚才那条载荷就成了没人引用的孤儿。
  session.append = () => {
    throw new Error('磁盘满了')
  }
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const warns = []
  const result = foldTurn({
    session,
    turn: 1,
    nodes,
    config: normalizeConfig({}),
    store,
    log: { info() {}, warn: (message) => warns.push(message), error() {} },
  })
  assert.equal(result.folded, 0)
  assert.equal(store.findFold('f1'), undefined, '载荷必须撤回，否则编号一直被占着')
  assert.equal(store.folds().size, 0)
  // 日志要能靠编号与 seq 区间定位到是哪一段出的问题。
  assert.ok(warns.some((line) => line.includes('f1') && line.includes('seq 2–2')), warns.join('\n'))
})

test('同一轮再次折叠时编号递增，而不是静默跳过', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const session = new FakeSession('sess-twice')
  const first = [userNode(1, '第一段', 'user'), assistantNode(2, { reasoning: '思'.repeat(1600) })]
  session.seed(first)
  const store = new FoldStore({ homeDir, sessionId: session.id })
  const config = normalizeConfig({})
  const a = foldTurn({ session, turn: 1, nodes: first, config, store, log: silent })
  assert.deepEqual(a.ids, ['f1'])

  // 同一轮被关闭两次：第二次的段号会撞上 f1。早先这里直接跳过，后半段永远折不掉。
  const second = [assistantNode(10, { reasoning: '续'.repeat(1600) })]
  session.seed(second)
  const b = foldTurn({ session, turn: 1, nodes: second, config, store, log: silent })
  assert.deepEqual(b.ids, ['f1-2'])
  assert.ok(store.findFold('f1-2'))
  assert.equal(session.events.at(-1).data.source.foldId, 'f1-2')
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

  // 第二次清理要把上一批被清理的编号一起写进 prune 记录，否则重启后只认识最后一批，
  // 更早的 f1 会被当成「从来没有过」，召回提示就错了。
  store.append(big('f3', 3))
  assert.equal(store.isPruned('f1'), true)
  assert.equal(store.isPruned('f2'), true)
  const reloaded = new FoldStore({ homeDir, sessionId: 'cap', maxChars: 4000 })
  assert.equal(reloaded.isPruned('f1'), true)
  assert.equal(reloaded.isPruned('f2'), true)
  assert.equal(reloaded.findFold('f3') !== undefined, true, '最新一条必须保留')
  assert.equal(reloaded.pins().length, 1)
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

test('fork 子会话的 store 只读取回退到父 store，且不跨父汇总', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-test-'))
  const parent = new FoldStore({ homeDir, sessionId: 'fork-parent' })
  parent.append({ kind: 'fold', id: 'f1', turn: 1, chars: 10, items: [{ seq: 1, text: '父会话原文' }] })
  const child = new FoldStore({
    homeDir,
    sessionId: 'fork-child',
    parentStoreOf: (id) => (id === 'fork-child' ? parent : null),
    hasParentOf: () => true,
  })
  // 单条读取跨父：fork 的 seed 里带着父会话检查点，编号必须能换回原文。
  assert.equal(child.findFold('f1').items[0].text, '父会话原文')
  assert.equal(child.isPruned('f1'), false)
  // 汇总不跨父：账本按会话计价，把父会话的折叠算进来会重复。
  assert.equal(child.folds().size, 0)
  assert.equal(child.pins().length, 0)

  // 父里被清理过的编号要报「已清理」，不能报成「从来没有过」。
  const prunedParent = new FoldStore({ homeDir, sessionId: 'fork-pruned-parent' })
  prunedParent.pruned.add('f9')
  const child2 = new FoldStore({ homeDir, sessionId: 'fork-child-2', parentStoreOf: () => prunedParent })
  assert.equal(child2.isPruned('f9'), true)

  // 父会话不可达：只读回退失败时返回 undefined，且能说明是「不可达」而不是没有父会话。
  const orphan = new FoldStore({ homeDir, sessionId: 'fork-orphan', parentStoreOf: () => null, hasParentOf: () => true })
  assert.equal(orphan.findFold('f1'), undefined)
  assert.equal(orphan.parentUnreachable(), true)
  const standalone = new FoldStore({ homeDir, sessionId: 'standalone' })
  assert.equal(standalone.parentUnreachable(), false)

  // 自引用（父指向自己）不能死循环。
  const loop = new FoldStore({ homeDir, sessionId: 'fork-loop', parentStoreOf: () => loop })
  assert.equal(loop.findFold('f1'), undefined)
})


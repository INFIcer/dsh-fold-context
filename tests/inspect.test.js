// 报告模型的单元测试：喂假的派生消息与 fold 记录，覆盖统计、还原与告警。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReportModel,
  buildTextReport,
  collectRecords,
  messageEntries,
  reconstructUnfolded,
  summarizeModelView,
} from '../lib/inspect.js'
import { estimateMessageTokens } from '../lib/tokens.js'

const NOTE_1 = '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回'
const NOTE_2 = '【已折叠历史】 第 2 轮已折叠，原文用 fold_recall("f2") 召回'

function message(role, text, extra = {}) {
  const source = extra.source
  const out = { role, content: [{ type: 'text', text }] }
  if (source) out.source = source
  if (extra.seq !== undefined) out.seq = extra.seq
  return out
}

function checkpoint(foldId, text) {
  return message('user', text, { source: { kind: 'fold-checkpoint', foldId } })
}

function pinMessage(label, text) {
  return message('user', '【重要·永不折叠】 ' + label + '\n' + text, { source: { kind: 'fold-pin', label } })
}

function recentPinMessage(label, text) {
  return message('user', '【近期重要·第3轮·可能过时】 ' + label + '\n' + text, { source: { kind: 'fold-pin', label } })
}

function fixture() {
  const messages = [
    message('user', '帮我把折叠记录可视化'),
    checkpoint('f1', NOTE_1),
    message('user', '继续'),
    checkpoint('f2', NOTE_2),
    pinMessage('部署路径', '在 E:\\dsh\\deploy.ps1'),
  ]
  const folds = new Map([
    ['f1', {
      kind: 'fold', id: 'f1', turn: 1, at: 1000, chars: 1500, note: NOTE_1,
      items: [
        { seq: 2, text: '[思考]' + '思'.repeat(700) },
        { seq: 3, text: '[回复]' + '答'.repeat(100) },
        { seq: 4, text: '[工具结果]' + '果'.repeat(600) },
      ],
    }],
    ['f2', {
      kind: 'fold', id: 'f2', turn: 2, at: 2000, chars: 1700, note: NOTE_2,
      items: [
        { seq: 6, text: '[思考]' + '想'.repeat(1000) },
        { seq: 7, text: '[工具结果]' + '果'.repeat(700) },
      ],
    }],
  ])
  return { messages, folds }
}

function demoModel() {
  const { messages, folds } = fixture()
  return buildReportModel({
    sessionId: 'sess-demo',
    derivedMessages: messages,
    folds,
    pins: [{ kind: 'pin', id: '部署路径', text: '在 E:\\dsh\\deploy.ps1', at: 3000 }],
    recalls: [{ kind: 'recall', id: 'f1', at: 1500 }, { kind: 'recall', id: 'f1', at: 1600 }],
    config: { enabled: true, recallReminderAfter: 3 },
    now: Date.UTC(2026, 10, 14, 4, 0, 0),
  })
}

test('summarizeModelView 统计角色、检查点、pin 与 token', () => {
  const { messages, folds } = fixture()
  const view = summarizeModelView({ derivedMessages: messages, folds })
  assert.equal(view.totals.count, messages.length)
  assert.equal(view.totals.checkpoints, 2)
  assert.equal(view.totals.pins, 1)

  const chars = view.messages.reduce((sum, item) => sum + item.chars, 0)
  assert.equal(view.totals.chars, chars)
  assert.equal(view.totals.tokens, messages.reduce((sum, item) => sum + estimateMessageTokens(item), 0))
  assert.equal(view.messages[0].tokens, estimateMessageTokens(messages[0]))

  assert.equal(view.messages[0].role, 'user')
  assert.equal(view.messages[0].roleLabel, '用户')
  assert.equal(view.messages[0].isCheckpoint, false)

  const ckpt = view.messages[1]
  assert.equal(ckpt.isCheckpoint, true)
  assert.equal(ckpt.foldId, 'f1')
  assert.ok(ckpt.sourceLabel.indexOf('f1') >= 0)

  const pin = view.messages[4]
  assert.equal(pin.isPin, true)
  assert.ok(pin.sourceLabel.indexOf('重要消息') >= 0)
  assert.ok(pin.preview.indexOf('部署路径') >= 0)
})

test('pin 条目带级别：近期重要与长期重要的标签与 pinLevel 分开', () => {
  const messages = [
    message('user', '开始'),
    pinMessage('部署路径', '在 E:\\dsh\\deploy.ps1'),
    recentPinMessage('临时结论', '先按 A 方案'),
  ]
  const folded = summarizeModelView({ derivedMessages: messages })
  assert.equal(folded.messages[0].pinLevel, '', '普通消息没有级别')
  assert.equal(folded.messages[1].pinLevel, 'permanent')
  assert.ok(folded.messages[1].sourceLabel.indexOf('重要消息') >= 0)
  assert.equal(folded.messages[2].pinLevel, 'recent')
  assert.ok(folded.messages[2].sourceLabel.indexOf('近期重要') >= 0)

  const unfolded = reconstructUnfolded({ derivedMessages: messages, folds: new Map() })
  assert.equal(unfolded.messages[1].pinLevel, 'permanent')
  assert.equal(unfolded.messages[2].pinLevel, 'recent')
  assert.ok(unfolded.messages[2].sourceLabel.indexOf('近期重要') >= 0)

  const entries = messageEntries({ derivedMessages: messages, folds: new Map() })
  assert.equal(entries[1].pinLevel, 'permanent')
  assert.equal(entries[2].pinLevel, 'recent')
})

test('token 按内容块计价：思考、回复、工具调用参数分开算', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '思'.repeat(400) },
      { type: 'text', text: '答'.repeat(40) },
      { type: 'tool-call', id: 'c1', name: 'run_code', arguments: '{"code":"x"}' },
    ],
  }]
  const view = summarizeModelView({ derivedMessages: messages })
  // 思考 400/4+4、回复 40/4+4、调用 8/4 + 12/4 + 4、消息再 +4。
  assert.equal(view.totals.tokens, 104 + 14 + 9 + 4)
  // 空消息不占上下文。
  assert.equal(summarizeModelView({ derivedMessages: [{ role: 'assistant', content: [] }] }).totals.tokens, 0)
})

test('reconstructUnfolded 用 fold 原文还原检查点，字符增长且按轮算出节省', () => {
  const { messages, folds } = fixture()
  const folded = summarizeModelView({ derivedMessages: messages, folds })
  const unfolded = reconstructUnfolded({ derivedMessages: messages, folds })

  assert.ok(unfolded.totals.chars > folded.totals.chars)
  const expanded = unfolded.messages.filter((item) => item.fromFold === 'f1')
  assert.equal(expanded.length, 3)
  assert.ok(expanded[0].preview.indexOf('思') >= 0)
  assert.equal(expanded[0].turn, 1)

  assert.equal(unfolded.turns.length, 2)
  const first = unfolded.turns[0]
  assert.equal(first.turn, 1)
  assert.equal(first.steps, 2)
  assert.deepEqual(first.foldIds, ['f1'])
  assert.ok(first.saved > 0)
  assert.ok(first.saveRate > 0 && first.saveRate < 1)

  const row = unfolded.foldRows[0]
  assert.equal(row.foldId, 'f1')
  assert.equal(row.foldedChars, NOTE_1.length)
  assert.ok(row.unfoldedChars > row.foldedChars)
})
test('轮次号取会话轮次：同一轮被 steering 切开时标续接，未知轮次按相邻推断', () => {
  const userMessage = (text) => message('user', text, { source: { kind: 'user' } })
  const messages = [
    userMessage('第一句'),
    checkpoint('f1', NOTE_1),
    userMessage('轮内插话'),
    checkpoint('f2', NOTE_2),
    userMessage('下一轮'),
    message('assistant', '收尾', { source: { kind: 'model', provider: 'p', model: 'm' } }),
  ]
  // 两条记录都属于会话第 1 轮：用户在同轮里又补了一句。
  const folds = new Map([
    ['f1', { kind: 'fold', id: 'f1', turn: 1, at: 1000, chars: 100, note: NOTE_1, items: [] }],
    ['f2', { kind: 'fold', id: 'f2', turn: 1, at: 2000, chars: 120, note: NOTE_2, items: [] }],
  ])
  const model = buildReportModel({ sessionId: 's', derivedMessages: messages, folds, pins: [], recalls: [] })
  const groups = model.turnGroups.filter((group) => group.kind === 'turn')
  assert.equal(groups.length, 3)
  assert.equal(groups[0].turn, 1)
  assert.equal(groups[0].continuation, false)
  assert.equal(groups[1].turn, 1)
  assert.equal(groups[1].continuation, true)
  assert.equal(groups[2].turn, 2)
  assert.equal(groups[2].continuation, false)
})

test('插件生效前的未折叠轮次按第一个折叠轮次向前回填编号', () => {
  const messages = [
    message('user', '插件装上之前的对话', { source: { kind: 'user' } }),
    message('assistant', '旧回复', { source: { kind: 'model', provider: 'p', model: 'm' } }),
    message('user', '装上之后', { source: { kind: 'user' } }),
    checkpoint('f5', '【已折叠历史】 第 2 轮已折叠，原文用 fold_recall("f5") 召回'),
  ]
  const folds = new Map([
    ['f5', { kind: 'fold', id: 'f5', turn: 2, at: 1000, chars: 80, note: 'x', items: [] }],
  ])
  const model = buildReportModel({ sessionId: 's', derivedMessages: messages, folds, pins: [], recalls: [] })
  const groups = model.turnGroups.filter((group) => group.kind === 'turn')
  assert.equal(groups[0].turn, 1)
  assert.equal(groups[0].prePlugin, true)
  assert.equal(groups[1].turn, 2)
  assert.equal(groups[1].folded, true)
})

test('一条 fold 记录都没有时按出现顺序编号', () => {
  const messages = [
    message('user', 'a', { source: { kind: 'user' } }),
    message('assistant', 'b', { source: { kind: 'model', provider: 'p', model: 'm' } }),
    message('user', 'c', { source: { kind: 'user' } }),
  ]
  const model = buildReportModel({ sessionId: 's', derivedMessages: messages, folds: new Map(), pins: [], recalls: [] })
  const groups = model.turnGroups.filter((group) => group.kind === 'turn')
  assert.equal(groups.length, 2)
  assert.equal(groups[0].turn, 1)
  assert.equal(groups[1].turn, 2)
})

test('载荷缺失时保留摘要、记下编号并给出告警', () => {
  const messages = [checkpoint('f9', '【已折叠历史】 第 9 轮已折叠'), message('user', 'hi')]
  const view = reconstructUnfolded({ derivedMessages: messages, folds: new Map() })
  assert.deepEqual(view.totals.missing, ['f9'])
  assert.ok(view.messages[0].sourceLabel.indexOf('原文缺失') >= 0)

  const model = buildReportModel({ sessionId: 's', derivedMessages: messages, folds: new Map(), pins: [], recalls: [] })
  assert.ok(model.warns.some((line) => line.indexOf('载荷') >= 0))
})

test('buildReportModel 汇总召回、固化与时间线', () => {
  const model = demoModel()
  assert.equal(model.foldRows.length, 2)
  assert.equal(model.foldRows[0].recallCount, 2)
  assert.equal(model.foldRows[0].pinned, true)
  assert.equal(model.foldRows[0].pinnedBy, 'after-recall')
  assert.equal(model.foldRows[1].recallCount, 0)
  assert.equal(model.foldRows[1].pinned, false)
  assert.equal(model.totals.recalls, 2)
  assert.equal(model.totals.recalledFolds, 1)
  assert.equal(model.totals.pinCount, 1)
  assert.equal(model.totals.pinChars, '在 E:\\dsh\\deploy.ps1'.length)
  assert.equal(model.timeline.length, 5)
  assert.equal(model.timeline[0].kind, 'fold')
  assert.ok(model.totals.saved > 0)
})

test('显式的 pin.foldId 直接算固化，不吃归因推测', () => {
  const { messages, folds } = fixture()
  const model = buildReportModel({
    sessionId: 's',
    derivedMessages: messages,
    folds,
    pins: [{ kind: 'pin', id: '结论', text: 'x'.repeat(40), at: 5000, foldId: 'f2' }],
    recalls: [{ kind: 'recall', id: 'f1', at: 900 }],
  })
  const f2 = model.foldRows.find((row) => row.foldId === 'f2')
  const f1 = model.foldRows.find((row) => row.foldId === 'f1')
  assert.equal(f2.pinned, true)
  assert.equal(f2.pinnedBy, 'explicit')
  assert.equal(f1.pinned, false)
})

test('buildTextReport 是 2000 字以内的摘要', () => {
  const model = demoModel()
  const text = buildTextReport(model)
  assert.ok(text.length <= 2000)
  assert.ok(text.indexOf('sess-demo') >= 0)
  assert.ok(text.indexOf('节省') >= 0)
  assert.ok(text.indexOf('f1') >= 0)
  const tight = buildTextReport(model, { maxChars: 200 })
  assert.ok(tight.length <= 200)
})

test('旧版系统提示只留作参考，从模型视角总量里扣掉', () => {
  const messages = [
    message('system', 'a'.repeat(1000), { seq: 1 }),
    message('system', 'b'.repeat(2000), { seq: 2 }),
    message('user', '开始', { source: { kind: 'user' } }),
  ]
  const model = buildReportModel({
    sessionId: 'sess-sys',
    derivedMessages: messages,
    folds: new Map(),
    pins: [],
    recalls: [],
    config: {},
    now: 1,
  })
  assert.equal(model.staleSystem.count, 1)
  assert.equal(model.staleSystem.chars, 1000)
  // 2000 字的当前提示 + 2 字的用户原话；1000 字的旧版提示被扣掉。
  assert.equal(model.folded.totals.chars, 2002)
  assert.equal(model.unfolded.totals.chars, 2002)
  assert.equal(model.folded.totals.chars + model.staleSystem.chars, 3002)
})

test('collectRecords 从 store 读出 fold / pin / recall', () => {
  const { folds } = fixture()
  const pins = [{ kind: 'pin', id: '结论', text: '正文', at: 20 }]
  const recalls = [{ kind: 'recall', id: 'f1', at: 10 }]
  const store = {
    folds: () => folds,
    pins: () => pins,
    readAll: () => [...folds.values(), ...pins, ...recalls],
  }
  const records = collectRecords(store)
  assert.equal(records.folds.size, 2)
  assert.equal(records.pins.length, 1)
  assert.equal(records.recalls.length, 1)
})

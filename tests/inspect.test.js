// 可视化报告的单元测试：喂假的派生消息与 fold 记录，覆盖统计、还原、HTML 与写盘。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildHtmlReport,
  buildReportModel,
  buildTextReport,
  collectRecords,
  reconstructUnfolded,
  summarizeModelView,
  writeReport,
} from '../lib/inspect.js'
import { registerInspectTool } from '../lib/inspect-tool.js'
import { makeCtx } from './fakes.js'

const silent = { info() {}, warn() {}, error() {} }

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
    config: { enabled: true, minFoldChars: 1200, recallReminderAfter: 3 },
    now: Date.UTC(2026, 10, 14, 4, 0, 0),
  })
}

test('summarizeModelView 统计角色、检查点、pin 与两档 token', () => {
  const { messages, folds } = fixture()
  const view = summarizeModelView({ derivedMessages: messages, folds })
  assert.equal(view.totals.count, messages.length)
  assert.equal(view.totals.checkpoints, 2)
  assert.equal(view.totals.pins, 1)

  const chars = view.messages.reduce((sum, item) => sum + item.chars, 0)
  assert.equal(view.totals.chars, chars)
  assert.equal(view.totals.tokens.low, Math.round(chars / 3.2))
  assert.equal(view.totals.tokens.high, Math.round(chars / 1.6))

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

test('summarizeModelView 支持注入 estimateTokens', () => {
  const { messages } = fixture()
  const view = summarizeModelView({ derivedMessages: messages, estimateTokens: (text) => text.length / 2 })
  assert.equal(view.totals.tokens.custom, Math.round(view.totals.chars / 2))
  // 注入失败时退回两档估算，不抛错。
  const broken = summarizeModelView({ derivedMessages: messages, estimateTokens: () => { throw new Error('boom') } })
  assert.equal(broken.totals.tokens.custom, undefined)
  assert.equal(broken.totals.tokens.high, Math.round(broken.totals.chars / 1.6))
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

test('buildHtmlReport 产出单文件中文报告，不引用外部资源', () => {
  const model = demoModel()
  const html = buildHtmlReport(model)
  const labels = ['概览', '折叠后', '不折叠', '节省', '事件时间线', '按轮对比', '折叠段明细', '模型视角', '不折叠视角', '召回', '重要消息', '部署路径', '未固化']
  for (const label of labels) {
    assert.ok(html.indexOf(label) >= 0, '缺少标签：' + label)
  }
  assert.ok(html.indexOf('<style>') >= 0)
  assert.ok(html.indexOf('<script>') >= 0)
  assert.ok(html.indexOf('http://') < 0)
  assert.ok(html.indexOf('https://') < 0)
  assert.ok(html.indexOf('<script src') < 0)
  assert.ok(html.indexOf('<link ') < 0)
  assert.ok(html.indexOf('charset="utf-8"') >= 0)
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

test('writeReport 真的在 fold-debug 目录写出 HTML', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-report-'))
  const html = '<!DOCTYPE html><html><body>ok</body></html>'
  const filePath = writeReport(homeDir, { sessionId: 'sess/demo', html })
  assert.equal(existsSync(filePath), true)
  assert.ok(filePath.endsWith('.html'))
  assert.ok(filePath.indexOf('fold-debug') >= 0)
  assert.ok(filePath.indexOf('sess_demo') >= 0)
  assert.equal(readFileSync(filePath, 'utf8'), html)
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

test('fold_inspect 工具生成报告文件，含召回与固化统计', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-inspect-'))
  const ctx = makeCtx()
  const { messages, folds } = fixture()
  const pins = [{ kind: 'pin', id: '部署路径', text: '在 E:\\dsh\\deploy.ps1', at: 3000 }]
  const recalls = [{ kind: 'recall', id: 'f1', at: 1500 }]
  const store = {
    folds: () => folds,
    pins: () => pins,
    readAll: () => [...folds.values(), ...pins, ...recalls],
    recallCount: (id) => recalls.filter((item) => item.id === id).length,
  }
  const session = { id: 'sess-tool', deriveMessages: () => messages }
  const tool = registerInspectTool({
    ctx,
    resolveSession: () => session,
    getStore: () => store,
    getConfig: () => ({ enabled: true, minFoldChars: 1200 }),
    homeDir,
    log: silent,
  })

  const definition = ctx.registrations.find((item) => item.name === 'fold_inspect')
  assert.ok(definition, '应当注册 fold_inspect')
  const result = await definition.execute({}, {})
  assert.equal(result.ok, true)
  assert.ok(result.path.indexOf('fold-debug') >= 0)
  assert.equal(existsSync(result.path), true)
  assert.ok(result.text.indexOf('报告文件') >= 0)

  const html = readFileSync(result.path, 'utf8')
  assert.ok(html.indexOf('sess-tool') >= 0)
  assert.ok(html.indexOf('已固化') >= 0)

  tool.dispose()
  assert.equal(ctx.registrations.length, 0)
})

test('fold_inspect 能按 sessionId 找会话，找不到时明确失败', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-inspect-'))
  const ctx = makeCtx()
  const { messages, folds } = fixture()
  const other = { id: 'sess-other', deriveMessages: () => messages }
  ctx.get = (name) => {
    if (name !== 'sessions') return null
    return { get: (id) => (id === 'sess-other' ? other : undefined) }
  }
  const tool = registerInspectTool({
    ctx,
    resolveSession: () => undefined,
    getStore: () => ({ folds: () => folds, pins: () => [], readAll: () => [...folds.values()] }),
    getConfig: () => ({}),
    homeDir,
    log: silent,
  })
  const definition = ctx.registrations.find((item) => item.name === 'fold_inspect')
  const found = await definition.execute({ sessionId: 'sess-other' }, {})
  assert.equal(found.ok, true)
  assert.ok(found.path.indexOf('sess-other') >= 0)

  const missing = await definition.execute({ sessionId: 'nope' }, {})
  assert.equal(missing.ok, false)
  assert.ok(missing.text.indexOf('nope') >= 0)
  tool.dispose()
})

test('工具执行异常时 fail-open 返回失败原因', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-inspect-'))
  const ctx = makeCtx()
  const session = { id: 'sess-x', deriveMessages: () => { throw new Error('boom') } }
  const tool = registerInspectTool({
    ctx,
    resolveSession: () => session,
    getStore: () => ({ folds: () => new Map(), pins: () => [], readAll: () => [] }),
    getConfig: () => ({}),
    homeDir,
    log: silent,
  })
  const definition = ctx.registrations.find((item) => item.name === 'fold_inspect')
  const result = await definition.execute({}, {})
  assert.equal(result.ok, false)
  assert.ok(result.text.indexOf('boom') >= 0)
  tool.dispose()
})

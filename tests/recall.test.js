import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildFoldIndex,
  describeFold,
  foldParts,
  kindChoices,
  normalizePartSelectors,
  renderFoldParts,
  selectFoldParts,
} from '../lib/recall.js'

function record(overrides = {}) {
  return {
    kind: 'fold',
    id: 'f1',
    turn: 2,
    at: 1,
    chars: 900,
    note: '【已折叠历史】 第 2 轮已折叠，原文用 fold_recall("f1") 召回',
    items: [
      { seq: 11, text: '[思考] 先看目录\n再看配置' },
      { seq: 12, text: '[回复] 开始搬' },
      { seq: 13, text: '[调用 run_code] {"code":"1"}' },
      { seq: 14, text: '[工具结果] 完成' },
    ],
    ...overrides,
  }
}

test('foldParts 按行首前缀拆段，段号连续且 chars 不算前缀', () => {
  const parts = foldParts(record())
  assert.deepEqual(parts.map((part) => part.no), [1, 2, 3, 4])
  assert.deepEqual(parts.map((part) => part.kind), ['think', 'reply', 'call', 'result'])
  assert.equal(parts[0].text, '[思考] 先看目录\n再看配置')
  assert.equal(parts[0].chars, '先看目录\n再看配置'.length)
  assert.equal(parts[2].label, '调用 run_code')
  assert.equal(parts[2].name, 'run_code')
  assert.equal(parts[0].seq, 11)
})

test('buildFoldIndex 给出目录、段号、类型与预览', () => {
  const index = buildFoldIndex(record(), { previewChars: 20 })
  assert.match(index, /折叠 f1（第 2 轮/)
  assert.match(index, /共 4 段/)
  assert.match(index, /#1 \[思考\]/)
  assert.match(index, /#4 \[工具结果\]/)
  assert.match(index, /先看目录/)
  assert.match(index, /parts:\["1","3-5"\]/)
  assert.match(index, /合计：思考 1 段/)
})

test('buildFoldIndex 超预算时按行截断并说明剩余段号', () => {
  const record = {
    kind: 'fold',
    id: 'f2',
    turn: 3,
    items: Array.from({ length: 30 }, (_, index) => ({ seq: index + 1, text: '[思考] ' + 'x'.repeat(200) })),
  }
  const index = buildFoldIndex(record, { maxChars: 400, previewChars: 10 })
  assert.ok(index.length <= 400)
  assert.match(index, /目录已截断/)
  assert.match(index, /还有 \d+ 段没列出来/)
})

test('normalizePartSelectors 接受数组与逗号/空白分隔字符串', () => {
  assert.deepEqual(normalizePartSelectors(['1', '4-6']), ['1', '4-6'])
  assert.deepEqual(normalizePartSelectors('1, 3-5  7'), ['1', '3-5', '7'])
  assert.equal(normalizePartSelectors(undefined), null)
  assert.equal(normalizePartSelectors('  '), null)
})

test('selectFoldParts 支持段号、区间与类型别名，未知项单独返回', () => {
  const parts = foldParts(record())
  const single = selectFoldParts(parts, ['1'])
  assert.deepEqual(single.picked.map((part) => part.no), [1])
  const range = selectFoldParts(parts, ['3-4'])
  assert.deepEqual(range.picked.map((part) => part.no), [3, 4])
  const tools = selectFoldParts(parts, ['tools'])
  assert.deepEqual(tools.picked.map((part) => part.no), [3, 4])
  const mixed = selectFoldParts(parts, ['1', 'bogus', '9'])
  assert.deepEqual(mixed.picked.map((part) => part.no), [1])
  assert.deepEqual(mixed.unknown, ['bogus', '9'])
  const all = selectFoldParts(parts, ['all'])
  assert.equal(all.picked.length, 4)
  const sorted = selectFoldParts(parts, ['4', '1'])
  assert.deepEqual(sorted.picked.map((part) => part.no), [1, 4])
})

test('renderFoldParts 只回选中的段，超预算时说明漏了几段', () => {
  const parts = foldParts(record())
  const picked = parts.slice(0, 2)
  const text = renderFoldParts(record(), picked, { total: parts.length, maxChars: 24000 })
  assert.match(text, /取回 2\/4 段/)
  assert.match(text, /--- #1 思考 ---/)
  assert.match(text, /--- #2 回复 ---/)
  assert.equal(text.includes('--- #3'), false)
  assert.match(text, /还有 2 段没有取回/)
})

test('renderFoldParts 单次预算不够时截断并提示再召回', () => {
  const record = {
    kind: 'fold',
    id: 'f3',
    turn: 4,
    items: [
      { seq: 1, text: '[思考] ' + 'a'.repeat(300) },
      { seq: 2, text: '[回复] ' + 'b'.repeat(300) },
    ],
  }
  const parts = foldParts(record)
  const text = renderFoldParts(record, parts, { total: parts.length, maxChars: 200 })
  assert.match(text, /还有 1 段没取回/)
})

test('kindChoices 只列真的存在的类型，没有回复段就不提 reply', () => {
  const withReply = kindChoices(foldParts(record()))
  assert.match(withReply, /think（思考）/)
  assert.match(withReply, /reply（回复）/)
  assert.match(withReply, /tools（调用与工具结果）/)
  assert.match(withReply, /all（全部）/)

  const onlyThink = record({ items: [{ seq: 1, text: '[思考] 只有思考' }, { seq: 2, text: '[工具结果] 结果' }] })
  const noReply = kindChoices(foldParts(onlyThink))
  assert.equal(noReply.includes('reply'), false)
  assert.match(noReply, /think（思考）/)
  assert.match(noReply, /tools（调用与工具结果）/)

  const index = buildFoldIndex(record({ items: [{ seq: 1, text: '[思考] 只有思考' }] }), { previewChars: 10 })
  assert.equal(index.includes('reply'), false)
})

test('describeFold 保留整段返回的旧格式', () => {
  const text = describeFold(record())
  assert.match(text, /^折叠 f1（第 2 轮，原文约 900 字，≈225 token）/)
  assert.match(text, /--- #11 ---/)
  assert.match(text, /\[回复\] 开始搬/)
})

test('renderFoldParts 对单个超大段也截断到上限内', () => {
  const huge = { kind: 'fold', id: 'f9', turn: 1, items: [{ seq: 1, text: '[工具结果] ' + 'x'.repeat(100000) }] }
  const parts = foldParts(huge)
  const text = renderFoldParts(huge, parts, { total: 1, maxChars: 1000 })
  // 早先第一段无论多大都整段放入：100,000 字的段会原样塞回来。
  assert.ok(text.length <= 1000, '单段不能突破上限，实际 ' + text.length)
  assert.match(text, /本段已截断/)
})

test('normalizePartSelectors 接受数字段号', () => {
  assert.deepEqual(normalizePartSelectors([1, '3-5']), ['1', '3-5'])
})

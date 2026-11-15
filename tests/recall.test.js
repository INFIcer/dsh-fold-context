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

test('回复完整写入检查点时，召回不再返回回复段', () => {
  const kept = record({ replyTruncated: false })
  assert.deepEqual(foldParts(kept).map((part) => part.kind), ['think', 'call', 'result'])
  assert.ok(!describeFold(kept).includes('[回复]'), describeFold(kept))
  // 回复被截断（或没有标记的旧记录）时仍能召回全文。
  assert.deepEqual(foldParts(record({ replyTruncated: true })).map((part) => part.kind), ['think', 'reply', 'call', 'result'])
  assert.ok(describeFold(record({ replyTruncated: true })).includes('[回复] 开始搬'))
  assert.deepEqual(foldParts(record()).map((part) => part.kind), ['think', 'reply', 'call', 'result'])
})

test('整段召回按块剔除回复：多行回复不会留下孤儿行', () => {
  const rec = {
    kind: 'fold',
    id: 'f3',
    turn: 5,
    chars: 200,
    replyTruncated: false,
    items: [
      { seq: 1, text: '[思考] 想了一下\n[回复] 第一行\n第二行\n第三行\n[调用 edit] {"a":1}' },
      { seq: 2, text: '[回复] 只有回复的一段' },
      { seq: 3, text: '[工具结果] 完成' },
    ],
  }
  const text = describeFold(rec)
  // 早先按行过滤只删掉带前缀的首行，回复正文的其它行会以孤儿行留在原处，
  // 既跟检查点里的回复重复，又读不出它原本属于哪一段。
  assert.equal(text.includes('[回复]'), false)
  assert.equal(text.includes('第二行'), false, text)
  assert.equal(text.includes('第三行'), false, text)
  assert.equal(text.includes('[思考] 想了一下'), true)
  assert.equal(text.includes('[调用 edit]'), true)
  assert.equal(text.includes('[工具结果] 完成'), true)
  // 只有回复的节点整条不出现，也不会单独留一个空标题。
  assert.equal(text.includes('--- #2 ---'), false)
})

test('长 markdown 回复超过召回额度时按标题切段，短回复仍整段', () => {
  const md = '## 结论\n' + 'a'.repeat(120) + '\n## 改动\n' + 'b'.repeat(120) + '\n## 验证\n' + 'c'.repeat(120)
  const rec = { kind: 'fold', id: 'f8', turn: 3, items: [{ seq: 1, text: '[回复] ' + md }] }
  // 阈值就是单次召回额度：不传时保持原有的整段召回。
  assert.equal(foldParts(rec).length, 1)
  const split = foldParts(rec, { replySplitChars: 100 })
  assert.deepEqual(split.map((part) => part.no), [1, 2, 3])
  assert.deepEqual(split.map((part) => part.kind), ['reply', 'reply', 'reply'])
  assert.ok(split[0].text.startsWith('[回复] ## 结论'), split[0].text)
  assert.equal(split[0].chars, ('## 结论\n' + 'a'.repeat(120)).length)

  const index = buildFoldIndex(rec, { parts: split, previewChars: 12 })
  assert.match(index, /共 3 段/)
  assert.match(index, /#1 \[回复\]/)
  assert.match(index, /## 结论/)
  assert.match(index, /#3 \[回复\]/)
})

test('标题前的导语单独成段；未截断的回复不参与切段', () => {
  const md = '前言\n\n## 甲\n' + 'a'.repeat(120) + '\n## 乙\n' + 'b'.repeat(120)
  const rec = { kind: 'fold', id: 'f9', turn: 4, items: [{ seq: 1, text: '[回复] ' + md }] }
  const parts = foldParts(rec, { replySplitChars: 100 })
  assert.equal(parts.length, 3)
  assert.equal(parts[0].chars, '前言'.length)
  assert.ok(parts[0].text.startsWith('[回复] 前言'))
  // 检查点里已完整保留回复时不返回回复段，也就没有切段。
  assert.deepEqual(foldParts({ ...rec, replyTruncated: false }, { replySplitChars: 100 }), [])
})

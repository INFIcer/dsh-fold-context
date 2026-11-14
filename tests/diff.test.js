// 逐行差异：只用来在「模型视角」页里显示系统提示词改了什么。
// 输入是两段原始文本，输出是可直接渲染的 hunk 列表；这里覆盖边界与预算。

import test from 'node:test'
import assert from 'node:assert/strict'

import { diffLines } from '../lib/diff.js'

test('完全相同的两段文本不产生差异', () => {
  const result = diffLines('a\nb\nc', 'a\nb\nc')
  assert.equal(result.same, true)
  assert.equal(result.add, 0)
  assert.equal(result.del, 0)
  assert.deepEqual(result.hunks, [])
})

test('纯增与纯删', () => {
  const added = diffLines('a\nb', 'a\nb\nc')
  assert.equal(added.same, false)
  assert.equal(added.add, 1)
  assert.equal(added.del, 0)
  assert.equal(added.hunks[0].lines.filter((line) => line.t === 'add').length, 1)

  const removed = diffLines('a\nb\nc', 'a\nc')
  assert.equal(removed.add, 0)
  assert.equal(removed.del, 1)
  assert.equal(removed.hunks[0].lines.filter((line) => line.t === 'del').length, 1)
})

test('改一行时上下文行带前后各两行', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7'].join('\n')
  const after = ['1', '2', '3', 'X', '5', '6', '7'].join('\n')
  const result = diffLines(before, after, { context: 2 })
  assert.equal(result.add, 1)
  assert.equal(result.del, 1)
  assert.equal(result.hunks.length, 1)
  const types = result.hunks[0].lines.map((line) => line.t)
  assert.deepEqual(types, ['ctx', 'ctx', 'del', 'add', 'ctx', 'ctx'])
})

test('超长行被截断并标记 clipped', () => {
  const long = 'x'.repeat(200)
  const result = diffLines('a\n' + long, 'a\n' + long + 'y', { lineCap: 40 })
  assert.equal(result.clipped, true)
  const touched = result.hunks[0].lines.find((line) => line.t === 'add' || line.t === 'del')
  assert.match(touched.text, /…（本行还有 \d+ 字）$/)
})

test('改动太多时按 maxDiffLines 截断', () => {
  const before = []
  const after = []
  for (let i = 0; i < 40; i += 1) {
    before.push('old ' + i)
    after.push('new ' + i)
  }
  const result = diffLines(before.join('\n'), after.join('\n'), { maxDiffLines: 6 })
  assert.equal(result.truncated, true)
  const lines = result.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  assert.ok(lines <= 6)
})

test('两段都为空时视为相同', () => {
  const result = diffLines('', '')
  assert.equal(result.same, true)
})

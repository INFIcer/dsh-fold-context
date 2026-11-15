// markdown 标题与分段：只在需要摘要或多级召回时使用，短内容不经过这里。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { headingsOf, outlineOf, splitSections } from '../lib/markdown.js'

test('headingsOf 只认 ATX 标题，跳过围栏代码块内的 #', () => {
  const text = [
    '# 总览',
    '```js',
    '# 注释不是标题',
    '```',
    '## 细节 ##',
    '#没空格不是标题',
    '#\u3000全角空格',
  ].join('\n')
  const headings = headingsOf(text)
  assert.deepEqual(headings.map((heading) => heading.level), [1, 2, 1])
  assert.deepEqual(headings.map((heading) => heading.title), ['总览', '细节', '全角空格'])
  assert.deepEqual(headings.map((heading) => heading.line), [0, 4, 6])
  assert.equal(headings[1].text, '## 细节')
})

test('headingsOf 围栏未闭合时后面全算代码', () => {
  const text = ['```', '## 假标题', '#### 也是假的'].join('\n')
  assert.deepEqual(headingsOf(text), [])
})

test('outlineOf 至少两个标题才给目录', () => {
  assert.equal(outlineOf('只有一段正文'), null)
  assert.equal(outlineOf('# 只有一个标题\n正文'), null)
  const outline = outlineOf('# 甲\n正文\n## 乙\n正文')
  assert.deepEqual(outline, { count: 2, text: '# 甲 / ## 乙' })
})

test('splitSections 按标题切节，标题前的导语单独成节', () => {
  const sections = splitSections('前言\n\n## 甲\naaa\n\n## 乙\nbbb')
  assert.equal(sections.length, 3)
  assert.deepEqual(sections[0], { level: 0, title: '', text: '前言' })
  assert.equal(sections[1].level, 2)
  assert.equal(sections[1].title, '甲')
  assert.equal(sections[1].text, '## 甲\naaa')
  assert.equal(sections[2].text, '## 乙\nbbb')
})

test('splitSections 标题不足两个时切不开', () => {
  assert.equal(splitSections('一段普通回复'), null)
  assert.equal(splitSections('# 只有一个标题\n正文'), null)
  // 代码块里的 # 不算标题，不能把回复切碎。
  assert.equal(splitSections('## 甲\n正文\n```\n## 代码注释\n```'), null)
})

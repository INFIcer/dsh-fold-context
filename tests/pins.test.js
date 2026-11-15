import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pinBodyOf, pinCharsOf, resolvePins } from '../lib/pins.js'
import { pinPrefix } from '../lib/constants.js'

const pin = (label, body) => ({ kind: 'pin', id: label, turn: 3, at: 300, text: body })

test('拿不到会话时按载荷记录算，present 留空表示未知', () => {
  const list = resolvePins([pin('P1', 'abc')], null)
  assert.equal(list.length, 1)
  assert.equal(list[0].present, null)
  assert.equal(list[0].recorded, true)
  assert.equal(list[0].chars, pinCharsOf('P1', 'abc'))
  assert.equal(list[0].chars, (pinPrefix + ' P1\nabc').length)
})

test('上下文里有几条就算几条：记录只补轮次，没记录的那条也照算', () => {
  const legacy = pinPrefix + ' 遗留\n' + 'z'.repeat(80)
  const list = resolvePins(
    [pin('P1', 'abc')],
    [
      { label: 'P1', text: pinPrefix + ' P1\nabc' },
      { label: '遗留', text: legacy },
    ],
  )
  assert.equal(list.length, 2)
  const known = list.find((row) => row.id === 'P1')
  assert.equal(known.recorded, true)
  assert.equal(known.turn, 3)
  // 正文剥掉「前缀 + 标题」那一行，字数取整条消息——它在上下文里就是这么多字。
  assert.equal(known.text, 'abc')
  assert.equal(known.chars, (pinPrefix + ' P1\nabc').length)
  const orphan = list.find((row) => row.id === '遗留')
  assert.equal(orphan.recorded, false)
  assert.equal(orphan.present, true)
  assert.equal(orphan.turn, 0)
  assert.equal(orphan.chars, legacy.length)
})

test('记录里有、上下文里没了：标成卷走，不再占位置', () => {
  const list = resolvePins(
    [pin('P1', 'abc'), pin('P2', 'gone')],
    [{ label: 'P1', text: pinPrefix + ' P1\nabc' }],
  )
  const lost = list.find((row) => row.id === 'P2')
  assert.equal(lost.present, false)
  assert.equal(lost.chars, pinCharsOf('P2', 'gone'))
})

test('兼容只给标题集合的旧调用方', () => {
  const list = resolvePins([pin('P1', 'abc'), pin('P2', 'gone')], new Set(['P1']))
  assert.equal(list.find((row) => row.id === 'P1').present, true)
  assert.equal(list.find((row) => row.id === 'P2').present, false)
})

test('同一标题发布过两次时各自成行（订正后重发是两条消息）', () => {
  const body = pinPrefix + ' P\nnew'
  const list = resolvePins(
    [pin('P', 'old'), pin('P', 'new')],
    [{ label: 'P', text: pinPrefix + ' P\nold' }, { label: 'P', text: body }],
  )
  assert.equal(list.length, 2)
  assert.ok(list.every((row) => row.present === true && row.recorded === true))
})

test('同一条消息被记了两遍：多出来的那条标成重复，不是被卷走', () => {
  const same = pin('P', 'dup')
  const list = resolvePins([same, { ...same, turn: 7 }], [{ label: 'P', text: pinPrefix + ' P\ndup' }])
  assert.equal(list.length, 2)
  const live = list.find((row) => row.present === true)
  assert.equal(live.duplicate, undefined)
  const extra = list.find((row) => row.present === false)
  assert.equal(extra.duplicate, true)
  assert.equal(extra.chars, pinCharsOf('P', 'dup'))
})

test('标题相同但正文不同：配对认正文，旧版本标成被取代而不是卷走', () => {
  const list = resolvePins(
    [pin('P', 'old'), pin('P', 'new')],
    [{ label: 'P', text: pinPrefix + ' P\nnew' }],
  )
  // 上下文里是 new 那条：配对要认正文，不能拿同标题的旧记录顶上，
  // 否则留下的「新记录」会被判成被压缩卷走——而那正是模型看得见的正文。
  const live = list.find((row) => row.present === true)
  assert.equal(live.text, 'new')
  const gone = list.find((row) => row.present === false)
  assert.equal(gone.text, 'old')
  assert.equal(gone.duplicate, false)
  assert.equal(gone.superseded, true)
  assert.equal(live.superseded, undefined)
})

test('同标题的旧版本被取代，与真被卷走区分开', () => {
  const list = resolvePins(
    [pin('P', 'old'), pin('P', 'new'), pin('G', 'gone')],
    [{ label: 'P', text: pinPrefix + ' P\nnew' }],
  )
  assert.equal(list.find((row) => row.text === 'old').superseded, true)
  const gone = list.find((row) => row.id === 'G')
  assert.equal(gone.present, false)
  assert.equal(gone.superseded, false)
  assert.equal(gone.duplicate, false)
})

test('pinBodyOf 只剥第一行标题', () => {
  assert.equal(pinBodyOf(pinPrefix + ' X\nhello\nworld', 'X'), 'hello\nworld')
  assert.equal(pinBodyOf('没有前缀的正文', 'X'), '没有前缀的正文')
  assert.equal(pinBodyOf(pinPrefix + ' X', 'X'), '')
})

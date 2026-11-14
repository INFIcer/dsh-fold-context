// 逐轮视图的分组规则：系统提示词不参与折叠、用户消息开一轮、轮尾产物归本轮。
// 这些规则决定报告里「第几轮」归谁，错一格整个报告就是错的，所以单独覆盖。

import test from 'node:test'
import assert from 'node:assert/strict'

import { blocksOfFoldItem, blocksOfMessage, buildTurnGroups, entryKindOf } from '../lib/turns.js'

function entry(patch) {
  return {
    role: 'assistant',
    sourceKind: 'model',
    isCheckpoint: false,
    isPin: false,
    foldId: undefined,
    chars: 10,
    text: '',
    blocks: [],
    foldRecord: undefined,
    ...patch,
  }
}

function userEntry(text) {
  return entry({ role: 'user', sourceKind: 'user', text, chars: text.length, blocks: [{ kind: 'text', name: '', text }] })
}

function assistantEntry(text) {
  const blocks = [{ kind: 'reply', name: '', text }]
  return entry({ role: 'assistant', sourceKind: 'model', text, chars: text.length, blocks, foldRecord: undefined })
}

function checkpointEntry({ foldId, noteChars, items, text, turn }) {
  return entry({
    role: 'user',
    sourceKind: 'fold-checkpoint',
    isCheckpoint: true,
    foldId,
    chars: noteChars,
    text: text || '【已折叠历史】' + foldId,
    blocks: [],
    foldRecord: { id: foldId, turn: typeof turn === 'number' ? turn : null, chars: noteChars, items },
  })
}

test('blocksOfMessage 把思考、回复、工具调用拆开', () => {
  const message = {
    content: [
      { type: 'reasoning', text: '想一想' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      { type: 'text', text: '说一句' },
    ],
  }
  const blocks = blocksOfMessage(message, 'assistant')
  assert.deepEqual(blocks.map((block) => block.kind), ['think', 'call', 'reply'])
  assert.equal(blocks[1].name, 'read')
  const toolBlocks = blocksOfMessage({ content: [{ type: 'text', text: '结果' }] }, 'tool')
  assert.equal(toolBlocks[0].kind, 'result')
})

test('blocksOfFoldItem 按行首前缀还原折叠载荷', () => {
  const text = '[思考] 想一想\n[回复] 说一句\n[调用 read] {}\n[工具结果] 结果'
  const blocks = blocksOfFoldItem(text)
  assert.deepEqual(blocks.map((block) => block.kind), ['think', 'reply', 'call', 'result'])
  assert.equal(blocks[2].name, 'read')
  assert.equal(blocks[1].text, '说一句')
})

test('entryKindOf 认得调度器投递的用户指令', () => {
  assert.equal(entryKindOf(entry({ role: 'user', sourceKind: 'user' })), 'user')
  assert.equal(entryKindOf(entry({ role: 'user', sourceKind: 'schedule' })), 'user')
  assert.equal(entryKindOf(entry({ role: 'user', sourceKind: 'runtime-context' })), 'inject')
  assert.equal(entryKindOf(entry({ role: 'system' })), 'system')
  assert.equal(entryKindOf(entry({ isCheckpoint: true })), 'checkpoint')
  assert.equal(entryKindOf(entry({ isPin: true })), 'pin')
})

test('系统提示词抽成单独一块，绝不进任何一轮', () => {
  const groups = buildTurnGroups({
    entries: [
      entry({ role: 'system', chars: 100, text: '系统' }),
      userEntry('第一句'),
      assistantEntry('答一句'),
    ],
    minFoldChars: 1000,
  })
  assert.equal(groups[0].kind, 'system')
  assert.equal(groups[0].chars, 100)
  assert.equal(groups.length, 2)
  assert.equal(groups[1].turn, 1)
  assert.deepEqual(groups[1].entries.map((item) => item.role), ['user', 'assistant'])
})

test('中间出现的系统消息也抽走，不打断当前轮', () => {
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      assistantEntry('答一句'),
      entry({ role: 'system', chars: 50, text: '更新' }),
      assistantEntry('再答一句'),
    ],
    minFoldChars: 1,
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.equal(turnGroups.length, 1)
  assert.equal(turnGroups[0].entries.length, 3)
  assert.equal(groups[0].kind, 'system')
  assert.equal(groups[0].entries.length, 1)
})

test('轮结束后落地的折叠检查点归上一轮，不另开一轮', () => {
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      assistantEntry('答'.repeat(50)),
      checkpointEntry({ foldId: 'f1', noteChars: 20, items: [{ seq: 3, chars: 50, blocks: [{ kind: 'reply', name: '', text: '答'.repeat(50) }] }] }),
      userEntry('第二句'),
      assistantEntry('答二'),
    ],
    minFoldChars: 10,
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.equal(turnGroups.length, 2)
  assert.deepEqual(turnGroups[0].foldIds, ['f1'])
  assert.equal(turnGroups[0].folded, true)
  assert.equal(turnGroups[1].folded, false)
  assert.equal(turnGroups[1].turn, 2)
})

test('折叠轮没留回复原文时，把摘要里的回复开头当预览', () => {
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      checkpointEntry({
        foldId: 'f1',
        noteChars: 60,
        text: '【已折叠历史】第 1 轮已折叠\n· 思考 2 段，约 300 字\n· 回复约 120 字，开头「安装已生效，接着验证」，结尾「…再补一句」',
        items: [{ seq: 3, chars: 200, blocks: [{ kind: 'think', name: '', text: '想' }] }],
      }),
    ],
    minFoldChars: 10,
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.equal(turnGroups[0].replyText, '')
  assert.equal(turnGroups[0].replyNote, '安装已生效，接着验证')
})

test('轮次按用户消息顺序编号；第一个折叠轮之前标插件生效前', () => {
  const big = 'x'.repeat(2000)
  const groups = buildTurnGroups({
    entries: [
      userEntry('旧一轮'),
      assistantEntry(big),
      userEntry('新一轮'),
      checkpointEntry({ foldId: 'f9', noteChars: 30, items: [{ seq: 9, chars: 2000, blocks: [{ kind: 'reply', name: '', text: big }] }] }),
    ],
    minFoldChars: 1000,
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.equal(turnGroups[0].turn, 1)
  assert.equal(turnGroups[0].prePlugin, true)
  assert.equal(turnGroups[1].turn, 2)
  assert.equal(turnGroups[1].prePlugin, false)
})

test('轮次以折叠记录里的 turn 为准，前后按相邻轮次推断', () => {
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      assistantEntry('答'),
      userEntry('第二句'),
      checkpointEntry({
        foldId: 'f3',
        noteChars: 30,
        turn: 3,
        items: [{ seq: 5, chars: 400, blocks: [{ kind: 'reply', name: '', text: '答'.repeat(50) }] }],
      }),
      userEntry('第四句'),
    ],
    minFoldChars: 10,
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.deepEqual(turnGroups.map((group) => group.turn), [2, 3, 4])
  assert.equal(turnGroups[0].prePlugin, true)
  assert.equal(turnGroups[1].folded, true)
})

test('没折叠且内容太少时标为内容较少', () => {
  const groups = buildTurnGroups({
    entries: [userEntry('短'), assistantEntry('短答')],
    minFoldChars: 1000,
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.equal(turnGroups[0].short, true)
})

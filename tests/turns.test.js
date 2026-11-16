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
  const text = '[思考] 想一想\n[回复] 说一句\n[调用 read] {}\n[调用 grep] {}'
  const blocks = blocksOfFoldItem(text)
  assert.deepEqual(blocks.map((block) => block.kind), ['think', 'reply', 'call', 'call'])
  assert.equal(blocks[2].name, 'read')
  assert.equal(blocks[1].text, '说一句')
})

test('工具结果整段不拆：正文里出现 [回复]/[思考] 字样也不当标记', () => {
  const text = '[工具结果] 文件内容：\n[回复] 这是源码里的字符串\n[思考] 这行也不是思考'
  const blocks = blocksOfFoldItem(text)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'result')
  assert.ok(blocks[0].text.indexOf('[回复] 这是源码里的字符串') >= 0)
  assert.ok(blocks[0].text.indexOf('[思考] 这行也不是思考') >= 0)
})

test('助手段里回复正文引用 [思考] 时，不切出假的思考段', () => {
  const text = '[回复] 我改的是这一行：\n[思考] 标记在提示词里\n就这样'
  const blocks = blocksOfFoldItem(text)
  assert.deepEqual(blocks.map((block) => block.kind), ['reply'])
  assert.ok(blocks[0].text.indexOf('[思考] 标记在提示词里') >= 0)
})

test('注入消息里带标记也不拆，整段算一条上下文注入', () => {
  const text = '[注入消息] <system-reminder>\n[回复] 不是回复'
  const blocks = blocksOfFoldItem(text)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'inject')
})

test('entryKindOf 认得调度器投递的用户指令', () => {
  assert.equal(entryKindOf(entry({ role: 'user', sourceKind: 'user' })), 'user')
  assert.equal(entryKindOf(entry({ role: 'user', sourceKind: 'schedule' })), 'user')
  assert.equal(entryKindOf(entry({ role: 'user', sourceKind: 'runtime-context' })), 'inject')
  assert.equal(entryKindOf(entry({ role: 'system' })), 'system')
  assert.equal(entryKindOf(entry({ isCheckpoint: true })), 'checkpoint')
  assert.equal(entryKindOf(entry({ isPin: true })), 'pin')
})

test('系统提示词按出现时间单独成块，绝不进任何一轮', () => {
  const groups = buildTurnGroups({
    entries: [
      entry({ role: 'system', chars: 100, text: '系统' }),
      userEntry('第一句'),
      assistantEntry('答一句'),
    ],
  })
  assert.deepEqual(groups.map((group) => group.kind), ['system', 'turn'])
  assert.equal(groups[0].chars, 100)
  assert.equal(groups[0].version, 1)
  assert.equal(groups[0].diff, null)
  assert.equal(groups[1].turn, 1)
  assert.deepEqual(groups[1].entries.map((item) => item.role), ['user', 'assistant'])
})

test('会话开头的运行期通知并进第一轮，不单开一个空轮', () => {
  const groups = buildTurnGroups({
    entries: [
      entry({ role: 'system', chars: 100, text: '系统' }),
      entry({ role: 'user', sourceKind: 'runtime-context', text: '通知', chars: 2 }),
      userEntry('第一句'),
      assistantEntry('答一句'),
      userEntry('第二句'),
      assistantEntry('答二句'),
    ],
  })
  // 通知不是用户开的轮：单开会多出一个没有回复的空轮，把后续轮次号整体推后一位。
  assert.deepEqual(groups.map((group) => group.kind), ['system', 'turn', 'turn'])
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.deepEqual(turnGroups.map((group) => group.turn), [1, 2])
  assert.equal(turnGroups[0].chars, 2 + 3 + 3)
  assert.equal(turnGroups[0].steps, 1)
})

test('fork 种子里的折叠检查点仍单独成组：轮号从检查点续下去', () => {
  const groups = buildTurnGroups({
    entries: [
      entry({ role: 'system', chars: 100, text: '系统' }),
      checkpointEntry({ foldId: 'f5', noteChars: 30, turn: 5, items: [] }),
      userEntry('继续'),
      assistantEntry('答'),
    ],
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.equal(turnGroups.length, 2)
  assert.equal(turnGroups[0].turn, 5)
  assert.equal(turnGroups[1].turn, 6)
})

test('轮中出现的系统提示词就地切开当前轮，不并入相邻轮', () => {
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      assistantEntry('答一句'),
      entry({ role: 'system', chars: 50, text: '更新' }),
      assistantEntry('再答一句'),
    ],
  })
  assert.deepEqual(groups.map((group) => group.kind), ['turn', 'system', 'turn'])
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.equal(turnGroups.length, 2)
  assert.equal(turnGroups[0].entries.length, 2)
  assert.equal(turnGroups[1].entries.length, 1)
})

test('后一版系统提示词只带与前一版的差异，且系统块不参与轮次编号', () => {
  const groups = buildTurnGroups({
    entries: [
      entry({ role: 'system', chars: 5, text: 'a\nb\nc' }),
      userEntry('第一句'),
      assistantEntry('答一句'),
      entry({ role: 'system', chars: 5, text: 'a\nB\nc' }),
    ],
  })
  assert.deepEqual(groups.map((group) => group.kind), ['system', 'turn', 'system'])
  assert.equal(groups[2].version, 2)
  assert.equal(groups[2].diffOf, 1)
  assert.equal(groups[2].diff.add, 1)
  assert.equal(groups[2].diff.del, 1)
  assert.equal(groups.filter((group) => group.kind === 'turn').length, 1)
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
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.deepEqual(turnGroups.map((group) => group.turn), [2, 3, 4])
  assert.equal(turnGroups[0].prePlugin, true)
  assert.equal(turnGroups[1].folded, true)
})

test('下一轮的触发消息被折掉时，用检查点里的 turn 换轮', () => {
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      assistantEntry('答一段'),
      checkpointEntry({ foldId: 'f1', turn: 1, noteChars: 30, items: [] }),
      // 第二轮的触发消息（调度器投递）被折进 f2，模型视角里只剩一条检查点。
      checkpointEntry({
        foldId: 'f2',
        turn: 2,
        noteChars: 30,
        items: [{ seq: 7, chars: 200, blocks: [{ kind: 'reply', name: '', text: '答二' }] }],
      }),
      userEntry('第三句'),
    ],
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.deepEqual(turnGroups.map((group) => group.turn), [1, 2, 3])
  assert.deepEqual(turnGroups[1].foldIds, ['f2'])
  assert.equal(turnGroups[1].steps, 1)
})

test('同一轮被切成多条检查点时不换轮', () => {
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      checkpointEntry({ foldId: 'f1a', turn: 1, noteChars: 20, items: [] }),
      checkpointEntry({ foldId: 'f1b', turn: 1, noteChars: 20, items: [] }),
    ],
  })
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  assert.equal(turnGroups.length, 1)
  assert.deepEqual(turnGroups[0].foldIds, ['f1a', 'f1b'])
})

test('召回调用标在条目与折叠段上，并汇总到轮次标签', () => {
  // 真实数据里工具参数是 JSON 字符串：run_code 的脚本在 code 字段里，扫描前要先解码。
  const nested = 'const q = await tools.fold_recall({ query: "lib/web.js" });\nconst r = await tools.fold_recall({ id: "f1c", parts: ["48"] });'
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      entry({
        role: 'assistant',
        blocks: [{ kind: 'call', name: 'fold_recall', text: '{"id":"f3","parts":["1","3-5"]}' }],
      }),
      entry({ role: 'assistant', blocks: [{ kind: 'call', name: 'run_code', text: JSON.stringify({ code: nested }) }] }),
      // 参数里只是引用了字样、没有真的调用：不算召回。
      entry({ role: 'assistant', blocks: [{ kind: 'call', name: 'run_code', text: JSON.stringify({ code: 'const example = "tools.fold_recall(";' }) }] }),
      checkpointEntry({
        foldId: 'f1c',
        noteChars: 20,
        items: [
          { seq: 5, chars: 20, blocks: [{ kind: 'call', name: 'fold_recall', text: '{"query":"fold-view MB 17"}' }] },
          { seq: 6, chars: 10, blocks: [{ kind: 'reply', name: '', text: '答一句' }] },
        ],
      }),
    ],
    recallCounts: new Map([['f1c', 2]]),
  })
  const turn = groups.find((group) => group.kind === 'turn')
  assert.equal(turn.recallCallCount, 2)
  assert.equal(turn.recallSearchCount, 2)
  assert.equal(turn.recalledCount, 2)

  const direct = turn.entries[1]
  assert.deepEqual(direct.recallCalls, [{ id: 'f3', query: '', parts: '1,3-5', via: '' }])
  const nestedEntry = turn.entries[2]
  assert.deepEqual(nestedEntry.recallCalls.map((call) => [call.id, call.query, call.via]), [
    ['', 'lib/web.js', 'run_code'],
    ['f1c', '', 'run_code'],
  ])
  assert.equal(turn.entries[3].recallCalls.length, 0)

  const checkpoint = turn.entries[4]
  assert.equal(checkpoint.recalledCount, 2)
  assert.equal(checkpoint.foldedRecallCount, 0)
  assert.equal(checkpoint.foldedSearchCount, 1)
  const recalledPart = checkpoint.foldRecord.items[0]
  assert.deepEqual(recalledPart.recallCalls, [{ id: '', query: 'fold-view MB 17', parts: '', via: '' }])
})

test('轮卡片的 pin 标签带级别：近期重要标 recent，长期重要标 permanent', () => {
  const groups = buildTurnGroups({
    entries: [
      userEntry('开始'),
      entry({ isPin: true, sourceKind: 'fold-pin', pinLabel: '部署路径', pinLevel: 'permanent', sourceLabel: '重要消息（永不折叠）' }),
      entry({ isPin: true, sourceKind: 'fold-pin', pinLabel: '临时结论', pinLevel: 'recent', sourceLabel: '近期重要（可能过时）' }),
    ],
  })
  const turn = groups.find((group) => group.kind === 'turn')
  assert.deepEqual(turn.pinLabels, [
    { label: '部署路径', level: 'permanent' },
    { label: '临时结论', level: 'recent' },
  ])
})

test('折叠段的调用带块归属：标记只落在调用块上', () => {
  // 一个折叠段里常常先有思考、再有调用，页面按块切成两段，标记只能标到后面那一段。
  const nested = 'await tools.fold_recall({ id: "f2", parts: ["1"] })'
  const groups = buildTurnGroups({
    entries: [
      userEntry('第一句'),
      checkpointEntry({
        foldId: 'f1c',
        noteChars: 40,
        items: [
          {
            seq: 5,
            chars: 40,
            text: '[思考] 先看目录\n[调用 run_code] ' + JSON.stringify({ code: nested }),
            // 真实数据里 inspect 会把段文本按标记拆成块，这里给同一形态。
            blocks: [
              { kind: 'think', name: '', text: '先看目录' },
              { kind: 'call', name: 'run_code', text: JSON.stringify({ code: nested }) },
            ],
          },
        ],
      }),
    ],
  })
  const turn = groups.find((group) => group.kind === 'turn')
  const item = turn.entries[1].foldRecord.items[0]
  assert.equal(item.recallCalls.length, 1)
  // 第 0 块是思考、第 1 块是调用：页面据此只标第 2 段。
  assert.deepEqual(item.recallCallBlocks, [1])
})

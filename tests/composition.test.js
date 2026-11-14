import assert from 'node:assert/strict'
import test from 'node:test'

import { buildComposition } from '../lib/composition.js'

function group(overrides) {
  return Object.assign(
    {
      kind: 'turn',
      ordinal: 1,
      turn: 1,
      entries: [],
      version: 0,
    },
    overrides,
  )
}

function entry(spec) {
  return Object.assign({ chars: 0, blocks: [], isCheckpoint: false, isPin: false, role: 'user', sourceKind: 'user' }, spec)
}

const checkpoint = entry({
  role: 'user',
  sourceKind: 'fold-checkpoint',
  isCheckpoint: true,
  chars: 1000,
  blocks: [{ kind: 'text', text: '【已折叠历史】…' }],
  foldRecord: {
    id: 'f1',
    turn: 1,
    chars: 1000,
    items: [
      { seq: 2, chars: 500, blocks: [{ kind: 'think', text: 'x'.repeat(500) }] },
      { seq: 3, chars: 400, blocks: [{ kind: 'result', text: 'y'.repeat(400) }] },
      { seq: 4, chars: 100, blocks: [{ kind: 'inject', text: 'z'.repeat(100) }] },
    ],
  },
})

test('折叠后视角把检查点算一类，不折叠视角换回原文的思考、工具与注入', () => {
  const groups = [
    group({
      ordinal: 1,
      turn: 1,
      entries: [
        entry({ role: 'system', sourceKind: 'system', chars: 60, blocks: [{ kind: 'text', text: 's'.repeat(60) }] }),
        entry({ role: 'user', sourceKind: 'user', chars: 10, blocks: [{ kind: 'text', text: 'u'.repeat(10) }] }),
        entry({ role: 'assistant', sourceKind: 'model', chars: 150, blocks: [{ kind: 'think', text: 't'.repeat(100) }, { kind: 'reply', text: 'r'.repeat(50) }] }),
        entry({ role: 'tool', sourceKind: '', chars: 30, blocks: [{ kind: 'result', text: 'o'.repeat(30) }] }),
        checkpoint,
        entry({ role: 'user', sourceKind: 'fold-pin', isPin: true, pinLabel: '结论', chars: 20, blocks: [{ kind: 'text', text: 'p'.repeat(20) }] }),
      ],
    }),
  ]
  const result = buildComposition({ groups })
  const folded = result.totals.folded
  assert.equal(folded.system, 60)
  assert.equal(folded.user, 10)
  assert.equal(folded.assistant, 150)
  assert.equal(folded.tools, 30)
  assert.equal(folded.inject, 0)
  assert.equal(folded.checkpoint, 1000)
  assert.equal(folded.pin, 20)
  assert.equal(result.totals.sum.folded, 1270)

  const unfolded = result.totals.unfolded
  assert.equal(unfolded.checkpoint, 0)
  assert.equal(unfolded.assistant, 650)
  assert.equal(unfolded.tools, 430)
  assert.equal(unfolded.inject, 100)
  assert.equal(result.totals.sum.unfolded, 1270)
})

test('逐块累计对齐总量，且每块带轮次标签', () => {
  const groups = [
    group({ ordinal: 1, turn: 3, entries: [entry({ chars: 100, blocks: [{ kind: 'text', text: 'a'.repeat(100) }] })] }),
    group({ ordinal: 2, turn: 4, entries: [entry({ chars: 40, blocks: [{ kind: 'text', text: 'b'.repeat(40) }] })] }),
    group({ ordinal: 3, kind: 'system', turn: null, version: 2, entries: [entry({ role: 'system', sourceKind: 'system', chars: 70 })] }),
  ]
  const result = buildComposition({ groups })
  assert.equal(result.points.length, 3)
  assert.equal(result.points[0].label, 'T3')
  assert.equal(result.points[1].label, 'T4')
  assert.equal(result.points[2].label, 'S2')
  assert.equal(result.points[1].cumulative.folded.user, 140)
  assert.equal(result.points[2].cumulative.folded.system, 70)
  assert.equal(result.points[0].totals.folded, 100)
  assert.deepEqual(result.points[2].cumulative.folded, result.totals.folded)
})

test('没有分组时给出完整分类与空总量', () => {
  const result = buildComposition({ groups: [] })
  assert.equal(result.categories.length, 7)
  assert.equal(result.points.length, 0)
  assert.deepEqual(result.totals.sum, { folded: 0, unfolded: 0 })
})

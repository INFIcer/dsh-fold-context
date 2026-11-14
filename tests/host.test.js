// 装配层的集成测试：用假 ctx 走完「事件进来 → 折叠落地 → 工具可用」全流程。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assemble } from '../lib/host.js'
import { FakeSession, assistantNode, makeCtx, toolNode, userNode } from './fakes.js'

// 折叠是延时到下一拍定时器才落的，等两个 0ms 定时器就够。
const tick = () => new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0))

function emit(ctx, session, event) {
  session.seq = Math.max(session.seq, event.seq)
  ctx.emit('session/event', session, event)
}

function emitSurface(ctx, session, node) {
  session.nodes.push(node.seq)
  emit(ctx, session, { type: node.type, seq: node.seq, data: node.data })
}

function checkpointOf(session) {
  return session.events.find((event) => event.data && event.data.source && event.data.source.kind === 'fold-checkpoint')
}

function toolNamed(ctx, name) {
  return ctx.registrations.find((definition) => definition.name === name)
}

test('turn/end 后把本轮折叠成一条检查点消息，并注入提示段与三个工具', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-h')
  session.seed([userNode(1, '你好', 'user'), assistantNode(2, { text: '先聊两句' })])

  emit(ctx, session, { type: 'turn/start', seq: 3, data: { turn: 1 } })
  emit(ctx, session, { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } })
  emitSurface(ctx, session, userNode(6, '帮我实现折叠', 'user'))
  emitSurface(ctx, session, assistantNode(7, { reasoning: '思'.repeat(700), calls: [{ id: 'c1', name: 'read' }] }))
  emitSurface(ctx, session, toolNode(8, 'c1', '果'.repeat(600)))
  emit(ctx, session, { type: 'step/end', seq: 9, data: { turn: 1, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 10, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()

  const checkpoint = checkpointOf(session)
  assert.ok(checkpoint, '应当生成检查点消息')
  assert.equal(checkpoint.data.source.foldId, 'f1')
  assert.equal(checkpoint.surfaceOp.op, 'replace')
  assert.equal(checkpoint.surfaceOp.startSeq, 7)
  assert.equal(checkpoint.surfaceOp.endSeq, 8)
  assert.deepEqual(checkpoint.surfaceOp && checkpoint.sourceEventSeqs, [7, 8])
  assert.deepEqual(session.nodes, [1, 2, 6, checkpoint.seq])
  assert.ok(checkpoint.data.content[0].text.includes('fold_recall'))

  assert.ok(ctx.sections.some((section) => section.name === 'fold-compression'))
  assert.ok(toolNamed(ctx, 'fold_recall'))
  assert.ok(toolNamed(ctx, 'fold_pin'))
  assert.ok(toolNamed(ctx, 'fold_config'))

  // fold_config 的 get 与 set 都走真实接线：set 要落盘，并让提示段当场重建。
  const configTool = toolNamed(ctx, 'fold_config')
  const shown = await configTool.execute({ action: 'get' }, { agent: { session } })
  assert.equal(shown.ok, true)
  assert.ok(shown.text.includes('noteRatio'))
  assert.ok(shown.text.includes('配置文件'))
  assert.ok(shown.text.includes('fold-config.json'))
  const saved = await configTool.execute({ action: 'set', patch: { noteRatio: 0.2 } }, { agent: { session } })
  assert.equal(saved.ok, true)
  const onDisk = JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8'))
  assert.equal(onDisk.noteRatio, 0.2)
  assert.equal(api.getConfig().noteRatio, 0.2)
  // 提示段随配置重建：新比率要出现在新版文案里。
  assert.ok(ctx.sections.some((section) => section.text && section.text.includes('20%')))

  const recalled = await toolNamed(ctx, 'fold_recall').execute({ id: 'f1' }, { agent: { session } })
  assert.equal(recalled.ok, true)
  assert.ok(recalled.text.includes('[思考]'))
  assert.ok(recalled.text.includes('思'))

  const payload = readFileSync(join(homeDir, 'fold-store', 'sess-h.jsonl'), 'utf8')
  assert.ok(payload.includes('"kind":"fold"'))
  api.stop()
})

test('召回次数超阈值时给出固化提醒', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  writeFileSync(join(homeDir, 'fold-config.json'), JSON.stringify({ recallReminderAfter: 1 }), 'utf8')
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-r')
  const nodes = [userNode(1, '开始', 'user'), assistantNode(2, { text: '答'.repeat(1500) })]
  session.seed(nodes)
  emit(ctx, session, { type: 'turn/start', seq: 3, data: { turn: 1 } })
  emit(ctx, session, { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } })
  emitSurface(ctx, session, assistantNode(5, { text: '长'.repeat(1500) }))
  emit(ctx, session, { type: 'step/end', seq: 6, data: { turn: 1, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()
  const checkpoint = checkpointOf(session)
  assert.ok(checkpoint)
  const tool = toolNamed(ctx, 'fold_recall')
  const first = await tool.execute({ id: 'f1' }, { agent: { session } })
  assert.equal(first.ok, true)
  const second = await tool.execute({ id: 'f1' }, { agent: { session } })
  assert.ok(second.text.includes('fold_pin'))
  api.stop()
})

test('重要消息会被后续轮次跳过，不会被折掉', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-p')
  session.seed([userNode(1, '开始', 'user')])
  const pin = await toolNamed(ctx, 'fold_pin').execute({ label: '接口约定', text: '字段名用 snake_case' }, { agent: { session } })
  assert.equal(pin.ok, true)
  const pinSeq = session.nodes.at(-1)

  emit(ctx, session, { type: 'turn/start', seq: 4, data: { turn: 2 } })
  emit(ctx, session, { type: 'step/start', seq: 5, data: { turn: 2, step: 1 } })
  emitSurface(ctx, session, userNode(6, '继续', 'user'))
  emitSurface(ctx, session, assistantNode(7, { text: '长'.repeat(2000) }))
  emit(ctx, session, { type: 'step/end', seq: 8, data: { turn: 2, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'stop' } } })
  await tick()

  assert.ok(session.nodes.includes(pinSeq), '重要消息节点应当还在')
  assert.ok(checkpointOf(session))
  assert.ok(session.nodes.includes(6), '用户消息不该被折')
  api.stop()
})

test('配置里关掉开关就只注册工具，不折叠', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  writeFileSync(join(homeDir, 'fold-config.json'), JSON.stringify({ enabled: false }), 'utf8')
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-off')
  session.seed([userNode(1, '开始', 'user')])
  emit(ctx, session, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  emit(ctx, session, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
  emitSurface(ctx, session, assistantNode(4, { text: '长'.repeat(2000) }))
  emit(ctx, session, { type: 'step/end', seq: 5, data: { turn: 1, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()
  assert.equal(checkpointOf(session), undefined)
  assert.ok(toolNamed(ctx, 'fold_recall'))
  assert.equal(api.getConfig().enabled, false)
  api.stop()
})

test('stop 之后不再响应事件', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  api.stop()
  assert.equal(ctx.registrations.length, 0)
  assert.equal(ctx.listeners.length, 0)
})

test('turn-stopping 时立刻折叠，且随后的 turn/end 不会再折一次', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-stop')
  session.seed([userNode(1, '开始', 'user')])
  emit(ctx, session, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  emit(ctx, session, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
  emitSurface(ctx, session, assistantNode(4, { reasoning: '思'.repeat(800), calls: [{ id: 'c9', name: 'grep' }] }))
  emitSurface(ctx, session, toolNode(5, 'c9', '果'.repeat(600)))
  emit(ctx, session, { type: 'step/end', seq: 6, data: { turn: 1, step: 1 } })

  // 不 await 任何一拍：turn-stopping 应当同步把折叠写进日志。
  ctx.emit('agent/turn-stopping', { agent: { session }, turn: 1 })
  const first = checkpointOf(session)
  assert.ok(first, 'turn-stopping 时就该落盘')
  assert.deepEqual(session.nodes, [1, first.seq])

  emit(ctx, session, { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()
  const checkpoints = session.events.filter((event) => event.data && event.data.source && event.data.source.kind === 'fold-checkpoint')
  assert.equal(checkpoints.length, 1, '同一轮不该折两次')
  api.stop()
})
test('长折叠先回目录，再用 parts 多选取回，目录查询不算一次内容召回', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  writeFileSync(join(homeDir, 'fold-config.json'), JSON.stringify({ recallDirectChars: 1000 }), 'utf8')
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-r2')
  session.seed([userNode(1, '开始', 'user')])
  emit(ctx, session, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  emit(ctx, session, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
  emitSurface(ctx, session, assistantNode(4, { reasoning: '思'.repeat(700), text: '答'.repeat(400), calls: [{ id: 'c1', name: 'read' }] }))
  emitSurface(ctx, session, toolNode(5, 'c1', '果'.repeat(400)))
  emit(ctx, session, { type: 'step/end', seq: 6, data: { turn: 1, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()
  assert.ok(checkpointOf(session))

  const tool = toolNamed(ctx, 'fold_recall')
  const index = await tool.execute({ id: 'f1' }, { agent: { session } })
  assert.equal(index.ok, true)
  assert.ok(index.text.includes('先给目录'))
  assert.ok(index.text.includes('#1 [思考]'))
  assert.ok(index.text.includes('parts'))

  const parts = await tool.execute({ id: 'f1', parts: ['2', '4'] }, { agent: { session } })
  assert.equal(parts.ok, true)
  assert.ok(parts.text.includes('取回 2/4 段'))
  assert.ok(parts.text.includes('--- #2 回复 ---'))
  assert.ok(parts.text.includes('--- #4 工具结果 ---'))
  assert.equal(parts.text.includes('--- #1 思考 ---'), false)

  const lines = readFileSync(join(homeDir, 'fold-store', 'sess-r2.jsonl'), 'utf8').split('\n').filter(Boolean)
  const recalls = lines.map((line) => JSON.parse(line)).filter((row) => row.kind === 'recall')
  assert.deepEqual(recalls.map((row) => row.mode), ['index', 'parts'])
  api.stop()
})

test('fold_config 拒绝未知键，get 里能看到分级召回的字段', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-cfg')
  session.seed([userNode(1, '开始', 'user')])
  const tool = toolNamed(ctx, 'fold_config')
  const shown = await tool.execute({ action: 'get' }, { agent: { session } })
  assert.ok(shown.text.includes('recallDirectChars'))
  const bad = await tool.execute({ action: 'set', patch: { nope: 1 } }, { agent: { session } })
  assert.equal(bad.ok, false)
  api.stop()
})

test('折叠摘要带文件清单，关键词检索能把这一轮找回来', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-files')
  session.seed([userNode(1, '改一下路由', 'user')])

  emit(ctx, session, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  emit(ctx, session, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
  emitSurface(ctx, session, userNode(4, '改一下路由', 'user'))
  emitSurface(
    ctx,
    session,
    assistantNode(5, {
      reasoning: '先读一遍路由表'.repeat(200),
      text: '改好了'.repeat(60),
      calls: [
        { id: 'c1', name: 'read', args: { file_path: 'E:/dsh-fold-plugin/lib/web.js' } },
        { id: 'c2', name: 'edit', args: { file_path: 'E:/dsh-fold-plugin/lib/web.js' } },
      ],
    }),
  )
  emitSurface(ctx, session, toolNode(6, 'c1', '路由表原文'.repeat(200)))
  emitSurface(ctx, session, toolNode(7, 'c2', '已写入'.repeat(200)))
  emit(ctx, session, { type: 'step/end', seq: 8, data: { turn: 1, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()

  const checkpoint = checkpointOf(session)
  assert.ok(checkpoint, '应当生成检查点消息')
  const note = checkpoint.data.content[0].text
  assert.ok(note.includes('· 文件：改过 lib/web.js'), note)
  assert.ok(!note.includes('读过 lib/web.js'), '改过的文件不该同时算作「读过」')

  const tool = toolNamed(ctx, 'fold_recall')
  // 只记得文件名：先检索，只拿到编号与段号。
  const found = await tool.execute({ query: 'lib/web.js' }, { agent: { session } })
  assert.equal(found.ok, true)
  assert.equal(found.mode, 'search')
  assert.ok(found.text.includes('f1'), found.text)

  assert.match(found.text, /#\d+/)
  // 再按编号 + 关键词筛段取原文：只取回命中的工具结果。
  const parts = await tool.execute({ id: 'f1', query: '路由表原文' }, { agent: { session } })
  assert.equal(parts.ok, true)
  assert.equal(parts.mode, 'parts')
  assert.ok(parts.text.includes('路由表原文'), parts.text)
  assert.ok(!parts.text.includes('--- #1 思考 ---'), parts.text)

  const lines = readFileSync(join(homeDir, 'fold-store', 'sess-files.jsonl'), 'utf8').split('\n').filter(Boolean)
  const recalls = lines.map((line) => JSON.parse(line)).filter((row) => row.kind === 'recall')
  assert.deepEqual(recalls.map((row) => row.mode), ['search', 'parts'])
  assert.equal(recalls[0].id, '')
  api.stop()
})


test('官方压缩把重要消息卷进摘要后，插件会把原文补发回来', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-cp')
  session.seed([userNode(1, '开始', 'user'), assistantNode(2, { text: '答'.repeat(600) })])
  const pin = await toolNamed(ctx, 'fold_pin').execute({ label: '接口约定', text: '字段名用 snake_case' }, { agent: { session } })
  assert.equal(pin.ok, true)
  const pinSeq = session.nodes.at(-1)

  // 模拟官方压缩：把 [1..pinSeq] 整段换成一条 compact-checkpoint，pin 正在被遮蔽区间里。
  const summary = {
    id: 'cp1',
    role: 'user',
    content: [{ type: 'text', text: '（官方压缩摘要）' }],
    source: { kind: 'compact-checkpoint', compactionId: 'cp1' },
  }
  const shadowed = session.nodes.slice()
  const [checkpointEvent] = session.append('user/message', summary, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: pinSeq },
    sourceEventSeqs: shadowed,
  })
  emit(ctx, session, {
    type: 'user/message',
    seq: checkpointEvent.seq,
    data: summary,
    surfaceOp: checkpointEvent.surfaceOp,
    sourceEventSeqs: checkpointEvent.sourceEventSeqs,
  })
  await tick()

  assert.ok(session.nodes.includes(checkpointEvent.seq), '压缩检查点不该被折掉')
  const pins = session.events.filter((event) => event.data && event.data.source && event.data.source.kind === 'fold-pin')
  assert.equal(pins.length, 2, '原 pin 一条、补发一条')
  const last = pins.at(-1)
  assert.equal(last.data.source.label, '接口约定')
  assert.ok(last.data.content[0].text.includes('snake_case'))
  assert.deepEqual(session.nodes, [checkpointEvent.seq, last.seq])

  const rows = readFileSync(join(homeDir, 'fold-store', 'sess-cp.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const pinRows = rows.filter((row) => row.kind === 'pin')
  assert.equal(pinRows.length, 2)
  assert.equal(pinRows.at(-1).restored, true)
  api.stop()
})

test('官方压缩没碰到重要消息时不重复补发', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-cp2')
  session.seed([userNode(1, '开始', 'user'), assistantNode(2, { text: '答'.repeat(600) })])
  const pin = await toolNamed(ctx, 'fold_pin').execute({ label: '接口约定', text: '保留' }, { agent: { session } })
  assert.equal(pin.ok, true)

  const summary = { id: 'cp2', role: 'user', content: [{ type: 'text', text: '（官方摘要）' }], source: { kind: 'compact-checkpoint' } }
  const [checkpointEvent] = session.append('user/message', summary, {
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
    sourceEventSeqs: [2],
  })
  emit(ctx, session, { type: 'user/message', seq: checkpointEvent.seq, data: summary, surfaceOp: checkpointEvent.surfaceOp, sourceEventSeqs: checkpointEvent.sourceEventSeqs })
  await tick()

  const pins = session.events.filter((event) => event.data && event.data.source && event.data.source.kind === 'fold-pin')
  assert.equal(pins.length, 1)
  api.stop()
})

test('补发撞上 append 临界区会退避重试，不把重要消息丢掉', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-cp3')
  session.seed([userNode(1, '开始', 'user'), assistantNode(2, { text: '答'.repeat(600) })])
  const pin = await toolNamed(ctx, 'fold_pin').execute({ label: '约定', text: '别丢' }, { agent: { session } })
  assert.equal(pin.ok, true)
  const pinSeq = session.nodes.at(-1)

  // 第一次补发模拟「发布临界区里不能 append」。
  const original = session.append.bind(session)
  let blocked = false
  session.append = (type, data, opts) => {
    if (!blocked && opts && opts.surfaceOp === 'append' && data && data.source && data.source.kind === 'fold-pin') {
      blocked = true
      throw new Error('session append cannot reenter while another append is being published')
    }
    return original(type, data, opts)
  }

  const summary = { id: 'cp3', role: 'user', content: [{ type: 'text', text: '（官方摘要）' }], source: { kind: 'compact-checkpoint' } }
  const shadowed = session.nodes.slice()
  const [checkpointEvent] = session.append('user/message', summary, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: pinSeq },
    sourceEventSeqs: shadowed,
  })
  emit(ctx, session, { type: 'user/message', seq: checkpointEvent.seq, data: summary, surfaceOp: checkpointEvent.surfaceOp, sourceEventSeqs: checkpointEvent.sourceEventSeqs })

  await new Promise((resolve) => setTimeout(resolve, 600))
  const pins = session.events.filter((event) => event.data && event.data.source && event.data.source.kind === 'fold-pin')
  assert.equal(pins.length, 2, '重试后应当补发成功')
  assert.equal(session.nodes.at(-1), pins.at(-1).seq)
  api.stop()
})

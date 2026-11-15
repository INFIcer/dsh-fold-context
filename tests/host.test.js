// 装配层的集成测试：用假 ctx 走完「事件进来 → 折叠落地 → 工具可用」全流程。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assemble } from '../lib/host.js'
import { FoldStore } from '../lib/store.js'
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

// 提示段文案按会话现算：没传会话时取允许折叠的那一份。
function sectionTextOf(ctx, session) {
  const section = ctx.sections.find((entry) => entry.name === 'fold-compression')
  if (!section) return ''
  return typeof section.text === 'function'
    ? section.text({ agent: { session } })
    : String(section.text || '')
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
  assert.ok(shown.text.includes('maxNoteTokens'))
  assert.ok(shown.text.includes('配置文件'))
  assert.ok(shown.text.includes('fold-config.json'))
  const saved = await configTool.execute({ action: 'set', patch: { maxNoteTokens: 400 } }, { agent: { session } })
  assert.equal(saved.ok, true)
  const onDisk = JSON.parse(readFileSync(join(homeDir, 'fold-config.json'), 'utf8'))
  assert.equal(onDisk.maxNoteTokens, 400)
  assert.equal(api.getConfig().maxNoteTokens, 400)
  // 提示段随配置重建：新上限要出现在新版文案里。
  assert.ok(sectionTextOf(ctx, session).includes('maxNoteTokens'))

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
  emitSurface(ctx, session, assistantNode(5, { text: '长'.repeat(4000) }))
  emit(ctx, session, { type: 'step/end', seq: 6, data: { turn: 1, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()
  const checkpoint = checkpointOf(session)
  assert.ok(checkpoint)
  const tool = toolNamed(ctx, 'fold_recall')
  // 第一次内容召回次数刚到 1，不提醒；第二次超过阈值，提醒固化。
  const first = await tool.execute({ id: 'f1', parts: ['1'] }, { agent: { session } })
  assert.equal(first.ok, true)
  assert.equal(first.text.includes('fold_pin'), false)
  const second = await tool.execute({ id: 'f1', parts: ['1'] }, { agent: { session } })
  assert.ok(second.text.includes('fold_pin'))
  api.stop()
})

test('轮内发布的重要消息推迟到折叠之后注入，整轮照常折叠', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-p')
  session.seed([userNode(1, '开始', 'user')])

  emit(ctx, session, { type: 'turn/start', seq: 4, data: { turn: 2 } })
  emit(ctx, session, { type: 'step/start', seq: 5, data: { turn: 2, step: 1 } })
  emitSurface(ctx, session, userNode(6, '继续', 'user'))
  // 模型在轮内调用 fold_pin（assistant 调用 → 工具结果 → 最终回复）
  const pinTool = toolNamed(ctx, 'fold_pin')
  emitSurface(ctx, session, assistantNode(7, { reasoning: '想'.repeat(2000), calls: [{ id: 'c1', name: 'fold_pin' }] }))
  const pin = await pinTool.execute({ label: '接口约定', text: '字段名用 snake_case' }, { agent: { session } })
  assert.equal(pin.ok, true)
  emitSurface(ctx, session, toolNode(8, 'c1', '已发布重要消息「接口约定」'))
  emitSurface(ctx, session, assistantNode(9, { text: '收尾'.repeat(600) }))
  emit(ctx, session, { type: 'step/end', seq: 10, data: { turn: 2, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 11, data: { turn: 2, reason: { kind: 'stop' } } })
  await tick()

  const checkpoint = checkpointOf(session)
  assert.ok(checkpoint, '应当生成检查点')
  // 调用、结果、收尾回复在同一条连续区间里，整轮一起折
  assert.equal(checkpoint.surfaceOp.startSeq, 7)
  assert.equal(checkpoint.surfaceOp.endSeq, 9)
  // pin 消息在折叠之后注入：seq 比检查点大，且不在被替换区间里
  const pinEvent = session.events.find((event) => event.data && event.data.source && event.data.source.kind === 'fold-pin')
  assert.ok(pinEvent, 'pin 消息应当注入')
  assert.ok(pinEvent.seq > checkpoint.seq, 'pin 应在检查点之后')
  assert.equal(pinEvent.surfaceOp?.op ?? 'append', 'append')
  assert.ok(session.nodes.includes(6), '用户消息不该被折')
  api.stop()
})

test('轮内发布的消息在插件重启后补投，注入成功后删掉待投递记录', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-restore')
  session.seed([userNode(1, '开始', 'user')])
  emit(ctx, session, { type: 'turn/start', seq: 4, data: { turn: 2 } })
  emit(ctx, session, { type: 'step/start', seq: 5, data: { turn: 2, step: 1 } })

  const pin = await toolNamed(ctx, 'fold_pin').execute({ label: '接口约定', text: '字段名用 snake_case' }, { agent: { session } })
  assert.equal(pin.ok, true)
  assert.ok(pin.text.includes('待投递记录'), pin.text)
  // 消息还没注入，但「答应过要发」的记录已经落盘。
  assert.equal(new FoldStore({ homeDir, sessionId: 'sess-restore' }).pendingPins().length, 1)

  // 模拟进程退出：内存队列跟着运行时一起消失，只剩那条待投递记录。
  api.stop()

  const ctx2 = makeCtx()
  const api2 = assemble(ctx2, { homeDir, logFile: null })
  const resumed = new FakeSession('sess-restore')
  resumed.seed([userNode(1, '开始', 'user')])
  emit(ctx2, resumed, { type: 'turn/start', seq: 4, data: { turn: 2 } })
  // 补投要等这一轮结束：轮内直接插进去会打断工具调用与结果的分段。
  emit(ctx2, resumed, { type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'stop' } } })
  await tick()

  const pinEvent = resumed.events.find((event) => event.data && event.data.source && event.data.source.kind === 'fold-pin')
  assert.ok(pinEvent, '重启后应当补投未注入的重要消息')
  assert.ok(pinEvent.data.content[0].text.includes('字段名用 snake_case'))
  assert.equal(new FoldStore({ homeDir, sessionId: 'sess-restore' }).pendingPins().length, 0, '注入成功后待投递记录要删掉')
  api2.stop()
})

test('配置里关掉总开关：不折叠、不注入提示段、也不注册工具', async () => {
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
  // 模型侧完全静默：既没有折叠说明，也没有三个工具，账单才等于「没有这个插件」。
  assert.equal(ctx.sections.length, 0)
  assert.equal(ctx.registrations.length, 0)
  assert.equal(api.getConfig().enabled, false)
  api.stop()
})

test('总开关翻转时提示段与工具跟着上下，不用重启', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-toggle')
  assert.ok(toolNamed(ctx, 'fold_config'))
  assert.ok(ctx.sections.some((section) => section.name === 'fold-compression'))

  // fold_config 关掉的是它自己：注册项必须挪到下一拍再摘，否则会在自己的调用里被 dispose。
  const off = await toolNamed(ctx, 'fold_config').execute({ action: 'set', patch: { enabled: false } }, { agent: { session } })
  assert.equal(off.ok, true)
  await tick()
  assert.equal(toolNamed(ctx, 'fold_recall'), undefined)
  assert.equal(toolNamed(ctx, 'fold_pin'), undefined)
  assert.equal(toolNamed(ctx, 'fold_config'), undefined)
  assert.equal(ctx.sections.some((section) => section.name === 'fold-compression'), false)

  // 关掉之后设置页仍能把它打开：下一轮重新挂上提示段与工具。
  writeFileSync(join(homeDir, 'fold-config.json'), JSON.stringify({ enabled: true }), 'utf8')
  emit(ctx, session, { type: 'turn/start', seq: 2, data: { turn: 2 } })
  emit(ctx, session, { type: 'step/start', seq: 3, data: { turn: 2, step: 1 } })
  emit(ctx, session, { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'stop' } } })
  await tick()
  assert.ok(toolNamed(ctx, 'fold_recall'))
  assert.ok(toolNamed(ctx, 'fold_config'))
  assert.ok(ctx.sections.some((section) => section.name === 'fold-compression'))
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
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-r2')
  session.seed([userNode(1, '开始', 'user')])
  emit(ctx, session, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  emit(ctx, session, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
  emitSurface(ctx, session, assistantNode(4, { reasoning: '思'.repeat(1000), text: '答'.repeat(1600), calls: [{ id: 'c1', name: 'read' }] }))
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
  assert.ok(shown.text.includes('recallIndexPreviewTokens'))
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
        { id: 'c1', name: 'read', args: { file_path: 'E:/dsh-fold-context/lib/web.js' } },
        { id: 'c2', name: 'edit', args: { file_path: 'E:/dsh-fold-context/lib/web.js' } },
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

test('官方压缩吞掉重要消息时不补发：淡化交给压缩层', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const session = new FakeSession('sess-cp')
  session.seed([userNode(1, '开始', 'user'), assistantNode(2, { text: '答'.repeat(600) })])
  emit(ctx, session, { type: 'turn/start', seq: 3, data: { turn: 1 } })
  emit(ctx, session, { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } })
  const pin = await toolNamed(ctx, 'fold_pin').execute({ label: '接口约定', text: '字段名用 snake_case' }, { agent: { session } })
  assert.equal(pin.ok, true)
  // 轮内发布的消息在 turn 结束时才注入
  emit(ctx, session, { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()
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

  const pins = session.events.filter((event) => event.data && event.data.source && event.data.source.kind === 'fold-pin')
  assert.equal(pins.length, 1, '被官方摘要卷走后不再补发')
  assert.deepEqual(session.nodes, [checkpointEvent.seq], '官方检查点仍然是 keeper')

  const rows = readFileSync(join(homeDir, 'fold-store', 'sess-cp.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const pinRows = rows.filter((row) => row.kind === 'pin')
  assert.equal(pinRows.length, 1, 'fold-store 不写补发记录')
  api.stop()
})

test('子代理里 fold_pin 可用，但只写进子会话自己的会话与账本', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const parent = new FakeSession('sess-parent-pin')
  const child = new FakeSession('sess-sub-pin', { origin: 'subagent', parentSession: 'sess-parent-pin' })
  child.seed([userNode(1, '开始', 'user')])
  // 父会话先被观察到：子代理解析父会话时走运行时缓存。
  emit(ctx, parent, { type: 'turn/start', seq: 1, data: { turn: 1 } })

  emit(ctx, child, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  const pin = await toolNamed(ctx, 'fold_pin').execute({ label: '自己的备忘', text: '只在子会话可见' }, { agent: { session: child } })
  assert.equal(pin.ok, true, pin.text)
  assert.ok(pin.text.includes('父代理看不到'), pin.text)
  emit(ctx, child, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()

  assert.equal(sessionPinEvents(child), 1, 'pin 照常注入子代理自己的会话')
  assert.equal(sessionPinEvents(parent), 0, '父会话不该收到子代理的 pin')
  assert.equal(checkpointOf(child), undefined, '子代理默认不折叠')
  assert.equal(new FoldStore({ homeDir, sessionId: 'sess-sub-pin' }).pins().length, 1, '记录写进子会话自己的账本')
  assert.equal(new FoldStore({ homeDir, sessionId: 'sess-parent-pin' }).pins().length, 0, '父会话账本不该多一条')
  api.stop()
})

test('默认只在主会话折叠：子代理会话的轮次保持原文', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const child = new FakeSession('sess-sub-nofold', { origin: 'subagent', parentSession: 'sess-parent-nofold' })
  child.seed([userNode(1, '开始', 'user')])
  emit(ctx, child, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  emit(ctx, child, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
  emitSurface(ctx, child, assistantNode(4, { reasoning: '想'.repeat(3000) }))
  emit(ctx, child, { type: 'step/end', seq: 5, data: { turn: 1, step: 1 } })
  emit(ctx, child, { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()

  assert.equal(checkpointOf(child), undefined)
  assert.deepEqual(child.nodes, [1, 4], '原文留在 surface 上')
  let payload = ''
  try {
    payload = readFileSync(join(homeDir, 'fold-store', 'sess-sub-nofold.jsonl'), 'utf8')
  } catch {
    payload = ''
  }
  assert.equal(payload.includes('"kind":"fold"'), false, '不该写折叠记录')
  api.stop()
})

test('foldSubagents 打开后子代理会话也折叠', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  writeFileSync(join(homeDir, 'fold-config.json'), JSON.stringify({ foldSubagents: true }), 'utf8')
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const child = new FakeSession('sess-sub-fold', { origin: 'subagent', parentSession: 'sess-parent-fold' })
  child.seed([userNode(1, '开始', 'user')])
  emit(ctx, child, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  emit(ctx, child, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
  emitSurface(ctx, child, assistantNode(4, { reasoning: '想'.repeat(3000) }))
  emit(ctx, child, { type: 'step/end', seq: 5, data: { turn: 1, step: 1 } })
  emit(ctx, child, { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()

  assert.equal(api.getConfig().foldSubagents, true)
  assert.ok(checkpointOf(child), '打开后子代理也应当折叠')
  api.stop()
})

test('提示段按会话给：主会话说明折叠，子代理说明 pin 边界，fork 补一句父会话检查点', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const main = new FakeSession('sess-main-prompt')
  const spawn = new FakeSession('sess-spawn-prompt', { origin: 'subagent', parentSession: 'sess-main-prompt' })
  const fork = new FakeSession('sess-fork-prompt', { origin: 'subagent', parentSession: 'sess-main-prompt', isSeeded: true })

  const master = sectionTextOf(ctx, main)
  assert.ok(master.includes('这个会话启用了按轮折叠'), master)

  const spawned = sectionTextOf(ctx, spawn)
  assert.ok(spawned.includes('没有启用按轮折叠'), spawned)
  assert.ok(spawned.includes('只有你自己看得见'), spawned)
  assert.equal(spawned.includes('来自父会话'), false, '普通子代理没有父会话的检查点')

  const inherited = sectionTextOf(ctx, fork)
  assert.ok(inherited.includes('来自父会话'), inherited)
  assert.ok(inherited.includes('fold_recall'), inherited)
  api.stop()
})

test('工具跟着折叠范围走：主会话三个都可见，普通子代理只剩 fold_pin，fork 子会话还能召回', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const main = new FakeSession('sess-main-tools')
  const spawn = new FakeSession('sess-spawn-tools', { origin: 'subagent', parentSession: 'sess-main-tools' })
  const fork = new FakeSession('sess-fork-tools', { origin: 'subagent', parentSession: 'sess-main-tools', isSeeded: true })
  const visible = (session) => ctx.registrations
    .filter((tool) => typeof tool.when !== 'function' || tool.when({ agent: { session } }))
    .map((tool) => tool.name)
    .sort()

  assert.deepEqual(visible(main), ['fold_config', 'fold_pin', 'fold_recall'])
  assert.deepEqual(visible(spawn), ['fold_pin'])
  assert.deepEqual(visible(fork), ['fold_pin', 'fold_recall'])
  api.stop()
})

test('子代理里 fold_config 只读：get 照常，set 与 reset 拒绝且不落盘', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const child = new FakeSession('sess-sub-cfg', { origin: 'subagent' })
  const tool = toolNamed(ctx, 'fold_config')

  const shown = await tool.execute({ action: 'get' }, { agent: { session: child } })
  assert.equal(shown.ok, true)
  assert.ok(shown.text.includes('maxNoteTokens'))

  const before = api.getConfig().maxNoteTokens
  const set = await tool.execute({ action: 'set', patch: { maxNoteTokens: 400 } }, { agent: { session: child } })
  assert.equal(set.ok, false)
  assert.ok(set.text.includes('全局配置'), set.text)
  assert.equal(api.getConfig().maxNoteTokens, before, '子代理不能改进程级配置')

  const reset = await tool.execute({ action: 'reset' }, { agent: { session: child } })
  assert.equal(reset.ok, false)

  let written = true
  try {
    readFileSync(join(homeDir, 'fold-config.json'))
  } catch {
    written = false
  }
  assert.equal(written, false, '被拒绝的写不该碰配置文件')
  api.stop()
})

test('fork 子会话能召回父会话的折叠载荷，父会话不再可达时说明原因', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'fold-host-'))
  const ctx = makeCtx()
  const api = assemble(ctx, { homeDir, logFile: null })
  const parent = new FakeSession('sess-fork-parent')
  parent.seed([userNode(1, '开始', 'user')])
  emit(ctx, parent, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  emit(ctx, parent, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
  emitSurface(ctx, parent, assistantNode(4, { reasoning: '父会话的思考'.repeat(300) }))
  emit(ctx, parent, { type: 'step/end', seq: 5, data: { turn: 1, step: 1 } })
  emit(ctx, parent, { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'stop' } } })
  await tick()
  assert.ok(checkpointOf(parent))

  // fork 会话的 seed 带着父会话的检查点，载荷却只存在父会话的文件里。
  const child = new FakeSession('sess-fork-child', { origin: 'subagent', parentSession: 'sess-fork-parent' })
  const tool = toolNamed(ctx, 'fold_recall')
  const hit = await tool.execute({ id: 'f1' }, { agent: { session: child } })
  assert.equal(hit.ok, true, hit.text)
  assert.ok(hit.text.includes('父会话的思考'))

  // 父会话查不到（不在运行时缓存、也没有 sessions 服务）：要说「暂时读不到」，不能说「从来没有过」。
  const orphan = new FakeSession('sess-fork-orphan', { origin: 'subagent', parentSession: 'sess-gone' })
  const miss = await tool.execute({ id: 'f1' }, { agent: { session: orphan } })
  assert.equal(miss.ok, false)
  assert.ok(miss.text.includes('读不到'), miss.text)
  assert.equal(miss.text.includes('没有编号'), false)
  api.stop()
})

function sessionPinEvents(session) {
  return session.events.filter((event) => event.data && event.data.source && event.data.source.kind === 'fold-pin').length
}


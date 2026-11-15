import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compositionPath,
  configPath,
  createCompositionHandler,
  createConfigHandler,
  createStatsHandler,
  createTurnHandler,
  createViewHandler,
  registerStatsRoute,
  statsPath,
  turnPath,
  viewPath,
} from '../lib/web.js'

function fakeRes() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers || null
    },
    end(body) {
      state.body = body || ''
    },
  }
}

function fakeReq(url, method) {
  return { url, method: method || 'GET', headers: {} }
}

function makeStore(records) {
  return { readAll: () => records }
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

test('stats 路由返回该会话的账本 JSON', () => {
  const records = [
    { kind: 'fold', id: 'f1', turn: 1, at: 1, chars: 400, note: 'b'.repeat(40), items: [{ seq: 1, text: 'a'.repeat(400) }] },
    { kind: 'pin', id: 'P', turn: 1, at: 2, text: 'cccc' },
  ]
  const handler = createStatsHandler({
    makeStore: (id) => (id === 's1' ? makeStore(records) : makeStore([])),
    getConfig: () => ({ maxRecallTokens: 900 }),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq('/fold-stats?session=s1'), res)
  assert.equal(res.state.status, 200)
  assert.match(res.state.headers['content-type'], /application\/json/)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 's1')
  assert.equal(body.totals.folds, 1)
  assert.equal(body.totals.pins, 1)
  assert.equal(body.config.maxRecallTokens, 900)
})

test('缺 session 参数时 400 且说明用法', () => {
  const handler = createStatsHandler({ makeStore: () => makeStore([]), getConfig: () => ({}), log: quietLog })
  const res = fakeRes()
  handler(fakeReq(statsPath), res)
  assert.equal(res.state.status, 400)
  assert.match(JSON.parse(res.state.body).error, /session/)
})

test('非 GET/HEAD 方法 405', () => {
  const handler = createStatsHandler({ makeStore: () => makeStore([]), getConfig: () => ({}), log: quietLog })
  const res = fakeRes()
  handler(fakeReq('/fold-stats?session=s1', 'POST'), res)
  assert.equal(res.state.status, 405)
})

test('读载荷抛错时仍然回 200 的空账本', () => {
  const handler = createStatsHandler({
    makeStore: () => ({ readAll: () => { throw new Error('disk gone') } }),
    getConfig: () => ({}),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq('/fold-stats?session=s1'), res)
  assert.equal(res.state.status, 200)
  assert.equal(JSON.parse(res.state.body).totals.folds, 0)
})

test('stats 路由接受纯 uuid：自动换成 session- 前缀读账本', () => {
  const records = [
    { kind: 'fold', id: 'f1', turn: 1, at: 1, chars: 400, note: 'b'.repeat(40), items: [{ seq: 1, text: 'a'.repeat(400) }] },
  ]
  const handler = createStatsHandler({
    makeStore: (id) => (id === 'session-u1' ? makeStore(records) : makeStore([])),
    getConfig: () => ({}),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq('/fold-stats?session=u1'), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.sessionId, 'session-u1')
  assert.equal(body.totals.folds, 1)
})

test('stats 路由对不存在的会话回 404，而不是 200 全零', () => {
  const handler = createStatsHandler({ makeStore: () => makeStore([]), getConfig: () => ({}), log: quietLog })
  const res = fakeRes()
  handler(fakeReq('/fold-stats?session=does-not-exist'), res)
  assert.equal(res.state.status, 404)
  assert.match(JSON.parse(res.state.body).error, /session-/)
})

test('registerStatsRoute 挂六条 exact 路由并随 dispose 撤销', () => {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => { route.disposed = true }
      },
    },
  }
  const handle = registerStatsRoute({ ctx, log: quietLog, makeStore: () => makeStore([]), getConfig: () => ({}) })
  assert.equal(routes.length, 5)
  assert.deepEqual(routes.map((route) => route.path), [statsPath, viewPath, turnPath, compositionPath, configPath])
  for (const route of routes) assert.equal(route.kind, 'exact')
  handle.dispose()
  for (const route of routes) assert.equal(route.disposed, true)
})

test('没有 webServer 时静默降级', () => {
  const handle = registerStatsRoute({ ctx: {}, log: quietLog, makeStore: () => makeStore([]), getConfig: () => ({}) })
  assert.equal(typeof handle.dispose, 'function')
  handle.dispose()
})

function fakeSession(id, messages) {
  return { id, deriveMessages: () => messages }
}

function fakeBodyReq(url, method, body) {
  const listeners = {}
  const req = {
    url,
    method: method || 'POST',
    headers: {},
    on(event, handler) {
      listeners[event] = handler
      return req
    },
  }
  queueMicrotask(() => {
    if (listeners.data && body !== undefined) listeners.data(Buffer.from(body))
    if (listeners.end) listeners.end()
  })
  return req
}

const demoMessages = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: '把仓库放到 E 盘' }], source: { kind: 'user' } },
  { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: '先看目录' }, { type: 'text', text: '好的，开始搬。' }], source: { kind: 'model', provider: 'p', model: 'm' } },
]

test('view 路由返回逐轮 JSON：轮内正文按需拉，首包只有分组头与重要消息', () => {
  const records = [
    { kind: 'fold', id: 'f1', turn: 1, at: 1, chars: 900, note: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回', items: [{ seq: 1, text: '[思考] ' + 'x'.repeat(400) }] },
  ]
  const handler = createViewHandler({
    resolveSessionById: (id) => (id === 's1' ? fakeSession('s1', demoMessages) : undefined),
    makeStore: () => makeStore(records),
    getConfig: () => ({ minFoldRatio: 0.4 }),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(viewPath + '?session=s1'), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.version, 5)
  assert.equal(body.sessionId, 's1')
  assert.ok(Array.isArray(body.groups) && body.groups.length > 0)
  assert.equal(body.config.minFoldRatio, 0.4)
  for (const group of body.groups) {
    assert.ok(Array.isArray(group.pins))
    if (group.kind === 'system') assert.ok(group.entries.length > 0, '系统提示词正文要随首屏给')
    else assert.equal(group.entries.length, 0, '轮内正文不该进首包')
  }
  // 分组头里的用户与回复只用于 150 字预览；逐块正文与折叠原文留给 /fold-turn。
  const text = JSON.stringify(body.groups)
  assert.ok(text.includes('把仓库放到 E 盘'))
  assert.equal(text.includes('先看目录'), false)
  // 构成图归 /fold-composition，首包不再白算一遍。
  assert.equal('composition' in body, false)
})

test('view 路由带上重要消息，以及系统提示词的版本与差异', () => {
  const messages = [
    { id: 's1', role: 'system', content: [{ type: 'text', text: 'a\nb\nc' }], source: { kind: 'system' } },
    ...demoMessages,
    { id: 's2', role: 'system', content: [{ type: 'text', text: 'a\nB\nc' }], source: { kind: 'system' } },
    { id: 'p1', role: 'user', content: [{ type: 'text', text: '【重要·永不折叠】 结论' }], source: { kind: 'fold-pin', label: '结论' } },
  ]
  const handler = createViewHandler({
    resolveSessionById: () => fakeSession('s3', messages),
    makeStore: () => makeStore([]),
    getConfig: () => ({}),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(viewPath + '?session=s3'), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  const systems = body.groups.filter((group) => group.kind === 'system')
  assert.equal(systems.length, 2)
  assert.equal(systems[0].version, 1)
  assert.equal(systems[0].diff, null)
  assert.equal(systems[1].version, 2)
  assert.equal(systems[1].diff.add, 1)
  assert.equal(systems[1].diff.del, 1)
  assert.deepEqual(body.pins.map((pin) => pin.label), ['结论'])
  assert.ok(body.pins[0].blocks.length > 0)
  // 重要消息要常显在轮卡片之外，所以正文随首包走；普通条目则等展开时才拉。
  const pinGroup = body.groups.find((group) => group.pins.length > 0)
  assert.ok(pinGroup, '重要消息应挂在一个分组上')
  assert.deepEqual(pinGroup.pins.map((pin) => pin.pinLabel), ['结论'])
  assert.ok(pinGroup.pins[0].blocks.length > 0)
  assert.equal(body.version, 5)
})

test('view 不再回上下文构成：构成图归 /fold-composition', () => {
  const messages = [
    { id: 's1', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system' } },
    ...demoMessages,
    { id: 'p1', role: 'user', content: [{ type: 'text', text: '【重要·永不折叠】 结论' }], source: { kind: 'fold-pin', label: '结论' } },
  ]
  const handler = createViewHandler({
    resolveSessionById: () => fakeSession('s4', messages),
    makeStore: () => makeStore([]),
    getConfig: () => ({}),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(viewPath + '?session=s4'), res)
  const body = JSON.parse(res.state.body)
  assert.equal(body.composition, undefined)
  assert.ok(body.groups.length > 0)
})

test('composition 路由只回构成数据，格式与 view 的 composition 一致', () => {
  const messages = [
    { id: 's1', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system' } },
    ...demoMessages,
  ]
  const handler = createCompositionHandler({
    resolveSessionById: (id) => (id === 's1' ? fakeSession('s1', messages) : undefined),
    makeStore: () => makeStore([]),
    getConfig: () => ({ maxRecallTokens: 900 }),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(compositionPath + '?session=s1'), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 's1')
  assert.ok(Array.isArray(body.composition.categories) && body.composition.categories.length > 0)
  assert.ok(Array.isArray(body.composition.points) && body.composition.points.length > 0)
  assert.ok(body.composition.totals.sum.folded > 0)
  // 成本估算跟构成同一份分组算出来，只回汇总与逐轮数。
  assert.equal(body.cost.ok, true)
  assert.equal(body.cost.totals.turns, body.composition.points.filter((point) => point.kind === 'turn').length)
  assert.equal(typeof body.cost.totals.foldedTokens, 'number')
  assert.equal(typeof body.cost.totals.netSavedTokens, 'number')
  assert.equal(body.cost.latest, null)
  // 账本只要图数据：整轮明细留在 /fold-view，别让 20 秒一轮的轮询背上大包。
  assert.equal('groups' in body, false)
})

test('composition 路由缺参数 400、找不到会话 404、空历史给空构成', () => {
  const handler = createCompositionHandler({
    resolveSessionById: (id) => (id === 's2' ? fakeSession('s2', []) : undefined),
    makeStore: () => makeStore([]),
    getConfig: () => ({}),
    log: quietLog,
  })
  const missing = fakeRes()
  handler(fakeReq(compositionPath), missing)
  assert.equal(missing.state.status, 400)
  assert.match(JSON.parse(missing.state.body).error, /session/)

  const gone = fakeRes()
  handler(fakeReq(compositionPath + '?session=gone'), gone)
  assert.equal(gone.state.status, 404)

  const empty = fakeRes()
  handler(fakeReq(compositionPath + '?session=s2'), empty)
  assert.equal(empty.state.status, 200)
  assert.deepEqual(JSON.parse(empty.state.body).composition.points, [])
  assert.equal(JSON.parse(empty.state.body).cost.totals.turns, 0)
})

test('composition 路由接受纯 uuid：解析时自动补 session- 前缀', () => {
  const messages = [
    { id: 's1', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system' } },
    ...demoMessages,
  ]
  const handler = createCompositionHandler({
    resolveSessionById: (id) => (id === 'session-u9' ? fakeSession('session-u9', messages) : undefined),
    makeStore: () => makeStore([]),
    getConfig: () => ({}),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(compositionPath + '?session=u9'), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.sessionId, 'session-u9')
  assert.ok(body.composition.totals.sum.folded > 0)
})

test('view 路由缺参数 400、找不到会话 404', () => {
  const handler = createViewHandler({ resolveSessionById: () => undefined, makeStore: () => makeStore([]), getConfig: () => ({}), log: quietLog })
  const missing = fakeRes()
  handler(fakeReq(viewPath), missing)
  assert.equal(missing.state.status, 400)
  const gone = fakeRes()
  handler(fakeReq(viewPath + '?session=gone'), gone)
  assert.equal(gone.state.status, 404)
})

test('turn 路由按序号返回这一轮的条目正文，重要消息不重复下发', () => {
  const records = [
    { kind: 'fold', id: 'f1', turn: 1, at: 1, chars: 900, note: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回', items: [{ seq: 1, text: '[思考] ' + 'x'.repeat(400) }] },
  ]
  const messages = [
    ...demoMessages,
    { id: 'p1', role: 'user', content: [{ type: 'text', text: '【重要·永不折叠】 结论' }], source: { kind: 'fold-pin', label: '结论' } },
  ]
  const session = fakeSession('s1', messages)
  const view = createViewHandler({ resolveSessionById: () => session, makeStore: () => makeStore(records), getConfig: () => ({}), log: quietLog })
  const viewRes = fakeRes()
  view(fakeReq(viewPath + '?session=s1'), viewRes)
  const groups = JSON.parse(viewRes.state.body).groups
  const turnGroup = groups.find((group) => group.kind === 'turn')
  assert.ok(turnGroup, '应有一个轮分组')
  const ordinal = turnGroup.ordinal
  assert.ok(ordinal > 0)
  // 首包里这一轮没有条目，正文只在 /fold-turn
  assert.equal(turnGroup.entries.length, 0)
  assert.equal(turnGroup.pins.length, 1)

  const handler = createTurnHandler({ resolveSessionById: () => session, makeStore: () => makeStore(records), getConfig: () => ({}), log: quietLog })
  const res = fakeRes()
  handler(fakeReq(turnPath + '?session=s1&ordinal=' + ordinal), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.ordinal, ordinal)
  assert.ok(Array.isArray(body.entries) && body.entries.length > 0)
  assert.ok(JSON.stringify(body.entries).includes('先看目录'))
  for (const entry of body.entries) {
    assert.ok(Array.isArray(entry.blocks))
    assert.equal(entry.isPin, false, '重要消息已在首包里，别重复下发')
  }
})

test('turn 路由把折叠原文载荷一起给到，展开检查点才能对照原文', () => {
  const fold = {
    kind: 'fold',
    id: 'f1',
    turn: 1,
    at: 1,
    chars: 400,
    note: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回',
    // 载荷里的条目是「一行行文本」，展开时再按 [思考] / [工具结果] 这类前缀切成块。
    items: [{ seq: 2, text: '[思考] 原始思考 ' + 'x'.repeat(380) }],
  }
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '把仓库放到 E 盘' }], source: { kind: 'user' } },
    { id: 'c1', role: 'user', content: [{ type: 'text', text: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回' }], source: { kind: 'checkpoint', foldId: 'f1' } },
  ]
  const store = {
    readAll: () => [fold],
    folds: () => new Map([['f1', fold]]),
    pins: () => [],
  }
  const session = fakeSession('s1', messages)
  const view = createViewHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const viewRes = fakeRes()
  view(fakeReq(viewPath + '?session=s1'), viewRes)
  const turnGroup = JSON.parse(viewRes.state.body).groups.find((group) => group.kind === 'turn')
  const handler = createTurnHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const res = fakeRes()
  handler(fakeReq(turnPath + '?session=s1&ordinal=' + turnGroup.ordinal), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  const checkpoint = body.entries.find((entry) => entry.isCheckpoint)
  assert.ok(checkpoint, '检查点条目应在轮正文里')
  assert.equal(checkpoint.foldRecord.id, 'f1')
  assert.ok(checkpoint.foldRecord.items.length > 0)
  assert.ok(JSON.stringify(checkpoint.foldRecord).includes('原始思考'))
})

test('turn 路由缺参数 400、找不到会话 404、序号越界 404', () => {
  const handler = createTurnHandler({
    resolveSessionById: (id) => (id === 's1' ? fakeSession('s1', demoMessages) : undefined),
    makeStore: () => makeStore([]),
    getConfig: () => ({}),
    log: quietLog,
  })
  const missingSession = fakeRes()
  handler(fakeReq(turnPath), missingSession)
  assert.equal(missingSession.state.status, 400)
  assert.match(JSON.parse(missingSession.state.body).error, /session/)

  const missingOrdinal = fakeRes()
  handler(fakeReq(turnPath + '?session=s1'), missingOrdinal)
  assert.equal(missingOrdinal.state.status, 400)
  assert.match(JSON.parse(missingOrdinal.state.body).error, /ordinal/)

  const gone = fakeRes()
  handler(fakeReq(turnPath + '?session=gone&ordinal=0'), gone)
  assert.equal(gone.state.status, 404)

  const outOfRange = fakeRes()
  handler(fakeReq(turnPath + '?session=s1&ordinal=99'), outOfRange)
  assert.equal(outOfRange.state.status, 404)
  assert.match(JSON.parse(outOfRange.state.body).error, /刷新/)
})

test('view 路由带上 provider 最近一次回报，供「实际请求」对照', () => {
  const messages = [
    { id: 's1', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system' } },
    ...demoMessages,
  ]
  const handler = createViewHandler({
    resolveSessionById: (id) => (id === 's1' ? fakeSession('s1', messages) : undefined),
    makeStore: () => makeStore([]),
    getConfig: () => ({}),
    getActualUsage: () => ({ input: 100, cacheRead: 900, cacheWrite: 0, output: 40, turn: 3, step: 2 }),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(viewPath + '?session=s1'), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.actual.promptTokens, 1000)
  assert.equal(body.actual.outputTokens, 40)
  assert.equal(body.actual.turn, 3)
})

test('config 路由 GET 返回字段表、当前值与文件路径', () => {
  const handler = createConfigHandler({
    getConfig: () => ({ maxRecallTokens: 1500 }),
    configFile: 'C:/Users/x/.dsh/fold-config.json',
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(configPath), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.config.maxRecallTokens, 1500)
  assert.equal(body.filePath, 'C:/Users/x/.dsh/fold-config.json')
  const keys = body.fields.map((field) => field.key)
  assert.ok(keys.includes('recallIndexPreviewTokens'))
  assert.ok(keys.includes('systemPromptText'))
})

test('config 路由 POST 走热更新，返回新配置', async () => {
  const calls = []
  const handler = createConfigHandler({
    getConfig: () => ({ maxRecallTokens: 900 }),
    updateConfig: (patch) => {
      calls.push(patch)
      return { maxRecallTokens: 1000, ...patch }
    },
    configFile: 'C:/tmp/fold-config.json',
    log: quietLog,
  })
  const res = fakeRes()
  await handler(fakeBodyReq(configPath, 'POST', JSON.stringify({ patch: { maxRecallTokens: 1200 } })), res)
  assert.equal(res.state.status, 200)
  assert.deepEqual(calls, [{ maxRecallTokens: 1200 }])
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.config.maxRecallTokens, 1200)
  assert.deepEqual(body.changed, ['maxRecallTokens'])
})

test('config 路由 POST 拒绝非法值，且不调用 updateConfig', async () => {
  let touched = false
  const handler = createConfigHandler({
    getConfig: () => ({}),
    updateConfig: () => { touched = true; return {} },
    configFile: 'C:/tmp/fold-config.json',
    log: quietLog,
  })
  const res = fakeRes()
  await handler(fakeBodyReq(configPath, 'POST', JSON.stringify({ patch: { maxRecallTokens: -5 } })), res)
  assert.equal(res.state.status, 400)
  assert.equal(touched, false)
  assert.ok(JSON.parse(res.state.body).errors.length > 0)
})

test('config 路由 POST reset 用默认值覆盖', async () => {
  const handler = createConfigHandler({
    getConfig: () => ({ maxRecallTokens: 900 }),
    updateConfig: (patch) => patch,
    configFile: 'C:/tmp/fold-config.json',
    log: quietLog,
  })
  const res = fakeRes()
  await handler(fakeBodyReq(configPath, 'POST', JSON.stringify({ reset: true })), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.config.maxRecallTokens, 1000)
  assert.equal(body.config.minFoldRatio, 0.5)
})

test('/fold-* 只允许本机同源：非回环 Host、跨站 Origin、非 JSON POST 都 403', async () => {
  const routes = []
  const ctx = { webServer: { register(route) { routes.push(route); return () => {} } } }
  registerStatsRoute({
    ctx,
    log: quietLog,
    // 给 s1 一条账本：同源请求要落在 200 上；没有数据的 id 现在会明确 404。
    makeStore: (id) =>
      makeStore(id === 's1' ? [{ kind: 'fold', id: 'f1', turn: 1, at: 1, chars: 40, note: 'n', items: [{ seq: 1, text: 'x'.repeat(40) }] }] : []),
    getConfig: () => ({}),
    updateConfig: (patch) => patch,
  })
  const stats = routes.find((route) => route.path === statsPath)
  assert.ok(stats)

  const badHost = fakeRes()
  stats.handler({ url: statsPath + '?session=s1', method: 'GET', headers: { host: 'attacker.example' } }, badHost)
  assert.equal(badHost.state.status, 403, 'DNS rebinding 的 Host 不是回环地址')

  const badOrigin = fakeRes()
  stats.handler({ url: statsPath + '?session=s1', method: 'GET', headers: { host: '127.0.0.1:3633', origin: 'http://evil.example' } }, badOrigin)
  assert.equal(badOrigin.state.status, 403, '跨站 Origin 不能读历史')

  const sameOrigin = fakeRes()
  stats.handler({ url: statsPath + '?session=s1', method: 'GET', headers: { host: '127.0.0.1:3633', origin: 'http://127.0.0.1:3633' } }, sameOrigin)
  assert.equal(sameOrigin.state.status, 200)

  const config = routes.find((route) => route.path === configPath)
  const plain = fakeBodyReq(configPath, 'POST', JSON.stringify({ patch: { maxRecallTokens: 900 } }))
  plain.headers = { host: '127.0.0.1:3633', origin: 'http://127.0.0.1:3633', 'content-type': 'text/plain' }
  const denied = fakeRes()
  await config.handler(plain, denied)
  assert.equal(denied.state.status, 403, '简单请求（text/plain）带不了 JSON，CSRF 进不来')

  const json = fakeBodyReq(configPath, 'POST', JSON.stringify({ patch: { maxRecallTokens: 900 } }))
  json.headers = { host: '127.0.0.1:3633', origin: 'http://127.0.0.1:3633', 'content-type': 'application/json' }
  const allowed = fakeRes()
  await config.handler(json, allowed)
  assert.equal(allowed.state.status, 200)
})


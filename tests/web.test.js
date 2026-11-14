import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compositionPath,
  configPath,
  createCompositionHandler,
  createConfigHandler,
  createReportHandler,
  createStatsHandler,
  createViewHandler,
  registerStatsRoute,
  reportPath,
  statsPath,
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
    getConfig: () => ({ minFoldTokens: 300 }),
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
  assert.equal(body.config.minFoldTokens, 300)
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

test('registerStatsRoute 挂五条 exact 路由并随 dispose 撤销', () => {
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
  assert.deepEqual(routes.map((route) => route.path), [statsPath, reportPath, viewPath, compositionPath, configPath])
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

test('report 路由缺 session 参数时 400', () => {
  const handler = createReportHandler({ resolveSessionById: () => undefined, makeStore: () => makeStore([]), getConfig: () => ({}), log: quietLog })
  const res = fakeRes()
  handler(fakeReq(reportPath), res)
  assert.equal(res.state.status, 400)
  assert.match(res.state.headers['content-type'], /text\/html/)
})

test('report 路由找不到会话时 404', () => {
  const handler = createReportHandler({ resolveSessionById: () => undefined, makeStore: () => makeStore([]), getConfig: () => ({}), log: quietLog })
  const res = fakeRes()
  handler(fakeReq(reportPath + '?session=gone'), res)
  assert.equal(res.state.status, 404)
  assert.match(res.state.body, /gone/)
})

test('report 路由渲染整页 HTML（含逐轮历史与折叠摘要）', () => {
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '把仓库放到 E 盘' }], source: { kind: 'user' } },
    { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: '先看目录' }, { type: 'text', text: '好的，开始搬。' }], source: { kind: 'model', provider: 'p', model: 'm' } },
  ]
  const records = [
    { kind: 'fold', id: 'f1', turn: 1, at: 1, chars: 900, note: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回', items: [{ seq: 1, text: '[思考] ' + 'x'.repeat(400) }] },
  ]
  const handler = createReportHandler({
    resolveSessionById: (id) => (id === 's1' ? fakeSession('s1', messages) : undefined),
    makeStore: () => makeStore(records),
    getConfig: () => ({ minFoldTokens: 300 }),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(reportPath + '?session=s1'), res)
  assert.equal(res.state.status, 200)
  assert.match(res.state.headers['content-type'], /text\/html/)
  assert.match(res.state.body, /<!doctype html>/i)
  assert.match(res.state.body, /逐轮历史/)
  assert.match(res.state.body, /把仓库放到 E 盘/)
  assert.match(res.state.body, /折叠摘要/)
})

test('report 路由没有派生消息时给出说明页', () => {
  const handler = createReportHandler({
    resolveSessionById: () => fakeSession('s2', []),
    makeStore: () => makeStore([]),
    getConfig: () => ({}),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(reportPath + '?session=s2'), res)
  assert.equal(res.state.status, 200)
  assert.match(res.state.body, /还没有派生消息/)
})
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

test('view 路由返回逐轮 JSON，且不带整段原文', () => {
  const records = [
    { kind: 'fold', id: 'f1', turn: 1, at: 1, chars: 900, note: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回', items: [{ seq: 1, text: '[思考] ' + 'x'.repeat(400) }] },
  ]
  const handler = createViewHandler({
    resolveSessionById: (id) => (id === 's1' ? fakeSession('s1', demoMessages) : undefined),
    makeStore: () => makeStore(records),
    getConfig: () => ({ minFoldTokens: 1200, recallDirectTokens: 8000 }),
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(viewPath + '?session=s1'), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 's1')
  assert.ok(Array.isArray(body.groups) && body.groups.length > 0)
  assert.equal(body.config.recallDirectTokens, 8000)
  for (const group of body.groups) {
    for (const entry of group.entries) {
      assert.equal('text' in entry, false)
      assert.ok(Array.isArray(entry.blocks))
    }
  }
  assert.ok(JSON.stringify(body).includes('先看目录'))
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
  assert.equal(body.version, 3)
})

test('view 路由给出上下文构成：分类、折叠后与不折叠两套占比、逐块累计', () => {
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
  const composition = body.composition
  assert.deepEqual(composition.categories.map((item) => item.key), [
    'system',
    'systemHistory',
    'user',
    'assistant',
    'tools',
    'inject',
    'checkpoint',
    'pin',
  ])
  assert.equal(composition.points.length, body.groups.length)
  assert.ok(composition.totals.folded.system > 0)
  assert.ok(composition.totals.folded.user > 0)
  assert.ok(composition.totals.folded.assistant > 0)
  assert.ok(composition.totals.folded.pin > 0)
  assert.ok(composition.totals.sum.folded > 0)
  const last = composition.points[composition.points.length - 1]
  assert.deepEqual(last.cumulative.folded, composition.totals.folded)
  assert.ok(JSON.stringify(composition).length > 0)
})

test('composition 路由只回构成数据，格式与 view 的 composition 一致', () => {
  const messages = [
    { id: 's1', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system' } },
    ...demoMessages,
  ]
  const handler = createCompositionHandler({
    resolveSessionById: (id) => (id === 's1' ? fakeSession('s1', messages) : undefined),
    makeStore: () => makeStore([]),
    getConfig: () => ({ minFoldTokens: 300 }),
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
    getConfig: () => ({ minFoldTokens: 1500 }),
    configFile: 'C:/Users/x/.dsh/fold-config.json',
    log: quietLog,
  })
  const res = fakeRes()
  handler(fakeReq(configPath), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.config.minFoldTokens, 1500)
  assert.equal(body.filePath, 'C:/Users/x/.dsh/fold-config.json')
  const keys = body.fields.map((field) => field.key)
  assert.ok(keys.includes('recallDirectTokens'))
  assert.ok(keys.includes('systemPromptText'))
})

test('config 路由 POST 走热更新，返回新配置', async () => {
  const calls = []
  const handler = createConfigHandler({
    getConfig: () => ({ minFoldTokens: 300 }),
    updateConfig: (patch) => {
      calls.push(patch)
      return { minFoldTokens: 1200, ...patch }
    },
    configFile: 'C:/tmp/fold-config.json',
    log: quietLog,
  })
  const res = fakeRes()
  await handler(fakeBodyReq(configPath, 'POST', JSON.stringify({ patch: { minFoldTokens: 900 } })), res)
  assert.equal(res.state.status, 200)
  assert.deepEqual(calls, [{ minFoldTokens: 900 }])
  const body = JSON.parse(res.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.config.minFoldTokens, 900)
  assert.deepEqual(body.changed, ['minFoldTokens'])
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
  await handler(fakeBodyReq(configPath, 'POST', JSON.stringify({ patch: { minFoldTokens: -5 } })), res)
  assert.equal(res.state.status, 400)
  assert.equal(touched, false)
  assert.ok(JSON.parse(res.state.body).errors.length > 0)
})

test('config 路由 POST reset 用默认值覆盖', async () => {
  const handler = createConfigHandler({
    getConfig: () => ({ minFoldTokens: 300 }),
    updateConfig: (patch) => patch,
    configFile: 'C:/tmp/fold-config.json',
    log: quietLog,
  })
  const res = fakeRes()
  await handler(fakeBodyReq(configPath, 'POST', JSON.stringify({ reset: true })), res)
  assert.equal(res.state.status, 200)
  const body = JSON.parse(res.state.body)
  assert.equal(body.config.minFoldTokens, 300)
  assert.equal(body.config.recallDirectTokens, 500)
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
  const plain = fakeBodyReq(configPath, 'POST', JSON.stringify({ patch: { minFoldTokens: 900 } }))
  plain.headers = { host: '127.0.0.1:3633', origin: 'http://127.0.0.1:3633', 'content-type': 'text/plain' }
  const denied = fakeRes()
  await config.handler(plain, denied)
  assert.equal(denied.state.status, 403, '简单请求（text/plain）带不了 JSON，CSRF 进不来')

  const json = fakeBodyReq(configPath, 'POST', JSON.stringify({ patch: { minFoldTokens: 900 } }))
  json.headers = { host: '127.0.0.1:3633', origin: 'http://127.0.0.1:3633', 'content-type': 'application/json' }
  const allowed = fakeRes()
  await config.handler(json, allowed)
  assert.equal(allowed.state.status, 200)
})


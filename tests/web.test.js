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
import { describeFold, foldParts, renderFoldParts } from '../lib/recall.js'

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

test('view 与 turn 路由带召回标记：条目、轮次合计与页面合计', () => {
  const fold = {
    kind: 'fold',
    id: 'f1',
    turn: 1,
    at: 1,
    chars: 100,
    note: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回',
    // 折叠前的调用：宿主把工具包在 run_code 里时，真正的召回写在脚本里（参数是 JSON，脚本在 code 字段）。
    items: [
      {
        seq: 2,
        text: '[调用 run_code] ' + JSON.stringify({ code: 'await tools.fold_recall({ id: "f1", parts: ["2"] })' }),
      },
    ],
  }
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } },
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', name: 'fold_recall', arguments: '{"id":"f9"}' }], source: { kind: 'model' } },
    { id: 't1', role: 'tool', content: [{ type: 'text', text: '折叠 f9（第 1 轮）取回 1/2 段' }], source: { kind: 'model' } },
    { id: 'c1', role: 'user', content: [{ type: 'text', text: '【已折叠历史】 f1' }], source: { kind: 'checkpoint', foldId: 'f1' } },
  ]
  const store = {
    readAll: () => [fold, { kind: 'recall', id: 'f1', at: 2, mode: 'parts' }],
    folds: () => new Map([['f1', fold]]),
    pins: () => [],
  }
  const session = fakeSession('s1', messages)
  const view = createViewHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const viewRes = fakeRes()
  view(fakeReq(viewPath + '?session=s1'), viewRes)
  const body = JSON.parse(viewRes.state.body)
  // 首包没有条目，轮次合计与页面合计仍要能直接显示。
  const group = body.groups.find((item) => item.kind === 'turn')
  assert.equal(group.recallCallCount, 2)
  assert.equal(group.recallSearchCount, 0)
  assert.equal(group.recalledCount, 1)
  assert.deepEqual(body.recallTotals, { calls: 2, searches: 0, recalled: 1, folds: 1, parts: 0, searched: 0, searchedFolds: 0 })

  const turn = createTurnHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const turnRes = fakeRes()
  turn(fakeReq(turnPath + '?session=s1&ordinal=' + group.ordinal), turnRes)
  const entries = JSON.parse(turnRes.state.body).entries
  const direct = entries.find((entry) => !entry.isCheckpoint && entry.recallCalls.length > 0)
  assert.equal(direct.recallCalls[0].id, 'f9')
  const checkpoint = entries.find((entry) => entry.isCheckpoint)
  assert.equal(checkpoint.recalledCount, 1)
  assert.equal(checkpoint.foldedRecallCount, 1)
  assert.equal(checkpoint.foldRecord.items[0].recallCalls[0].id, 'f1')
  // 块归属跟着下发：页面按块切段后才知道标记该挂在哪一段。
  assert.deepEqual(checkpoint.foldRecord.items[0].recallCallBlocks, [0])
})

test('分段召回标记：标到具体段，父级只做加法', () => {
  const fold = {
    kind: 'fold',
    id: 'f1',
    turn: 1,
    at: 1,
    chars: 160,
    note: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回',
    // 检查点里回复被截断，回复段参与分段编号。
    replyTruncated: true,
    items: [
      { seq: 11, text: '[思考] 第一段 ' + 'x'.repeat(40) },
      { seq: 12, text: '[工具结果] 第二段 ' + 'y'.repeat(40) },
      { seq: 13, text: '[回复] 第三段' },
    ],
  }
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } },
    { id: 'c1', role: 'user', content: [{ type: 'text', text: '【已折叠历史】 f1' }], source: { kind: 'checkpoint', foldId: 'f1' } },
    // 两次分段召回：一次选第 2 段，一次选 1-2 段；段次合计 3。
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', name: 'fold_recall', arguments: '{"id":"f1","parts":["2"]}' }], source: { kind: 'model' } },
    { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', name: 'fold_recall', arguments: '{"id":"f1","parts":["1-2"]}' }], source: { kind: 'model' } },
  ]
  const store = {
    readAll: () => [fold, { kind: 'recall', id: 'f1', at: 2, mode: 'parts' }, { kind: 'recall', id: 'f1', at: 3, mode: 'parts' }],
    folds: () => new Map([['f1', fold]]),
    pins: () => [],
  }
  const session = fakeSession('s1', messages)
  const view = createViewHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const viewRes = fakeRes()
  view(fakeReq(viewPath + '?session=s1'), viewRes)
  const body = JSON.parse(viewRes.state.body)
  const group = body.groups.find((item) => item.kind === 'turn')
  assert.equal(group.recalledCount, 2)
  assert.equal(group.recalledPartCount, 3)
  assert.equal(body.recallTotals.parts, 3)

  const turn = createTurnHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const turnRes = fakeRes()
  turn(fakeReq(turnPath + '?session=s1&ordinal=' + group.ordinal), turnRes)
  const entries = JSON.parse(turnRes.state.body).entries
  // 调用本身也带解析出的段号：页面上的 chip 直接是「召回 f1 · 段 #2」。
  const calling = entries.filter((entry) => !entry.isCheckpoint && entry.recallCalls.length > 0)
  assert.deepEqual(calling[0].recallCalls[0].segments, [2])
  assert.equal(calling[0].recallCalls[0].segmentCount, 1)
  assert.deepEqual(calling[1].recallCalls[0].segments, [1, 2])
  assert.equal(calling[1].recallCalls[0].segmentCount, 2)

  const checkpoint = entries.find((entry) => entry.isCheckpoint)
  assert.deepEqual(checkpoint.recalledParts, { 1: 1, 2: 2 })
  assert.equal(checkpoint.recalledPartCount, 3)
  // 客户端要按同一条规则跳过长回复段，得知道回复有没有被截断。
  assert.equal(checkpoint.foldRecord.replyTruncated, true)
})

test('关键词检索的引用：命中落到分段目录与具体段，目录反过来能查到检索', () => {
  const fold = {
    kind: 'fold',
    id: 'f1',
    turn: 1,
    at: 1,
    chars: 160,
    note: '【已折叠历史】 第 1 轮已折叠，原文用 fold_recall("f1") 召回',
    replyTruncated: false,
    items: [
      { seq: 11, text: '[思考] 第一段 ' + 'x'.repeat(40) },
      { seq: 12, text: '[工具结果] 第二段 ' + 'y'.repeat(40) },
      { seq: 13, text: '[回复] 第三段' },
    ],
  }
  // 检索结果的原样文本：每条折叠一行头，下面是列出的段号，没列出来的只有数量。
  const searchText = [
    '检索「lib/web.js」：命中 2 条折叠、共 3 段（按轮次从近到远）。检索不返回原文，也不算一次召回。',
    '- f1（第 1 轮）命中 2/3 段',
    '  #1 [思考] 45 字：第一段 xxxx',
    '  #2 [工具结果] 45 字：第二段 yyyy',
    '  …还有 1 段命中，用 parts 区间选',
    '- f9（第 1 轮）命中 1/2 段',
    '  #1 [思考] 10 字：别的折叠',
    '取回原文：fold_recall({id:"f1", parts:["1","2"]})',
  ].join('\n')
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } },
    { id: 'c1', role: 'user', content: [{ type: 'text', text: '【已折叠历史】 f1' }], source: { kind: 'checkpoint', foldId: 'f1' } },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: '第二句' }], source: { kind: 'user' } },
    // 只给 query 的检索：没有折叠编号，原文不返回，命中的是别的折叠的分段目录。
    { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', name: 'fold_recall', arguments: '{"query":"lib/web.js"}' }], source: { kind: 'model' } },
    { id: 't2', role: 'tool', content: [{ type: 'text', text: searchText }], source: { kind: 'model' } },
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
  const body = JSON.parse(viewRes.state.body)
  const checkpointGroup = body.groups.find((item) => item.kind === 'turn' && item.searchedCount > 0)
  assert.ok(checkpointGroup, '被检索的折叠所在的轮要有合计')
  assert.equal(checkpointGroup.searchedCount, 1)
  assert.equal(checkpointGroup.searchedPartCount, 2)
  // 页面合计与轮次标签只做加法：f9 没有落点，但它的命中段仍计入总数。
  assert.equal(body.recallTotals.searched, 2)
  assert.equal(body.recallTotals.searchedFolds, 1)

  const turn = createTurnHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const turnRes = fakeRes()
  turn(fakeReq(turnPath + '?session=s1&ordinal=' + checkpointGroup.ordinal), turnRes)
  const entries = JSON.parse(turnRes.state.body).entries
  const checkpoint = entries.find((entry) => entry.isCheckpoint)
  // 段级：命中的两段各记一条引用，带关键词；不是被召回，所以 recalledParts 不出现。
  assert.deepEqual(Object.keys(checkpoint.searchedParts).sort(), ['1', '2'])
  assert.equal(checkpoint.searchedParts[1][0].query, 'lib/web.js')
  assert.equal(checkpoint.searchedPartCount, 2)
  assert.equal(checkpoint.searchedCount, 1)
  assert.equal(checkpoint.recalledParts, undefined)
  // 折叠级：这张目录被哪次检索用过、命中多少段。
  assert.equal(checkpoint.searchedRefs.length, 1)
  assert.equal(checkpoint.searchedRefs[0].count, 2)
  assert.equal(checkpoint.searchedRefs[0].totalParts, 3)
  assert.deepEqual(checkpoint.searchedRefs[0].numbers, [1, 2])
  assert.equal(typeof checkpoint.searchedRefs[0].i, 'number')
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

test('召回调用按工具结果标到段，并带调用与被召回的落点', () => {
  const fold = {
    kind: 'fold',
    id: 'f1',
    turn: 1,
    at: 1,
    chars: 120,
    replyTruncated: true,
    items: [
      { seq: 11, text: '[思考] ' + 'x'.repeat(40) },
      { seq: 12, text: '[工具结果] ' + 'y'.repeat(40) },
    ],
  }
  const parts = foldParts(fold)
  const partsText = renderFoldParts(fold, parts.filter((part) => part.no === 2), { total: parts.length, maxChars: 20000 })
  const directText = describeFold(fold)
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } },
    { id: 'c1', role: 'user', content: [{ type: 'text', text: '【已折叠历史】 f1' }], source: { kind: 'checkpoint', foldId: 'f1' } },
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', name: 'fold_recall', arguments: '{"id":"f1","parts":["2"]}' }], source: { kind: 'model' } },
    { id: 't1', role: 'tool', content: [{ type: 'text', text: partsText }], source: { kind: 'model' } },
    { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', name: 'fold_recall', arguments: '{"id":"f1"}' }], source: { kind: 'model' } },
    { id: 't2', role: 'tool', content: [{ type: 'text', text: directText }], source: { kind: 'model' } },
    { id: 'a3', role: 'assistant', content: [{ type: 'tool-call', name: 'fold_recall', arguments: '{"id":"f1","parts":["reply"]}' }], source: { kind: 'model' } },
    { id: 't3', role: 'tool', content: [{ type: 'text', text: '折叠 f1 里没有回复段（这条折叠共 2 段）。' }], source: { kind: 'model' } },
  ]
  const store = { readAll: () => [fold], folds: () => new Map([['f1', fold]]), pins: () => [] }
  const session = fakeSession('s1', messages)
  const view = createViewHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const viewRes = fakeRes()
  view(fakeReq(viewPath + '?session=s1'), viewRes)
  const body = JSON.parse(viewRes.state.body)
  const group = body.groups.find((item) => item.kind === 'turn')

  const turn = createTurnHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const turnRes = fakeRes()
  turn(fakeReq(turnPath + '?session=s1&ordinal=' + group.ordinal), turnRes)
  const entries = JSON.parse(turnRes.state.body).entries
  const calling = entries.filter((entry) => !entry.isCheckpoint && entry.recallCalls.length > 0)

  // 分段召回：结果里写着取回了 #2，段号按结果走，落点是这条折叠的检查点。
  assert.equal(calling[0].recallCalls[0].outcome, 'parts')
  assert.deepEqual(calling[0].recallCalls[0].segments, [2])
  assert.deepEqual(calling[0].recallCalls[0].foldLoc, { o: group.ordinal, i: 2 })
  // 整段召回：结果给的是全文，就是这条折叠的全部段。
  assert.equal(calling[1].recallCalls[0].outcome, 'direct')
  assert.deepEqual(calling[1].recallCalls[0].segments, [1, 2])
  assert.equal(calling[1].recallCalls[0].segmentCount, 2)
  // 失败召回：原因来自结果第一行，不给段号。
  assert.equal(calling[2].recallCalls[0].outcome, 'error')
  assert.equal(calling[2].recallCalls[0].note, '折叠 f1 里没有回复段（这条折叠共 2 段）。')
  assert.equal(calling[2].recallCalls[0].segments, undefined)

  // 被召回的一端：段 2 只被第一次（参数选段）调用取回，引用表指向调用所在的条目。
  const checkpoint = entries.find((entry) => entry.isCheckpoint)
  assert.deepEqual(checkpoint.partRefs, { 2: [{ o: group.ordinal, i: 3, t: 1, id: 'f1' }] })
})

test('调用发生在折叠原文里时，引用落点精确到那一段', () => {
  const target = {
    kind: 'fold',
    id: 'f1',
    turn: 1,
    at: 1,
    chars: 90,
    replyTruncated: true,
    items: [
      { seq: 11, text: '[思考] ' + 'x'.repeat(30) },
      { seq: 12, text: '[工具结果] ' + 'y'.repeat(30) },
    ],
  }
  // 第二次调用发生在 f2 的折叠原文里：引用表要记住它是第 2 段发出的，
  // 否则点「第 2 段被谁召回过」只会打开检查点，看不出是哪一处调用。
  const caller = {
    kind: 'fold',
    id: 'f2',
    turn: 2,
    at: 2,
    chars: 120,
    replyTruncated: true,
    items: [
      { seq: 20, text: '[思考] 先看目录' },
      { seq: 20, text: '[调用 run_code] ' + JSON.stringify({ code: 'await tools.fold_recall({ id: "f1", parts: ["2"] })' }) },
      { seq: 21, text: '[工具结果] 折叠 f1 取回 #2' },
    ],
  }
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } },
    { id: 'c1', role: 'user', content: [{ type: 'text', text: '【已折叠历史】 f1' }], source: { kind: 'checkpoint', foldId: 'f1' } },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: '第二句' }], source: { kind: 'user' } },
    { id: 'c2', role: 'user', content: [{ type: 'text', text: '【已折叠历史】 f2' }], source: { kind: 'checkpoint', foldId: 'f2' } },
  ]
  const store = { readAll: () => [target, caller], folds: () => new Map([['f1', target], ['f2', caller]]), pins: () => [] }
  const session = fakeSession('s1', messages)
  const view = createViewHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const viewRes = fakeRes()
  view(fakeReq(viewPath + '?session=s1'), viewRes)
  const groups = JSON.parse(viewRes.state.body).groups.filter((item) => item.kind === 'turn')
  assert.equal(groups.length, 2)

  const turn = createTurnHandler({ resolveSessionById: () => session, makeStore: () => store, getConfig: () => ({}), log: quietLog })
  const read = (group) => {
    const res = fakeRes()
    turn(fakeReq(turnPath + '?session=s1&ordinal=' + group.ordinal), res)
    return JSON.parse(res.state.body).entries
  }
  const first = read(groups[0])
  const second = read(groups[1])
  const fromFold = second.find((entry) => entry.isCheckpoint)
  // 调用在 f2 原文的第 2 段（第 1 段是思考、第 3 段是结果）。
  assert.equal(fromFold.foldRecord.items[1].recallCalls[0].partNo, 2)

  const checkpoint = first.find((entry) => entry.isCheckpoint)
  assert.deepEqual(checkpoint.partRefs, {
    2: [{ o: groups[1].ordinal, i: fromFold.index, t: 2, id: 'f1', part: 2 }],
  })
})

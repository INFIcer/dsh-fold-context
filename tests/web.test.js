import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStatsHandler, registerStatsRoute, statsPath } from '../lib/web.js'

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
    getConfig: () => ({ minFoldChars: 1200 }),
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
  assert.equal(body.config.minFoldChars, 1200)
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

test('registerStatsRoute 挂 exact 路由并随 dispose 撤销', () => {
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
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, statsPath)
  handle.dispose()
  assert.equal(routes[0].disposed, true)
})

test('没有 webServer 时静默降级', () => {
  const handle = registerStatsRoute({ ctx: {}, log: quietLog, makeStore: () => makeStore([]), getConfig: () => ({}) })
  assert.equal(typeof handle.dispose, 'function')
  handle.dispose()
})

// 顶栏统计页的数据源：GET /fold-stats?session=<id>。
//
// 为什么走宿主 HTTP 路由：客户端 bundle 拿不到宿主对象，最稳的数据通道是同源 fetch。
// git-graph 插件就是这么做的（ctx.webServer.register + 客户端 fetch）。
// 路由失败绝不能影响折叠本身：所有错误都降级成日志。

import { buildStats } from './stats.js'
import { buildHtmlReport, buildReportModel, collectRecords } from './inspect.js'
import { derivedMessagesOf } from './inspect-tool.js'

export const statsPath = '/fold-stats'
export const reportPath = '/fold-report'

function messageOf(error) {
  try {
    return error && error.message ? String(error.message) : String(error)
  } catch {
    return 'unknown error'
  }
}

function sendJson(res, status, payload, headOnly) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  // HEAD 只回头，不回体。
  res.end(headOnly ? undefined : body)
}

// 只接受 GET/HEAD；缺 session 参数直接 400，让前端能显示清楚的原因。
export function createStatsHandler({ makeStore, getConfig, log }) {
  return function statsHandler(req, res) {
    try {
      const method = String((req && req.method) || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      const rawUrl = (req && (req.url || req.originalUrl)) || statsPath
      let sessionId = ''
      try {
        const parsed = new URL(rawUrl, 'http://localhost')
        sessionId = String(parsed.searchParams.get('session') || '').trim()
      } catch {
        sessionId = ''
      }
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: '缺少 session 参数：/fold-stats?session=<会话 id>' }, method === 'HEAD')
        return
      }
      let records = []
      try {
        const store = typeof makeStore === 'function' ? makeStore(sessionId) : null
        records = store && typeof store.readAll === 'function' ? store.readAll() : []
      } catch (error) {
        log && log.warn('读取折叠载荷失败（' + sessionId + '）：' + messageOf(error))
      }
      const stats = buildStats({ records, config: typeof getConfig === 'function' ? getConfig() : null, now: Date.now() })
      sendJson(res, 200, { ...stats, sessionId }, method === 'HEAD')
    } catch (error) {
      log && log.warn('统计路由失败：' + messageOf(error))
      try {
        sendJson(res, 500, { ok: false, error: messageOf(error) })
      } catch {
        // 头已经发出去就改不了了。
      }
    }
  }
}

function sendHtml(res, status, body, headOnly) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(headOnly ? undefined : body)
}

function sessionParamOf(req, fallback) {
  const rawUrl = (req && (req.url || req.originalUrl)) || fallback
  try {
    const parsed = new URL(rawUrl, 'http://localhost')
    return String(parsed.searchParams.get('session') || '').trim()
  } catch {
    return ''
  }
}

function methodOf(req) {
  return String((req && req.method) || 'GET').toUpperCase()
}

// GET /fold-report?session=<id>：服务端现算一份逐轮 HTML 报告，浏览器直接打开就能看。
// 和 fold_inspect 工具同一套模型与渲染，区别只是不落盘、每次都按当前历史重算。
export function createReportHandler({ resolveSessionById, makeStore, getConfig, log }) {
  return function reportHandler(req, res) {
    try {
      const method = methodOf(req)
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      const sessionId = sessionParamOf(req, reportPath)
      if (!sessionId) {
        sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>缺少 session 参数：/fold-report?session=&lt;会话 id&gt;</p>', method === 'HEAD')
        return
      }
      let session = null
      try {
        session = typeof resolveSessionById === 'function' ? resolveSessionById(sessionId) : null
      } catch (error) {
        log && log.warn('解析会话失败（' + sessionId + '）：' + messageOf(error))
      }
      if (!session) {
        sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p>找不到会话 ' + escapeHtml(sessionId) + '：只能看当前进程里还活着的会话。</p>', method === 'HEAD')
        return
      }
      const derivedMessages = derivedMessagesOf(session)
      if (derivedMessages.length === 0) {
        sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><p>这个会话还没有派生消息（历史为空），没有可渲染的内容。</p>', method === 'HEAD')
        return
      }
      let records = { folds: new Map(), pins: [], recalls: [] }
      try {
        const store = typeof makeStore === 'function' ? makeStore(sessionId) : null
        if (store) records = collectRecords(store)
      } catch (error) {
        log && log.warn('读取折叠载荷失败（' + sessionId + '）：' + messageOf(error))
      }
      const model = buildReportModel({
        sessionId,
        derivedMessages,
        folds: records.folds,
        pins: records.pins,
        recalls: records.recalls,
        config: typeof getConfig === 'function' ? getConfig() : null,
      })
      sendHtml(res, 200, buildHtmlReport(model), method === 'HEAD')
    } catch (error) {
      log && log.warn('报告路由失败：' + messageOf(error))
      try {
        sendHtml(res, 500, '<!doctype html><meta charset="utf-8"><p>生成报告失败：' + escapeHtml(messageOf(error)) + '</p>')
      } catch {
        // 头已经发出去就改不了了。
      }
    }
  }
}

function escapeHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// webServer 是可选依赖：没有它（无 GUI 的宿主）时静默跳过，折叠照旧。
export function registerStatsRoute({ ctx, log, makeStore, getConfig, resolveSessionById }) {
  const disposers = []
  const routes = [
    { path: statsPath, handler: createStatsHandler({ makeStore, getConfig, log }) },
    { path: reportPath, handler: createReportHandler({ resolveSessionById, makeStore, getConfig, log }) },
  ]

  function attach(service) {
    if (!service || typeof service.register !== 'function') return false
    let ok = false
    for (const route of routes) {
      try {
        const dispose = service.register({ kind: 'exact', path: route.path, handler: route.handler })
        disposers.push(typeof dispose === 'function' ? dispose : () => {})
        ok = true
      } catch (error) {
        log && log.warn('注册 ' + route.path + ' 路由失败：' + messageOf(error))
      }
    }
    return ok
  }

  let service = null
  try {
    service = ctx && ctx.webServer ? ctx.webServer : null
  } catch {
    service = null
  }
  if (!service && ctx && typeof ctx.get === 'function') {
    try {
      service = ctx.get('webServer')
    } catch {
      service = null
    }
  }
  if (attach(service)) return wrap(disposers)

  // 服务可能晚于本插件就绪：等它出现再挂路由。
  if (ctx && typeof ctx.inject === 'function') {
    try {
      const off = ctx.inject(['webServer'], (scope) => {
        let late = null
        try {
          late = scope && scope.webServer ? scope.webServer : (scope && typeof scope.get === 'function' ? scope.get('webServer') : null)
        } catch {
          late = null
        }
        attach(late)
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      log && log.warn('等待 webServer 失败：' + messageOf(error))
    }
  } else {
    log && log.info('webServer 不可用，跳过顶栏统计路由（折叠不受影响）')
  }
  return wrap(disposers)
}

function wrap(disposers) {
  return {
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 服务卸载后撤销可能失败，忽略。
        }
      }
    },
  }
}

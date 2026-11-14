// 顶栏统计页的数据源：GET /fold-stats?session=<id>。
//
// 为什么走宿主 HTTP 路由：客户端 bundle 拿不到宿主对象，最稳的数据通道是同源 fetch。
// git-graph 插件就是这么做的（ctx.webServer.register + 客户端 fetch）。
// 路由失败绝不能影响折叠本身：所有错误都降级成日志。

import { buildStats } from './stats.js'

export const statsPath = '/fold-stats'

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

// webServer 是可选依赖：没有它（无 GUI 的宿主）时静默跳过，折叠照旧。
export function registerStatsRoute({ ctx, log, makeStore, getConfig }) {
  const disposers = []
  const handler = createStatsHandler({ makeStore, getConfig, log })

  function attach(service) {
    if (!service || typeof service.register !== 'function') return false
    try {
      const dispose = service.register({ kind: 'exact', path: statsPath, handler })
      disposers.push(typeof dispose === 'function' ? dispose : () => {})
      return true
    } catch (error) {
      log && log.warn('注册 ' + statsPath + ' 路由失败：' + messageOf(error))
      return false
    }
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

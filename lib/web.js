// 顶栏统计页的数据源：GET /fold-stats?session=<id>。
//
// 为什么走宿主 HTTP 路由：客户端 bundle 拿不到宿主对象，最稳的数据通道是同源 fetch。
// git-graph 插件就是这么做的（ctx.webServer.register + 客户端 fetch）。
// 路由失败绝不能影响折叠本身：所有错误都降级成日志。

import { buildStats } from './stats.js'
import { buildComposition } from './composition.js'
import { buildCost, normalizeLatest } from './cost.js'
import { buildHtmlReport, buildReportModel, collectRecords } from './inspect.js'
import {
  configFields,
  defaultConfig,
  mergeConfigFile,
  normalizeConfig,
  validateConfigPatch,
} from './config.js'

export const statsPath = '/fold-stats'
export const reportPath = '/fold-report'
export const viewPath = '/fold-view'
export const compositionPath = '/fold-composition'
export const configPath = '/fold-config'

// 派生消息是「模型视角」的唯一可信来源；老宿主没有这个接口时退回 messages，再没有就返回空。
function derivedMessagesOf(session) {
  if (!session) return []
  if (typeof session.deriveMessages === 'function') {
    const list = session.deriveMessages()
    return Array.isArray(list) ? list : []
  }
  if (Array.isArray(session.messages)) return session.messages
  if (typeof session.messages === 'function') {
    const list = session.messages()
    return Array.isArray(list) ? list : []
  }
  return []
}

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

// 会话 id 有两种形状：宿主登记的 'session-<uuid>'，和用户/日志里更常见的纯 uuid。
// 两个都试，命中哪个就把后续读载荷、派生消息的 key 换成哪个。
function sessionIdCandidates(id) {
  const key = String(id || '').trim()
  if (!key) return []
  return /^session-/.test(key) ? [key] : [key, 'session-' + key]
}

// 先把宿主 id 形状让给调用方：纯 uuid 也能直接查（客户端粘贴的往往是 uuid）。
function findSession(resolveSessionById, sessionId) {
  if (typeof resolveSessionById !== 'function') return null
  for (const candidate of sessionIdCandidates(sessionId)) {
    try {
      const session = resolveSessionById(candidate)
      if (session) return { id: candidate, session }
    } catch {
      // 某个形状解析失败时继续试下一个。
    }
  }
  return null
}

function sessionNotFoundText(sessionId) {
  return (
    '找不到会话 ' +
    sessionId +
    '：id 可能要带 session- 前缀；带前缀仍找不到时，说明这个会话还没有在当前进程里加载' +
    '（先在 DSH 界面里打开它，或等它再跑一轮）。'
  )
}

// 只接受 GET/HEAD；缺 session 参数直接 400，让前端能显示清楚的原因。
export function createStatsHandler({ makeStore, getConfig, log, getSurfacePins, resolveSessionById }) {
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
      let loadFailed = false
      try {
        const store = typeof makeStore === 'function' ? makeStore(sessionId) : null
        records = store && typeof store.readAll === 'function' ? store.readAll() : []
      } catch (error) {
        loadFailed = true
        log && log.warn('读取折叠载荷失败（' + sessionId + '）：' + messageOf(error))
      }
      // 客户端传来的可能是纯 uuid：按宿主的 'session-' 形状再读一次载荷。
      if (!loadFailed && records.length === 0) {
        for (const candidate of sessionIdCandidates(sessionId)) {
          if (candidate === sessionId) continue
          try {
            const store = typeof makeStore === 'function' ? makeStore(candidate) : null
            const alt = store && typeof store.readAll === 'function' ? store.readAll() : []
            if (alt.length) {
              sessionId = candidate
              records = alt
              break
            }
          } catch (error) {
            log && log.warn('读取折叠载荷失败（' + candidate + '）：' + messageOf(error))
          }
        }
      }
      // 既读不到账本、又解析不到会话：多半是 id 写错（例如漏了 session- 前缀）。
      // 回 200 全零会让人误判成「插件没数据」，所以明确回 404。
      if (!loadFailed && records.length === 0 && !findSession(resolveSessionById, sessionId)) {
        sendJson(res, 404, { ok: false, error: sessionNotFoundText(sessionId) }, method === 'HEAD')
        return
      }
      // 重要消息可能已被官方压缩卷走：把「模型此刻还看得见哪些 pin」交给账本，
      // 否则账本会把看不见的 pin 继续算成常驻占用。拿不到会话时 presentPins 为 null（未知）。
      let presentPins = null
      try {
        // 没有 pin 的会话不必派生消息：stats 已经是 5 秒一次的轮询，能省就省。
        if (Array.isArray(records) && records.some((record) => record && record.kind === 'pin')) {
          presentPins = typeof getSurfacePins === 'function' ? getSurfacePins(sessionId) : null
        }
      } catch {
        presentPins = null
      }
      const stats = buildStats({
        records,
        config: typeof getConfig === 'function' ? getConfig() : null,
        now: Date.now(),
        presentPins,
      })
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

// 最近一次请求的 provider 回报：只有活着的会话才有，读不到就返回 null。
function actualOf(getActualUsage, sessionId) {
  try {
    return typeof getActualUsage === 'function' ? getActualUsage(sessionId) : null
  } catch {
    return null
  }
}

// GET /fold-composition?session=<id>：只回上下文构成（分类占比 + 逐块累计）与成本估算，
// 账本页画构成图、趋势图和开销对比用。整份模型视角太大，不能每 5 秒拉一次。
export function createCompositionHandler({ resolveSessionById, makeStore, getConfig, log, getActualUsage }) {
  return function compositionHandler(req, res) {
    try {
      const method = methodOf(req)
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' }, method === 'HEAD')
        return
      }
      let sessionId = sessionParamOf(req, compositionPath)
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: '缺少 session 参数：/fold-composition?session=<会话 id>' }, method === 'HEAD')
        return
      }
      const found = findSession(resolveSessionById, sessionId)
      if (!found) {
        sendJson(res, 404, { ok: false, error: sessionNotFoundText(sessionId) }, method === 'HEAD')
        return
      }
      sessionId = found.id
      const session = found.session
      const { derivedMessages, records } = viewInputsOf({ sessionId, session, makeStore, log })
      const config = typeof getConfig === 'function' ? getConfig() : null
      const actual = actualOf(getActualUsage, sessionId)
      if (!derivedMessages.length) {
        sendJson(
          res,
          200,
          {
            ok: true,
            sessionId,
            generatedAt: Date.now(),
            composition: buildComposition({ groups: [] }),
            cost: buildCost({ groups: [], folds: records.folds, recalls: records.recalls, pins: records.pins, config, actual }),
          },
          method === 'HEAD',
        )
        return
      }
      const model = buildReportModel({
        sessionId,
        derivedMessages,
        folds: records.folds,
        pins: records.pins,
        recalls: records.recalls,
        config,
      })
      const groups = Array.isArray(model.turnGroups) ? model.turnGroups : []
      sendJson(
        res,
        200,
        {
          ok: true,
          sessionId,
          generatedAt: Date.now(),
          composition: buildComposition({ groups }),
          cost: buildCost({ groups, folds: records.folds, recalls: records.recalls, pins: records.pins, config, actual }),
        },
        method === 'HEAD',
      )
    } catch (error) {
      log && log.warn('构成路由失败：' + messageOf(error))
      try {
        sendJson(res, 500, { ok: false, error: messageOf(error) })
      } catch {
        // 头已经发出去就改不了了。
      }
    }
  }
}

// 可视化路由共用：派生消息 + 折叠载荷。载荷读不出来时退化成空账，不阻断页面。
function viewInputsOf({ sessionId, session, makeStore, log }) {
  const derivedMessages = derivedMessagesOf(session)
  let records = { folds: new Map(), pins: [], recalls: [] }
  try {
    const store = typeof makeStore === 'function' ? makeStore(sessionId) : null
    if (store) records = collectRecords(store)
  } catch (error) {
    log && log.warn('读取折叠载荷失败（' + sessionId + '）：' + messageOf(error))
  }
  return { derivedMessages, records }
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
// 和离线脚本同一套模型与渲染，区别只是不落盘、每次都按当前历史重算。
export function createReportHandler({ resolveSessionById, makeStore, getConfig, log }) {
  return function reportHandler(req, res) {
    try {
      const method = methodOf(req)
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      let sessionId = sessionParamOf(req, reportPath)
      if (!sessionId) {
        sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>缺少 session 参数：/fold-report?session=&lt;会话 id&gt;</p>', method === 'HEAD')
        return
      }
      const found = findSession(resolveSessionById, sessionId)
      if (!found) {
        sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p>' + escapeHtml(sessionNotFoundText(sessionId)) + '</p>', method === 'HEAD')
        return
      }
      sessionId = found.id
      const session = found.session
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

// 模型视角的 JSON：直接来自 session.deriveMessages()，不经过任何摘要或截断。
// 客户端按「轮」渲染，所以这里只投影 turnGroups，省掉报告模型里用不上的部分。
export function buildViewPayload(model, options = {}) {
  const folded = (model && model.folded && model.folded.totals) || {}
  const totals = model && model.totals ? model.totals : {}
  const groups = Array.isArray(model && model.turnGroups) ? model.turnGroups : []
  return {
    ok: true,
    version: 3,
    sessionId: model && model.sessionId ? model.sessionId : '',
    generatedAt: model && model.generatedAt ? model.generatedAt : Date.now(),
    totals: {
      messages: folded.count || 0,
      chars: folded.chars || 0,
      tokens: typeof folded.tokens === 'number' ? folded.tokens : 0,
      checkpoints: folded.checkpoints || 0,
      pins: folded.pins || 0,
      savedChars: totals.saved || 0,
      saveRate: totals.saveRate || 0,
      // 旧版系统提示留在 surface 里但不会上行，统计已扣掉，这里把扣掉的量报出来。
      staleSystem: (model && model.staleSystem) || { chars: 0, tokens: 0, count: 0 },
    },
    groups: groups.map(stripGroup),
    pins: buildViewPins(groups),
    composition: buildComposition({ groups }),
    // provider 回报的最近一次请求：与上面的估算不是一回事（估算量的是会话历史，
    // 实际请求可能还被请求期压缩器改写），两个数并排显示才能看出差在哪。
    actual: normalizeLatest(options.actual),
    warns: Array.isArray(model && model.warns) ? model.warns : [],
    config: pickViewConfig(model && model.config),
  }
}

// 重要消息不进单独的账，跟着它出现的轮次一起走；这里按时间顺序抽出来，
// 让「模型视角」页顶部能先看到这些永不折叠的内容。
function buildViewPins(groups) {
  const pins = []
  for (const group of groups) {
    const entries = Array.isArray(group && group.entries) ? group.entries : []
    for (const entry of entries) {
      if (!entry || entry.isPin !== true) continue
      pins.push({
        label: entry.pinLabel || '重要消息',
        turn: group.kind === 'turn' && typeof group.turn === 'number' ? group.turn : null,
        seq: entry.seq === undefined ? null : entry.seq,
        chars: typeof entry.chars === 'number' ? entry.chars : 0,
        blocks: Array.isArray(entry.blocks) ? entry.blocks : [],
      })
    }
  }
  return pins
}

// 系统提示词的差异只送渲染需要的字段：行号、增删统计、逐行类型。
function stripDiff(diff) {
  if (!diff || typeof diff !== 'object') return null
  return {
    same: diff.same === true,
    add: typeof diff.add === 'number' ? diff.add : 0,
    del: typeof diff.del === 'number' ? diff.del : 0,
    truncated: diff.truncated === true,
    clipped: diff.clipped === true,
    hunks: Array.isArray(diff.hunks)
      ? diff.hunks.map((hunk) => ({
          aStart: typeof hunk.aStart === 'number' ? hunk.aStart : 0,
          aLines: typeof hunk.aLines === 'number' ? hunk.aLines : 0,
          bStart: typeof hunk.bStart === 'number' ? hunk.bStart : 0,
          bLines: typeof hunk.bLines === 'number' ? hunk.bLines : 0,
          lines: Array.isArray(hunk.lines)
            ? hunk.lines.map((line) => ({
                t: line && (line.t === 'add' || line.t === 'del') ? line.t : 'ctx',
                text: line && typeof line.text === 'string' ? line.text : '',
              }))
            : [],
        }))
      : [],
  }
}

function pickViewConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    enabled: source.enabled !== false,
    minFoldChars: typeof source.minFoldChars === 'number' ? source.minFoldChars : 1200,
    noteRatio: typeof source.noteRatio === 'number' ? source.noteRatio : 0.1,
    recallDirectChars: typeof source.recallDirectChars === 'number' ? source.recallDirectChars : 8000,
  }
}

function stripGroup(group) {
  const source = group && typeof group === 'object' ? group : {}
  return {
    kind: source.kind || 'turn',
    turn: typeof source.turn === 'number' ? source.turn : null,
    ordinal: typeof source.ordinal === 'number' ? source.ordinal : 0,
    continuation: source.continuation === true,
    folded: source.folded === true,
    prePlugin: source.prePlugin === true,
    short: source.short === true,
    saveRate: typeof source.saveRate === 'number' ? source.saveRate : 0,
    steps: typeof source.steps === 'number' ? source.steps : 0,
    chars: typeof source.chars === 'number' ? source.chars : 0,
    unfoldedChars: typeof source.unfoldedChars === 'number' ? source.unfoldedChars : 0,
    foldIds: Array.isArray(source.foldIds) ? source.foldIds : [],
    pinLabels: Array.isArray(source.pinLabels) ? source.pinLabels : [],
    userText: typeof source.userText === 'string' ? source.userText : '',
    replyText: typeof source.replyText === 'string' ? source.replyText : '',
    replyNote: typeof source.replyNote === 'string' ? source.replyNote : '',
    version: typeof source.version === 'number' ? source.version : null,
    diff: stripDiff(source.diff),
    diffOf: typeof source.diffOf === 'number' ? source.diffOf : 0,
    entries: Array.isArray(source.entries) ? source.entries.map(stripEntry) : [],
  }
}

function stripEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {}
  const record = source.foldRecord && typeof source.foldRecord === 'object' ? source.foldRecord : null
  return {
    index: typeof source.index === 'number' ? source.index : 0,
    seq: source.seq === undefined ? null : source.seq,
    role: source.role || 'unknown',
    roleLabel: source.roleLabel || '',
    sourceKind: source.sourceKind || '',
    sourceLabel: source.sourceLabel || '',
    foldId: source.foldId || '',
    isCheckpoint: source.isCheckpoint === true,
    isPin: source.isPin === true,
    pinLabel: source.pinLabel || '',
    chars: typeof source.chars === 'number' ? source.chars : 0,
    blocks: Array.isArray(source.blocks) ? source.blocks : [],
    foldRecord: record
      ? {
          id: record.id || '',
          turn: typeof record.turn === 'number' ? record.turn : null,
          chars: typeof record.chars === 'number' ? record.chars : 0,
          items: Array.isArray(record.items)
            ? record.items.map((item) => ({
                seq: item && item.seq !== undefined ? item.seq : null,
                chars: item && typeof item.chars === 'number' ? item.chars : 0,
                blocks: item && Array.isArray(item.blocks) ? item.blocks : [],
              }))
            : [],
        }
      : null,
  }
}

// GET /fold-view?session=<id>：模型视角（折叠后）的逐轮 JSON，供顶栏折叠页渲染。
export function createViewHandler({ resolveSessionById, makeStore, getConfig, log, getActualUsage }) {
  return function viewHandler(req, res) {
    try {
      const method = methodOf(req)
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' }, method === 'HEAD')
        return
      }
      let sessionId = sessionParamOf(req, viewPath)
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: '缺少 session 参数：/fold-view?session=<会话 id>' }, method === 'HEAD')
        return
      }
      const found = findSession(resolveSessionById, sessionId)
      if (!found) {
        sendJson(res, 404, { ok: false, error: sessionNotFoundText(sessionId) }, method === 'HEAD')
        return
      }
      sessionId = found.id
      const session = found.session
      const derivedMessages = derivedMessagesOf(session)
      if (!derivedMessages.length) {
        sendJson(
          res,
          200,
          {
            ok: true,
            version: 3,
            sessionId,
            empty: true,
            groups: [],
            pins: [],
            composition: buildComposition({ groups: [] }),
            warns: [],
            totals: {},
            config: pickViewConfig(getConfig()),
          },
          method === 'HEAD',
        )
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
      sendJson(res, 200, buildViewPayload(model, { actual: actualOf(getActualUsage, sessionId) }), method === 'HEAD')
    } catch (error) {
      log && log.warn('模型视角路由失败：' + messageOf(error))
      try {
        sendJson(res, 500, { ok: false, error: messageOf(error) })
      } catch {
        // 头已经发出去就改不了了。
      }
    }
  }
}

// 设置页要一次拿到字段表与当前值：字段名、类型、范围、默认值、说明全从 configFields 来。
export function createConfigHandler({ getConfig, updateConfig, configFile, log }) {
  return async function configHandler(req, res) {
    const method = methodOf(req)
    try {
      if (method === 'GET' || method === 'HEAD') {
        const current = typeof getConfig === 'function' ? getConfig() : null
        sendJson(
          res,
          200,
          {
            ok: true,
            config: current && typeof current === 'object' ? current : defaultConfig(),
            fields: configFields(),
            filePath: configFile || '',
          },
          method === 'HEAD',
        )
        return
      }
      if (method !== 'POST') {
        res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      const body = await readJsonBody(req)
      const patch = body && body.reset === true ? defaultConfig() : body && body.patch
      const checked = validateConfigPatch(patch)
      if (!checked.ok) {
        sendJson(res, 400, { ok: false, errors: checked.errors, fields: configFields() })
        return
      }
      const before = typeof getConfig === 'function' ? getConfig() : defaultConfig()
      let next = null
      let persisted = false
      let failure = ''
      if (typeof updateConfig === 'function') {
        try {
          next = updateConfig(checked.patch)
          persisted = true
        } catch (error) {
          failure = messageOf(error)
          log && log.warn('设置页写入失败：' + failure)
        }
      }
      if (!persisted && !failure && configFile) {
        // 没有热更新接线（旧宿主）：只把 patch 合并进文件层，展示值再叠到当前配置上。
        persisted = Boolean(mergeConfigFile(configFile, checked.patch))
        if (persisted) {
          next = normalizeConfig(checked.patch, before && typeof before === 'object' ? before : defaultConfig(), (message) => {
            log && log.warn(message)
          })
        }
      }
      if (!persisted) {
        sendJson(res, 500, {
          ok: false,
          error: failure
            ? '配置未写入：' + failure
            : '配置未写入：宿主没有接线热更新，也没有可写的配置文件路径。',
        })
        return
      }
      sendJson(res, 200, {
        ok: true,
        config: next,
        fields: configFields(),
        filePath: configFile || '',
        changed: Object.keys(checked.patch),
      })
    } catch (error) {
      log && log.warn('设置路由失败：' + messageOf(error))
      try {
        sendJson(res, 500, { ok: false, error: messageOf(error) })
      } catch {
        // 头已经发出去就改不了了。
      }
    }
  }
}

function readJsonBody(req, limit = 524288) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体超过 ' + limit + ' 字节'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

function escapeHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 只允许本机同源访问：宿主自己的 /api 有浏览器 token 校验，插件的 /fold-* 绕过了那一层。
// - Host 必须是回环地址：防 DNS rebinding（attacker.com 解析到 127.0.0.1 时 Host 仍是 attacker.com）。
// - Origin 存在时必须与 Host 完全一致：防跨站 fetch 读取历史与重要消息。
// - POST 必须是 application/json：跨站简单请求带不了这个类型（需要预检），从而挡掉 no-cors 的 CSRF。
function loopbackHost(host) {
  const value = String(host || '').trim().toLowerCase()
  if (!value) return true
  const bare = value.startsWith('[')
    ? value.slice(1, value.indexOf(']'))
    : value.replace(/:\d+$/, '')
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare.endsWith('.localhost')
}

function requestAllowed(req) {
  const headers = (req && req.headers) || {}
  const host = String(headers.host || '')
  if (!loopbackHost(host)) return false
  const origin = String(headers.origin || '')
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (!loopbackHost(parsed.host)) return false
      if (parsed.host !== host) return false
    } catch {
      return false
    }
  }
  if (String((req && req.method) || 'GET').toUpperCase() === 'POST') {
    const type = String(headers['content-type'] || '').toLowerCase()
    if (!type.startsWith('application/json')) return false
  }
  return true
}

function guard(handler) {
  return function guarded(req, res) {
    if (!requestAllowed(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'forbidden：/fold-* 只允许本机同源访问' }))
      return
    }
    return handler(req, res)
  }
}

// webServer 是可选依赖：没有它（无 GUI 的宿主）时静默跳过，折叠照旧。
export function registerStatsRoute({
  ctx,
  log,
  makeStore,
  getConfig,
  resolveSessionById,
  getActualUsage,
  getSurfacePins,
  updateConfig,
  configFile,
}) {
  const disposers = []
  const routes = [
    { path: statsPath, handler: createStatsHandler({ makeStore, getConfig, log, getSurfacePins, resolveSessionById }) },
    { path: reportPath, handler: createReportHandler({ resolveSessionById, makeStore, getConfig, log }) },
    { path: viewPath, handler: createViewHandler({ resolveSessionById, makeStore, getConfig, log, getActualUsage }) },
    { path: compositionPath, handler: createCompositionHandler({ resolveSessionById, makeStore, getConfig, log, getActualUsage }) },
    { path: configPath, handler: createConfigHandler({ getConfig, updateConfig, configFile, log }) },
  ].map((route) => ({ ...route, handler: guard(route.handler) }))

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
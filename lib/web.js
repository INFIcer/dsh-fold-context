// 顶栏统计页的数据源：GET /fold-stats?session=<id>。
//
// 为什么走宿主 HTTP 路由：客户端 bundle 拿不到宿主对象，最稳的数据通道是同源 fetch。
// git-graph 插件就是这么做的（ctx.webServer.register + 客户端 fetch）。
// 路由失败绝不能影响折叠本身：所有错误都降级成日志。

import { buildStats } from './stats.js'
import { buildComposition } from './composition.js'
import { buildCost, normalizeLatest } from './cost.js'
import { buildReportModel, collectRecords } from './inspect.js'
import { resolvePins } from './pins.js'
import {
  configFields,
  defaultConfig,
  mergeConfigFile,
  normalizeConfig,
  validateConfigPatch,
} from './config.js'

export const statsPath = '/fold-stats'
export const viewPath = '/fold-view'
export const turnPath = '/fold-turn'
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
      // 给账本一份「模型此刻看得见哪些 pin」（连正文）：载荷记录只证明发布过，两边会漂移。
      // 没有 pin 的会话不必派生消息（stats 已是 5 秒一次的轮询）；拿不到活会话时给 null，
      // 账本退回「按记录算、present 未知」的旧口径，不把读不到当成不存在。
      const presentPins = Array.isArray(records) && records.some((record) => record && record.kind === 'pin')
        ? surfacePinsOf(getSurfacePins, sessionId)
        : null
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

// 模型此刻看得见哪些 pin：路由拿得到就拿，拿不到（会话不在进程里）返回 null，
// 让 resolvePins 退回「按载荷记录算、present 未知」的旧口径。
function surfacePinsOf(getSurfacePins, sessionId) {
  try {
    return typeof getSurfacePins === 'function' ? getSurfacePins(sessionId) : null
  } catch {
    return null
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
export function createCompositionHandler({ resolveSessionById, makeStore, getConfig, log, getActualUsage, getSurfacePins }) {
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
      // 成本里的「重要消息首次上行」同样只算模型看得见的那几条：载荷记录与历史会漂移，
      // 与账本走同一个 resolvePins，两处口径才不会一个多算一个少算。
      const pins = resolvePins(records.pins, surfacePinsOf(getSurfacePins, sessionId))
      if (!derivedMessages.length) {
        sendJson(
          res,
          200,
          {
            ok: true,
            sessionId,
            generatedAt: Date.now(),
            composition: buildComposition({ groups: [] }),
            cost: buildCost({ groups: [], folds: records.folds, recalls: records.recalls, pins, config, actual }),
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
          cost: buildCost({ groups, folds: records.folds, recalls: records.recalls, pins, config, actual }),
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

function queryOf(req, fallback) {
  const rawUrl = (req && (req.url || req.originalUrl)) || fallback
  try {
    return new URL(rawUrl, 'http://localhost').searchParams
  } catch {
    return null
  }
}

function sessionParamOf(req, fallback) {
  const params = queryOf(req, fallback)
  return params ? String(params.get('session') || '').trim() : ''
}

// 分组序号只接受非负整数；缺失或非法一律 -1，由路由统一回 400。
function ordinalParamOf(req) {
  const params = queryOf(req, turnPath)
  const raw = params ? params.get('ordinal') : null
  // Number(null) 是 0，必须先把「没传」和「传了空串」挡掉，否则缺参数会被当成第 0 组。
  if (raw === null || String(raw).trim() === '') return -1
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : -1
}

function methodOf(req) {
  return String((req && req.method) || 'GET').toUpperCase()
}

// 模型视角的 JSON：直接来自 session.deriveMessages()，不经过任何摘要或截断。
// 客户端按「轮」渲染，所以这里只投影 turnGroups，省掉报告模型里用不上的部分。
// 轮内正文（entry.blocks 与折叠原文）不随首包下发：一轮可能有上百条消息、几十万字的原文，
// 长会话首包会到几十 MB，浏览器的解析与常驻内存都扛不住。展开某一轮时再走 /fold-turn。
export function buildViewPayload(model, options = {}) {
  const folded = (model && model.folded && model.folded.totals) || {}
  const totals = model && model.totals ? model.totals : {}
  const groups = Array.isArray(model && model.turnGroups) ? model.turnGroups : []
  return {
    ok: true,
    version: 5,
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
    // 页面级召回合计：轮次标签是分组内的和，这里再往上汇总一层。
    recallTotals: recallTotalsOf(groups),
    // provider 回报的最近一次请求：与上面的估算不是一回事（估算量的是会话历史，
    // 实际请求可能还被请求期压缩器改写），两个数并排显示才能看出差在哪。
    actual: normalizeLatest(options.actual),
    warns: Array.isArray(model && model.warns) ? model.warns : [],
    config: pickViewConfig(model && model.config),
  }
}

// 召回合计只从分组字段累加，不再扫一遍正文：首包不带条目，页面却要看到总数。
// 被召回的段数按检查点去重，次数按召回流水累加（同一段被取回两次记两次）。
function recallTotalsOf(groups) {
  let calls = 0
  let searches = 0
  let recalled = 0
  let folds = 0
  let parts = 0
  let searched = 0
  let searchedFolds = 0
  for (const group of Array.isArray(groups) ? groups : []) {
    calls += typeof group.recallCallCount === 'number' ? group.recallCallCount : 0
    searches += typeof group.recallSearchCount === 'number' ? group.recallSearchCount : 0
    recalled += typeof group.recalledCount === 'number' ? group.recalledCount : 0
    parts += typeof group.recalledPartCount === 'number' ? group.recalledPartCount : 0
    searched += typeof group.searchedPartCount === 'number' ? group.searchedPartCount : 0
    const entries = Array.isArray(group.entries) ? group.entries : []
    for (const entry of entries) {
      if (!entry || entry.isCheckpoint !== true) continue
      if (typeof entry.recalledCount === 'number' && entry.recalledCount > 0) folds += 1
      // 被检索的折叠数：按检查点去重，与「被召回的折叠」并排计数。
      if (typeof entry.searchedCount === 'number' && entry.searchedCount > 0) searchedFolds += 1
    }
  }
  // parts / searched 是段级标记的合计（一段被取回两次记两次），父级标签与页面合计都只做加法。
  return { calls, searches, recalled, folds, parts, searched, searchedFolds }
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
        level: entry.pinLevel === 'recent' ? 'recent' : 'permanent',
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
    minFoldRatio: typeof source.minFoldRatio === 'number' ? source.minFoldRatio : 0.5,
    // 段号规则与召回目录共用这两个值：页面切出来的段号必须和 fold_recall 数的一致。
    maxRecallTokens: typeof source.maxRecallTokens === 'number' ? source.maxRecallTokens : 1000,
    recallIndexPreviewTokens: typeof source.recallIndexPreviewTokens === 'number' ? source.recallIndexPreviewTokens : 25,
  }
}

// 轮卡片的 pin 标签带级别（近期重要 / 长期重要），页面据此分色；
// 旧状态里的纯字符串统一按长期重要下发，两种形态客户端都认。
function stripPinLabels(labels) {
  return (Array.isArray(labels) ? labels : []).map((item) => {
    if (typeof item === 'string') return { label: item, level: 'permanent' }
    const source = item && typeof item === 'object' ? item : {}
    return {
      label: typeof source.label === 'string' ? source.label : '',
      level: source.level === 'recent' ? 'recent' : 'permanent',
    }
  })
}

function stripGroup(group) {
  const source = group && typeof group === 'object' ? group : {}
  const kind = source.kind || 'turn'
  const entries = Array.isArray(source.entries) ? source.entries : []
  // 轮内条目走 /fold-turn：只有系统提示词要随首屏下发（第 1 版看全文，之后看差异）。
  // 重要消息要常显在轮卡片之外、体积又小，跟着分组一起走。
  return {
    kind,
    turn: typeof source.turn === 'number' ? source.turn : null,
    ordinal: typeof source.ordinal === 'number' ? source.ordinal : 0,
    continuation: source.continuation === true,
    folded: source.folded === true,
    prePlugin: source.prePlugin === true,
    saveRate: typeof source.saveRate === 'number' ? source.saveRate : 0,
    steps: typeof source.steps === 'number' ? source.steps : 0,
    chars: typeof source.chars === 'number' ? source.chars : 0,
    unfoldedChars: typeof source.unfoldedChars === 'number' ? source.unfoldedChars : 0,
    foldIds: Array.isArray(source.foldIds) ? source.foldIds : [],
    pinLabels: stripPinLabels(source.pinLabels),
    userText: typeof source.userText === 'string' ? source.userText : '',
    replyText: typeof source.replyText === 'string' ? source.replyText : '',
    replyNote: typeof source.replyNote === 'string' ? source.replyNote : '',
    version: typeof source.version === 'number' ? source.version : null,
    diff: stripDiff(source.diff),
    diffOf: typeof source.diffOf === 'number' ? source.diffOf : 0,
    // 召回合计随分组头一起走：首包没有条目，轮次标签仍要显示这一轮的总和。
    recallCallCount: typeof source.recallCallCount === 'number' ? source.recallCallCount : 0,
    recallSearchCount: typeof source.recallSearchCount === 'number' ? source.recallSearchCount : 0,
    recalledCount: typeof source.recalledCount === 'number' ? source.recalledCount : 0,
    recalledPartCount: typeof source.recalledPartCount === 'number' ? source.recalledPartCount : 0,
    // 这一轮里「被检索」的合计：轮卡片标签用，与段级/目录级标记相加对得上。
    searchedCount: typeof source.searchedCount === 'number' ? source.searchedCount : 0,
    searchedPartCount: typeof source.searchedPartCount === 'number' ? source.searchedPartCount : 0,
    pins: entries.filter((entry) => entry && entry.isPin === true).map(stripEntry),
    entries: kind === 'system' ? entries.map(stripEntry) : [],
  }
}

// 召回调用只送渲染需要的字段；参数正文留在服务端，展开条目时看工具调用块即可。
// segments 优先来自工具结果（模型实际取回的段），没有结果时才退回参数解析——两者都用召回
// 目录的段号。foldLoc 是这条折叠检查点在页面上的位置，用于从调用跳到被召回的段。
function stripRecallCall(call) {
  const source = call && typeof call === 'object' ? call : {}
  const segments = Array.isArray(source.segments)
    ? source.segments.filter((no) => Number.isInteger(no) && no > 0).slice(0, 60)
    : []
  const segmentCount = typeof source.segmentCount === 'number' && source.segmentCount > 0 ? Math.floor(source.segmentCount) : 0
  const outcome = typeof source.outcome === 'string' ? source.outcome : ''
  const note = typeof source.note === 'string' ? source.note.slice(0, 200) : ''
  const foldLoc = source.foldLoc && typeof source.foldLoc.o === 'number' && typeof source.foldLoc.i === 'number'
    ? { o: source.foldLoc.o, i: source.foldLoc.i }
    : null
  const totalParts = typeof source.totalParts === 'number' && source.totalParts > 0 ? Math.floor(source.totalParts) : 0
  // partNo 是这次调用在它所在折叠原文里的段号：页面据此把「谁召回了这一段」跳到调用所在的那一段。
  const partNo = typeof source.partNo === 'number' && source.partNo > 0 ? Math.floor(source.partNo) : 0
  // 检索命中的折叠：每条带命中段数与列出的段号，loc 是那条折叠检查点的落点。
  // 引用面板靠它把「检索」也指到分段目录与具体那几段上，而不是一句「没有落到具体的段上」。
  const searchHits = Array.isArray(source.searchHits)
    ? source.searchHits.slice(0, 10).map((hit) => {
        const row = hit && typeof hit === 'object' ? hit : {}
        const numbers = Array.isArray(row.numbers) ? row.numbers.filter((no) => Number.isInteger(no) && no > 0).slice(0, 24) : []
        const loc = row.loc && typeof row.loc.o === 'number' && typeof row.loc.i === 'number' ? { o: row.loc.o, i: row.loc.i } : null
        return {
          id: typeof row.id === 'string' ? row.id : '',
          turn: typeof row.turn === 'number' ? row.turn : 0,
          count: typeof row.count === 'number' ? row.count : 0,
          totalParts: typeof row.totalParts === 'number' ? row.totalParts : 0,
          ...(numbers.length > 0 ? { numbers } : {}),
          ...(typeof row.unlisted === 'number' && row.unlisted > 0 ? { unlisted: row.unlisted } : {}),
          ...(loc ? { loc } : {}),
        }
      }).filter((hit) => hit.id)
    : []
  const searchPartCount = typeof source.searchPartCount === 'number' && source.searchPartCount > 0 ? Math.floor(source.searchPartCount) : 0
  const searchFoldCount = typeof source.searchFoldCount === 'number' && source.searchFoldCount > 0 ? Math.floor(source.searchFoldCount) : 0
  const searchMoreFolds = typeof source.searchMoreFolds === 'number' && source.searchMoreFolds > 0 ? Math.floor(source.searchMoreFolds) : 0
  return {
    id: typeof source.id === 'string' ? source.id : '',
    query: typeof source.query === 'string' ? source.query : '',
    parts: typeof source.parts === 'string' ? source.parts : '',
    via: typeof source.via === 'string' ? source.via : '',
    // 解析不出段号时不带这两个字段：老数据与整段召回保持原来的载荷大小。
    ...(segments.length > 0 ? { segments } : {}),
    ...(segmentCount > 0 ? { segmentCount } : {}),
    ...(outcome ? { outcome } : {}),
    ...(note ? { note } : {}),
    ...(foldLoc ? { foldLoc } : {}),
    ...(totalParts > 0 ? { totalParts } : {}),
    ...(partNo > 0 ? { partNo } : {}),
    ...(searchHits.length > 0 ? { searchHits } : {}),
    ...(searchPartCount > 0 ? { searchPartCount } : {}),
    ...(searchFoldCount > 0 ? { searchFoldCount } : {}),
    ...(searchMoreFolds > 0 ? { searchMoreFolds } : {}),
  }
}

// 段号 -> 调用落点的小表：只认正整数键与 {o,i} 都是数字的项，页面跳转才不会指到不存在的条目。
function refTableOf(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source) return null
  const out = {}
  let keys = 0
  for (const key of Object.keys(source)) {
    const no = Number(key)
    if (!Number.isInteger(no) || no <= 0) continue
    const list = Array.isArray(source[key]) ? source[key] : []
    const refs = []
    for (const ref of list) {
      if (!ref || typeof ref !== 'object') continue
      if (typeof ref.o !== 'number' || typeof ref.i !== 'number') continue
      // part 是调用在它所在折叠原文里的段号：跳转要落到那一段，不能只落到检查点。
      const part = typeof ref.part === 'number' && ref.part > 0 ? Math.floor(ref.part) : 0
      refs.push({
        o: ref.o,
        i: ref.i,
        t: typeof ref.t === 'number' ? ref.t : ref.o,
        id: typeof ref.id === 'string' ? ref.id : '',
        ...(part > 0 ? { part } : {}),
      })
      if (refs.length >= 20) break
    }
    if (refs.length === 0) continue
    out[no] = refs
    keys += 1
    if (keys >= 200) break
  }
  return keys > 0 ? out : null
}

// 检索引用表：段号 -> 哪几次关键词检索命中了这一段（只带落点与关键词）。
// 与 partRefs 分开：检索没有返回原文，混进「被召回」的段次会让取回量虚高。
function searchRefTableOf(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source) return null
  const out = {}
  let keys = 0
  for (const key of Object.keys(source)) {
    const no = Number(key)
    if (!Number.isInteger(no) || no <= 0) continue
    const list = Array.isArray(source[key]) ? source[key] : []
    const refs = []
    for (const ref of list) {
      if (!ref || typeof ref !== 'object') continue
      if (typeof ref.o !== 'number' || typeof ref.i !== 'number') continue
      refs.push({
        o: ref.o,
        i: ref.i,
        t: typeof ref.t === 'number' ? ref.t : ref.o,
        query: typeof ref.query === 'string' ? ref.query.slice(0, 60) : '',
        // part 是调用在它所在折叠原文里的段号：反查要落到那一段，不能只落到检查点。
        ...(typeof ref.part === 'number' && ref.part > 0 ? { part: Math.floor(ref.part) } : {}),
      })
      if (refs.length >= 8) break
    }
    if (refs.length === 0) continue
    out[no] = refs
    keys += 1
    if (keys >= 120) break
  }
  return keys > 0 ? out : null
}

// 折叠级检索引用：哪次检索用到了这张分段目录、命中多少段。
function searchRefsOf(value) {
  const list = Array.isArray(value) ? value : []
  const out = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.o !== 'number' || typeof row.i !== 'number') continue
    const numbers = Array.isArray(row.numbers) ? row.numbers.filter((no) => Number.isInteger(no) && no > 0).slice(0, 8) : []
    out.push({
      o: row.o,
      i: row.i,
      t: typeof row.t === 'number' ? row.t : row.o,
      query: typeof row.query === 'string' ? row.query.slice(0, 60) : '',
      count: typeof row.count === 'number' ? row.count : 0,
      totalParts: typeof row.totalParts === 'number' ? row.totalParts : 0,
      ...(numbers.length > 0 ? { numbers } : {}),
      ...(typeof row.part === 'number' && row.part > 0 ? { part: Math.floor(row.part) } : {}),
    })
    if (out.length >= 20) break
  }
  return out.length > 0 ? out : null
}

// 段号 -> 次数的小表：只认正整数键与正次数，坏值直接丢掉，别让页面对不上。
function countTableOf(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source) return null
  const out = {}
  let any = false
  for (const key of Object.keys(source)) {
    const no = Number(key)
    const times = typeof source[key] === 'number' && Number.isFinite(source[key]) ? Math.floor(source[key]) : 0
    if (!Number.isInteger(no) || no <= 0 || times <= 0) continue
    out[no] = times
    any = true
  }
  return any ? out : null
}

function stripEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {}
  const record = source.foldRecord && typeof source.foldRecord === 'object' ? source.foldRecord : null
  const recalledParts = countTableOf(source.recalledParts)
  const partRefs = refTableOf(source.partRefs)
  const searchedParts = searchRefTableOf(source.searchedParts)
  const searchedRefs = searchRefsOf(source.searchedRefs)
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
    // 只透出两个已知级别：页面据 recent 分蓝，其它值一律按长期重要。
    pinLevel: source.pinLevel === 'recent' ? 'recent' : source.pinLevel === 'permanent' ? 'permanent' : '',
    chars: typeof source.chars === 'number' ? source.chars : 0,
    blocks: Array.isArray(source.blocks) ? source.blocks : [],
    // 条目级召回标记：直接调用与折叠原文里的调用分开计数，被召回次数只对检查点有意义。
    recallCalls: Array.isArray(source.recallCalls) ? source.recallCalls.map(stripRecallCall) : [],
    foldedRecallCount: typeof source.foldedRecallCount === 'number' ? source.foldedRecallCount : 0,
    foldedSearchCount: typeof source.foldedSearchCount === 'number' ? source.foldedSearchCount : 0,
    recalledCount: typeof source.recalledCount === 'number' ? source.recalledCount : 0,
    // 段级标记：段号 -> 被取回次数。没有标记时不带这个字段，长原文的载荷不会被空表撑大。
    ...(recalledParts ? { recalledParts } : {}),
    recalledPartCount: typeof source.recalledPartCount === 'number' ? source.recalledPartCount : 0,
    // 段级引用：段号 -> 取回过它的调用落点。没有引用时不带这个字段，长原文的载荷不会被空表撑大。
    ...(partRefs ? { partRefs } : {}),
    // 被检索：段级表 + 目录级列表。两者都没有时不带字段，长原文的载荷不会被空表撑大。
    ...(searchedParts ? { searchedParts } : {}),
    ...(searchedRefs ? { searchedRefs } : {}),
    ...(typeof source.searchedCount === 'number' && source.searchedCount > 0 ? { searchedCount: Math.floor(source.searchedCount) } : {}),
    ...(typeof source.searchedPartCount === 'number' && source.searchedPartCount > 0 ? { searchedPartCount: Math.floor(source.searchedPartCount) } : {}),
    foldRecord: record
      ? {
          id: record.id || '',
          turn: typeof record.turn === 'number' ? record.turn : null,
          chars: typeof record.chars === 'number' ? record.chars : 0,
          // 检查点里回复是否被截断：客户端按同一规则切段，段号才与召回对得上。
          replyTruncated: record.replyTruncated !== false,
          items: Array.isArray(record.items)
            ? record.items.map((item) => {
                const calls = item && Array.isArray(item.recallCalls) ? item.recallCalls : []
                // 每次调用出自第几个块：页面按块切段后，标记只落在调用段上。
                const owners = item && Array.isArray(item.recallCallBlocks)
                  ? item.recallCallBlocks.filter((no) => Number.isInteger(no) && no >= 0).slice(0, 200)
                  : []
                return {
                  seq: item && item.seq !== undefined ? item.seq : null,
                  chars: item && typeof item.chars === 'number' ? item.chars : 0,
                  blocks: item && Array.isArray(item.blocks) ? item.blocks : [],
                  // 段里没有召回就不带这个字段，长原文的载荷不会被空数组撑大。
                  ...(calls.length > 0 ? { recallCalls: calls.map(stripRecallCall) } : {}),
                  // 块归属只在与调用一一对上时才下发，页面按它把标记挂到具体段。
                  ...(calls.length > 0 && owners.length === calls.length ? { recallCallBlocks: owners } : {}),
                }
              })
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
            version: 5,
            sessionId,
            empty: true,
            groups: [],
            pins: [],
            recallTotals: { calls: 0, searches: 0, recalled: 0, folds: 0, parts: 0, searched: 0, searchedFolds: 0 },
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

// GET /fold-turn?session=<id>&ordinal=<分组序号>：展开某一轮时才拉这一轮的条目正文。
// 首包只带分组头与重要消息，长会话的模型视角因此从几十 MB 降到几百 KB。
// 两个接口用同一份 buildReportModel，组号（ordinal，从 1 起、唯一）对得上。
export function createTurnHandler({ resolveSessionById, makeStore, getConfig, log }) {
  return function turnHandler(req, res) {
    try {
      const method = methodOf(req)
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' }, method === 'HEAD')
        return
      }
      let sessionId = sessionParamOf(req, turnPath)
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: '缺少 session 参数：/fold-turn?session=<会话 id>&ordinal=<分组序号>' }, method === 'HEAD')
        return
      }
      const ordinal = ordinalParamOf(req)
      if (ordinal < 0) {
        sendJson(res, 400, { ok: false, error: '缺少 ordinal 参数：/fold-turn?session=<会话 id>&ordinal=<分组序号>' }, method === 'HEAD')
        return
      }
      const found = findSession(resolveSessionById, sessionId)
      if (!found) {
        sendJson(res, 404, { ok: false, error: sessionNotFoundText(sessionId) }, method === 'HEAD')
        return
      }
      sessionId = found.id
      const { derivedMessages, records } = viewInputsOf({ sessionId, session: found.session, makeStore, log })
      if (!derivedMessages.length) {
        sendJson(res, 200, { ok: true, sessionId, ordinal, generatedAt: Date.now(), entries: [] }, method === 'HEAD')
        return
      }
      const model = buildReportModel({
        sessionId,
        derivedMessages,
        folds: records.folds,
        pins: records.pins,
        recalls: records.recalls,
        config: typeof getConfig === 'function' ? getConfig() : null,
      })
      const groups = Array.isArray(model.turnGroups) ? model.turnGroups : []
      // ordinal 是分组在报告模型里的编号（从 1 起、唯一），客户端直接回传它。
      const group = groups.find((item) => item && item.ordinal === ordinal)
      if (!group) {
        // 页面打开后历史变过（新消息、折叠落地）时序号会失效：让前端提示刷新，而不是回空正文。
        sendJson(res, 404, { ok: false, error: '这一轮不在当前历史里：页面打开后历史变过，刷新模型视角后重试。' }, method === 'HEAD')
        return
      }
      // 重要消息已经在首包里、由卡片外单独渲染，这里不重复下发。
      const entries = (Array.isArray(group.entries) ? group.entries : []).filter((entry) => !entry || entry.isPin !== true)
      sendJson(
        res,
        200,
        { ok: true, sessionId, ordinal, generatedAt: model.generatedAt || Date.now(), entries: entries.map(stripEntry) },
        method === 'HEAD',
      )
    } catch (error) {
      log && log.warn('轮次正文路由失败：' + messageOf(error))
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
    { path: viewPath, handler: createViewHandler({ resolveSessionById, makeStore, getConfig, log, getActualUsage }) },
    { path: turnPath, handler: createTurnHandler({ resolveSessionById, makeStore, getConfig, log }) },
    { path: compositionPath, handler: createCompositionHandler({ resolveSessionById, makeStore, getConfig, log, getActualUsage, getSurfacePins }) },
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
// 实时账本：只读 fold-store 的记录，算出「折叠赚了多少、召回与重要消息亏了多少」。
//
// 为什么不复用 inspect.js：那份报告要 session.deriveMessages() 才能算真实模型视角，
// 而顶栏是轮询的 HTTP 路由，手里只有 store。这里改成逐条记录的估算：
// 折叠收益 = 原文块 token - 摘要块 token；召回成本 = 当时返回的正文 token；
// 重要消息成本 = 它一直占着的 token。口径与宿主 token-meter 相同（见 tokens.js）。
//
// 金额的口径（这里踩过坑，改之前先读完）：
// 1. 上下文里的内容每发一次请求就要重发一次。折叠删掉的原文块早就在更早的请求里
//    付过首次上行的钱，折叠省下的是**之后每一次重发**，而重发的是旧历史，按缓存命中价
//    （默认 0.02）计，不是未命中价（默认 1）。
// 2. 召回正文、检查点、重要消息是**新内容**：第一次上行按未命中价付一次，之后重发按
//    命中价付。召回正文通常在轮末就被再次折掉，所以只算它那一次（外加轮内剩余半步）。
// 3. 重发次数 = 之后还有多少步请求。步数取自 fold 记录里的 provider 回报 usage.steps；
//    没有回报的轮次按已知轮次的平均步数补，并在 pricing.steps 里标出来。
// 早期版本把这两种方向相反的量压成一个「命中率加权均价」（0.02×0.97+1×0.03）再乘
// token，结果折叠收益被高估 2.5 倍、召回被低估 20 倍，还漏乘了「之后会被重发多少次」，
// 净额的正负都可能算反。金额只作折算参考，收益与成本的主口径仍是 token。

import { CHARS_PER_TOKEN, BLOCK_OVERHEAD, estimateChars, estimateTokens } from './tokens.js'
import { pinPrefix } from './constants.js'
import { TOKENS_PER_PRICE_UNIT, defaultHitRate, pricesOf, roundMoney } from './pricing.js'
import { normalizeUsage } from './usage.js'

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

// token 数 × 单价 → 元，不取整：逐条金额最后统一 roundMoney，避免中间四舍五入累积误差。
function costOf(tokens, price) {
  return (num(tokens) * num(price)) / TOKENS_PER_PRICE_UNIT
}

// 一条折叠的收益：items 是召回载荷，也就是被替换掉的原文；note 是留在历史里的摘要。
export function foldCost(record) {
  const items = Array.isArray(record.items) ? record.items : []
  const originalChars = num(record.chars, items.reduce((sum, item) => sum + textOf(item && item.text).length, 0))
  const originalTokens = items.length > 0
    ? estimateTokens(items.map((item) => textOf(item && item.text)))
    : estimateChars(originalChars)
  const note = textOf(record.note)
  const noteTokens = estimateTokens([note])
  return {
    originalChars,
    originalTokens,
    noteChars: note.length,
    noteTokens,
    savedChars: Math.max(0, originalChars - note.length),
    savedTokens: Math.max(0, originalTokens - noteTokens),
    estimated: items.length === 0,
  }
}

function foldRow(record) {
  const cost = foldCost(record)
  return {
    id: String(record.id || ''),
    turn: num(record.turn, 0),
    at: num(record.at, 0),
    note: textOf(record.note),
    ...cost,
    recallCount: 0,
    recallChars: 0,
    recallTokens: 0,
    probeCount: 0,
    requests: 0,
    savedMoney: 0,
    checkpointMoney: 0,
    moneyEstimated: false,
  }
}

// 目录与关键词检索只返回编号与段号，不返回原文；它们花 token 但不是「内容召回」，
// 所以成本照算、召回次数不算（和 store.recallCount 的口径一致）。
function isProbeMode(mode) {
  return mode === 'index' || mode === 'search'
}

function recallRow(record, foldMap) {
  const foldId = String(record.id || '')
  const fold = foldMap.get(foldId)
  const foldTurn = fold ? num(fold.turn, 0) : 0
  const explicitTurn = num(record.turn, 0)
  // 旧记录没有 turn：把它算到被召回那段折叠所在的轮，并标记 estimated。
  const turn = explicitTurn || foldTurn
  const storedChars = num(record.chars, 0)
  const storedTokens = num(record.tokens, 0)
  const chars = storedChars || (fold ? num(fold.chars, 0) : 0)
  const tokens = storedTokens || estimateChars(chars)
  const mode = textOf(record.mode)
  return {
    foldId,
    foldTurn,
    turn,
    at: num(record.at, 0),
    chars,
    tokens,
    mode,
    probe: isProbeMode(mode),
    requests: 0,
    money: 0,
    estimated: !explicitTurn || (!storedChars && !storedTokens),
  }
}

function pinRow(record) {
  const label = textOf(record.id) || '重要结论'
  const text = textOf(record.text)
  const turn = num(record.turn, 0)
  const full = pinPrefix + ' ' + label + '\n' + text
  return {
    id: label,
    turn,
    at: num(record.at, 0),
    // 字数和 token 用同一个字符串算，否则 totals.pinChars 与 pinTokens 不是同一件事。
    chars: full.length,
    tokens: estimateTokens([full]),
    requests: 0,
    pinMoney: 0,
    estimated: !turn,
    text,
  }
}

function byTurnThenTime(a, b) {
  if (a.turn !== b.turn) return a.turn - b.turn
  return a.at - b.at
}

// 每一轮真实的请求步数：fold 记录写的是 provider 回报，同一轮折成多段时每段都写同一份，
// 所以按轮取最大值，而不是相加。
function stepModelOf(foldMap) {
  const known = new Map()
  for (const record of foldMap.values()) {
    const turn = num(record.turn, 0)
    if (turn <= 0) continue
    const usage = normalizeUsage(record.usage)
    if (!usage || usage.steps <= 0) continue
    const steps = Math.max(1, usage.steps)
    if (!known.has(turn) || known.get(turn) < steps) known.set(turn, steps)
  }
  const values = [...known.values()]
  const average = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 1
  return { known, average }
}

function stepAt(model, turn) {
  return model.known.get(turn) || model.average
}

// 时间线：steps[t] 是第 t 轮的步数，after[t] 是第 t 轮之后还会发生的请求数。
// 一段内容在第 t 轮写入历史后会被重发 after[t] 次（轮内剩余的那半步单独加）。
function stepsTimeline(model, lastTurn) {
  const steps = [0]
  for (let t = 1; t <= lastTurn; t += 1) steps.push(stepAt(model, t))
  const after = new Array(steps.length).fill(0)
  for (let t = steps.length - 2; t >= 0; t -= 1) after[t] = after[t + 1] + steps[t + 1]
  return { steps, after }
}

function laterInTurnOf(timeline, turn) {
  if (!(turn > 0) || turn >= timeline.steps.length) return 0
  return Math.max(0, (timeline.steps[turn] - 1) / 2)
}

function pickConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    enabled: source.enabled !== false,
    minFoldChars: num(source.minFoldChars, 1200),
    noteRatio: num(source.noteRatio, 0.1),
    maxNoteChars: num(source.maxNoteChars, 320),
    recallReminderAfter: num(source.recallReminderAfter, 3),
    maxRecallChars: num(source.maxRecallChars, 24000),
    maxPins: num(source.maxPins, 0),
    pinBudgetChars: num(source.pinBudgetChars, 0),
    cacheHitRate: num(source.cacheHitRate, defaultHitRate),
  }
}

// records 直接用 store.readAll() 的结果；config 只用于展示当前参数。
export function buildStats({ records, config, now } = {}) {
  const list = Array.isArray(records) ? records : []
  const foldMap = new Map()
  const pins = []
  const recalls = []
  for (const record of list) {
    if (!record || typeof record !== 'object') continue
    if (record.kind === 'fold' && typeof record.id === 'string') {
      foldMap.set(record.id, record)
    } else if (record.kind === 'pin') {
      pins.push(record)
    } else if (record.kind === 'recall') {
      recalls.push(record)
    }
  }

  const prices = pricesOf(config)
  const hitRate = num(config && config.cacheHitRate, defaultHitRate)
  const model = stepModelOf(foldMap)

  const rows = [...foldMap.values()].map(foldRow).sort(byTurnThenTime)
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const pinRows = pins.map(pinRow).sort(byTurnThenTime)
  const recallRows = recalls.map((record) => recallRow(record, foldMap)).sort(byTurnThenTime)

  let lastTurn = 0
  for (const row of rows) if (row.turn > lastTurn) lastTurn = row.turn
  for (const row of pinRows) if (row.turn > lastTurn) lastTurn = row.turn
  for (const row of recallRows) if (row.turn > lastTurn) lastTurn = row.turn
  for (const turn of model.known.keys()) if (turn > lastTurn) lastTurn = turn
  const timeline = stepsTimeline(model, lastTurn)
  const moneyEstimated = model.known.size === 0

  // 折叠：省下的是「之后每次重发」，摘要自己第一次上行按未命中价付一次。
  let savedRaw = 0
  let checkpointRaw = 0
  for (const row of rows) {
    row.requests = row.turn > 0 ? timeline.after[row.turn] : timeline.after[0]
    row.moneyEstimated = moneyEstimated || row.turn <= 0
    const saving = costOf(row.savedTokens * row.requests, prices.cacheHit)
    const checkpoint = row.requests > 0 ? costOf(row.noteTokens, prices.input) : 0
    row.savedMoney = roundMoney(saving)
    row.checkpointMoney = roundMoney(checkpoint)
    savedRaw += saving
    checkpointRaw += checkpoint
  }

  // 召回：返回的正文是新内容，首次上行按未命中价；轮内剩余步数按命中价重发。
  let recallRaw = 0
  let contentRecalls = 0
  let probeRecalls = 0
  for (const row of recallRows) {
    row.requests = laterInTurnOf(timeline, row.turn)
    const first = costOf(row.tokens, prices.input)
    const resend = costOf(row.tokens * row.requests, prices.cacheHit)
    row.money = roundMoney(first + resend)
    recallRaw += first + resend
    const target = rowById.get(row.foldId)
    if (row.probe) {
      probeRecalls += 1
      if (target) target.probeCount += 1
      continue
    }
    contentRecalls += 1
    if (target) {
      target.recallCount += 1
      target.recallChars += row.chars
      target.recallTokens += row.tokens
    }
  }

  // 重要消息：首次上行按未命中价，之后常驻，每一步请求都按命中价重发。
  let pinRaw = 0
  for (const row of pinRows) {
    row.requests = row.turn > 0
      ? timeline.after[row.turn] + laterInTurnOf(timeline, row.turn)
      : timeline.after[0]
    row.pinMoney = roundMoney(row.requests > 0
      ? costOf(row.tokens, prices.input) + costOf(row.tokens * row.requests, prices.cacheHit)
      : 0)
    pinRaw += row.requests > 0
      ? costOf(row.tokens, prices.input) + costOf(row.tokens * row.requests, prices.cacheHit)
      : 0
  }

  const turns = new Map()
  function bucket(turn) {
    const key = num(turn, 0)
    let row = turns.get(key)
    if (!row) {
      row = {
        turn: key,
        savedChars: 0,
        savedTokens: 0,
        recallChars: 0,
        recallTokens: 0,
        recallCount: 0,
        probeCount: 0,
        pinChars: 0,
        pinTokens: 0,
        pinCount: 0,
        foldCount: 0,
        foldIds: [],
        savedMoney: 0,
        checkpointMoney: 0,
        recallMoney: 0,
        pinMoney: 0,
        netChars: 0,
        netTokens: 0,
        netMoney: 0,
        cumulativeTokens: 0,
        cumulativeMoney: 0,
        estimated: false,
      }
      turns.set(key, row)
    }
    return row
  }
  for (const row of rows) {
    const target = bucket(row.turn)
    target.savedChars += row.savedChars
    target.savedTokens += row.savedTokens
    target.savedMoney = roundMoney(target.savedMoney + row.savedMoney)
    target.checkpointMoney = roundMoney(target.checkpointMoney + row.checkpointMoney)
    target.foldCount += 1
    target.foldIds.push(row.id)
    if (row.estimated || row.moneyEstimated) target.estimated = true
  }
  for (const row of recallRows) {
    const target = bucket(row.turn)
    target.recallChars += row.chars
    target.recallTokens += row.tokens
    target.recallMoney = roundMoney(target.recallMoney + row.money)
    if (row.probe) target.probeCount += 1
    else target.recallCount += 1
    if (row.estimated) target.estimated = true
  }
  for (const row of pinRows) {
    // 旧记录没写轮次：只计入总计，不硬塞进某一轮（否则图上会出现一个 T0）。
    if (row.estimated) continue
    const target = bucket(row.turn)
    target.pinChars += row.chars
    target.pinTokens += row.tokens
    target.pinMoney = roundMoney(target.pinMoney + row.pinMoney)
    target.pinCount += 1
  }

  const turnRows = [...turns.values()].sort((a, b) => a.turn - b.turn)
  // token 是「常驻体积」口径（省下的 - 取回的 - 固化的），金额另按各自的单价与重发次数算，
  // 两者不是同一个量纲，不能拿 netTokens 乘单价当金额。
  let cumulative = 0
  let cumulativeMoney = 0
  for (const row of turnRows) {
    row.netChars = row.savedChars - row.recallChars - row.pinChars
    row.netTokens = row.savedTokens - row.recallTokens - row.pinTokens
    row.netMoney = roundMoney(row.savedMoney - row.checkpointMoney - row.recallMoney - row.pinMoney)
    cumulative += row.netTokens
    cumulativeMoney = roundMoney(cumulativeMoney + row.netMoney)
    row.cumulativeTokens = cumulative
    row.cumulativeMoney = cumulativeMoney
  }

  const totals = {
    folds: rows.length,
    pins: pinRows.length,
    // 和 store.recallCount 一样只数「真的把原文读回来」的召回；目录/检索单列成 probes。
    recalls: contentRecalls,
    probes: probeRecalls,
    originalChars: rows.reduce((sum, row) => sum + row.originalChars, 0),
    noteChars: rows.reduce((sum, row) => sum + row.noteChars, 0),
    savedChars: rows.reduce((sum, row) => sum + row.savedChars, 0),
    savedTokens: rows.reduce((sum, row) => sum + row.savedTokens, 0),
    recallChars: recallRows.reduce((sum, row) => sum + row.chars, 0),
    recallTokens: recallRows.reduce((sum, row) => sum + row.tokens, 0),
    pinChars: pinRows.reduce((sum, row) => sum + row.chars, 0),
    pinTokens: pinRows.reduce((sum, row) => sum + row.tokens, 0),
    recalledFolds: rows.filter((row) => row.recallCount > 0).length,
    estimatedRecords: 0,
  }
  totals.netChars = totals.savedChars - totals.recallChars - totals.pinChars
  totals.netTokens = totals.savedTokens - totals.recallTokens - totals.pinTokens
  // 金额从原始值合计一次，不逐行取整再相加。
  totals.savedMoney = roundMoney(savedRaw)
  totals.checkpointMoney = roundMoney(checkpointRaw)
  totals.recallMoney = roundMoney(recallRaw)
  totals.pinMoney = roundMoney(pinRaw)
  totals.netMoney = roundMoney(totals.savedMoney - totals.checkpointMoney - totals.recallMoney - totals.pinMoney)
  totals.saveRate = totals.originalChars > 0 ? totals.savedChars / totals.originalChars : 0
  totals.estimatedRecords =
    rows.filter((row) => row.estimated).length +
    recallRows.filter((row) => row.estimated).length +
    pinRows.filter((row) => row.estimated).length

  const checkpointTokens = rows.reduce((sum, row) => sum + row.noteTokens, 0)
  // 当前常驻的摘要与重要消息：报体积，也报「再发一次请求要为它付多少」（命中价）。
  const current = {
    checkpointChars: totals.noteChars,
    checkpointTokens,
    checkpointMoney: roundMoney(costOf(checkpointTokens, prices.cacheHit)),
    pinChars: totals.pinChars,
    pinTokens: totals.pinTokens,
    pinMoney: roundMoney(costOf(totals.pinTokens, prices.cacheHit)),
    tokens: checkpointTokens + totals.pinTokens,
    money: 0,
  }
  current.money = roundMoney(current.checkpointMoney + current.pinMoney)

  return {
    ok: true,
    version: 2,
    generatedAt: num(now, Date.now()),
    estimate: { charsPerToken: CHARS_PER_TOKEN, blockOverhead: BLOCK_OVERHEAD },
    config: pickConfig(config),
    pricing: {
      prices,
      cacheHitRate: hitRate,
      // 金额依赖「之后还会重发多少次」；步数从 provider 回报反推，没有回报时按均值补。
      steps: {
        knownTurns: model.known.size,
        averageSteps: Math.round(model.average * 100) / 100,
        lastTurn,
        estimated: moneyEstimated,
      },
    },
    totals,
    current,
    turns: turnRows,
    rows,
    pins: pinRows,
    recalls: recallRows,
  }
}

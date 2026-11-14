// 实时账本：只读 fold-store 的记录，算出「折叠赚了多少、召回与重要消息亏了多少」。
//
// 为什么不复用 inspect.js：那份报告要 session.deriveMessages() 才能算真实模型视角，
// 而顶栏是轮询的 HTTP 路由，手里只有 store。这里改成逐条记录的估算：
// 折叠收益 = 原文块 token - 摘要块 token；召回成本 = 当时返回的正文 token；
// 重要消息成本 = 它一直占着的 token。口径与宿主 token-meter 相同（见 tokens.js）。

import { CHARS_PER_TOKEN, BLOCK_OVERHEAD, estimateChars, estimateTokens } from './tokens.js'
import { pinPrefix } from './constants.js'
import { blendedInputPrice, defaultHitRate, pricesOf, roundMoney, yuanOf } from './pricing.js'

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
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
  }
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
  return {
    foldId,
    foldTurn,
    turn,
    at: num(record.at, 0),
    chars,
    tokens,
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
    chars: text.length,
    tokens: estimateTokens([full]),
    estimated: !turn,
    text,
  }
}

function byTurnThenTime(a, b) {
  if (a.turn !== b.turn) return a.turn - b.turn
  return a.at - b.at
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
    maxPins: num(source.maxPins, 12),
    pinBudgetChars: num(source.pinBudgetChars, 12000),
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

  // 金额：账本里的量都是「常驻上下文」，按命中/未命中加权成输入均价结算。
  // 召回与重要消息也是上下文里的内容，用同一口径，才能和折叠收益直接相减。
  const prices = pricesOf(config)
  const hitRate = num(config && config.cacheHitRate, defaultHitRate)
  const blendedInput = blendedInputPrice(prices, hitRate)

  const rows = [...foldMap.values()].map(foldRow).sort(byTurnThenTime)
  for (const row of rows) row.savedMoney = yuanOf(row.savedTokens, blendedInput)
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const pinRows = pins.map(pinRow).sort(byTurnThenTime)
  for (const row of pinRows) row.pinMoney = yuanOf(row.tokens, blendedInput)
  const recallRows = recalls.map((record) => {
    const row = recallRow(record, foldMap)
    const target = rowById.get(row.foldId)
    if (target) {
      target.recallCount += 1
      target.recallChars += row.chars
      target.recallTokens += row.tokens
    }
    row.recallMoney = yuanOf(row.tokens, blendedInput)
    return row
  }).sort(byTurnThenTime)

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
        pinChars: 0,
        pinTokens: 0,
        pinCount: 0,
        foldCount: 0,
        foldIds: [],
        savedMoney: 0,
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
    target.savedMoney += row.savedMoney
    target.foldCount += 1
    target.foldIds.push(row.id)
    if (row.estimated) target.estimated = true
  }
  for (const row of recallRows) {
    const target = bucket(row.turn)
    target.recallChars += row.chars
    target.recallTokens += row.tokens
    target.recallMoney += row.recallMoney
    target.recallCount += 1
    if (row.estimated) target.estimated = true
  }
  for (const row of pinRows) {
    // 旧记录没写轮次：只计入总计，不硬塞进某一轮（否则图上会出现一个 T0）。
    if (row.estimated) continue
    const target = bucket(row.turn)
    target.pinChars += row.chars
    target.pinTokens += row.tokens
    target.pinMoney += row.pinMoney
    target.pinCount += 1
  }

  const turnRows = [...turns.values()].sort((a, b) => a.turn - b.turn)
  // 逐轮金额用逐轮 token 乘同一个均价算；累计单独滚，避免和总计对不上（取整差极小）。
  let cumulative = 0
  let cumulativeMoney = 0
  for (const row of turnRows) {
    row.netChars = row.savedChars - row.recallChars - row.pinChars
    row.netTokens = row.savedTokens - row.recallTokens - row.pinTokens
    row.netMoney = yuanOf(row.netTokens, blendedInput)
    cumulative += row.netTokens
    cumulativeMoney = roundMoney(cumulativeMoney + row.netMoney)
    row.cumulativeTokens = cumulative
    row.cumulativeMoney = cumulativeMoney
  }

  const totals = {
    folds: rows.length,
    pins: pinRows.length,
    recalls: recallRows.length,
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
  // 金额从总量算一次：和逐行相加相比，少了逐行取整的误差。
  totals.savedMoney = yuanOf(totals.savedTokens, blendedInput)
  totals.recallMoney = yuanOf(totals.recallTokens, blendedInput)
  totals.pinMoney = yuanOf(totals.pinTokens, blendedInput)
  totals.netMoney = roundMoney(totals.savedMoney - totals.recallMoney - totals.pinMoney)
  totals.saveRate = totals.originalChars > 0 ? totals.savedChars / totals.originalChars : 0
  totals.estimatedRecords =
    rows.filter((row) => row.estimated).length +
    recallRows.filter((row) => row.estimated).length +
    pinRows.filter((row) => row.estimated).length

  return {
    ok: true,
    version: 1,
    generatedAt: num(now, Date.now()),
    estimate: { charsPerToken: CHARS_PER_TOKEN, blockOverhead: BLOCK_OVERHEAD },
    config: pickConfig(config),
    pricing: { prices, cacheHitRate: hitRate, blendedInput },
    totals,
    current: {
      checkpointChars: totals.noteChars,
      checkpointTokens: rows.reduce((sum, row) => sum + row.noteTokens, 0),
      checkpointMoney: yuanOf(rows.reduce((sum, row) => sum + row.noteTokens, 0), blendedInput),
      pinChars: totals.pinChars,
      pinTokens: totals.pinTokens,
      pinMoney: yuanOf(totals.pinTokens, blendedInput),
      tokens: rows.reduce((sum, row) => sum + row.noteTokens, 0) + totals.pinTokens,
      money: roundMoney(
        yuanOf(rows.reduce((sum, row) => sum + row.noteTokens, 0), blendedInput) + yuanOf(totals.pinTokens, blendedInput),
      ),
    },
    turns: turnRows,
    rows,
    pins: pinRows,
    recalls: recallRows,
  }
}

// 折叠的成本模型：把「每轮都要把上下文重发一遍」这件事折算成 token 开销，
// 再拿折叠后的历史和不折叠的历史各算一遍，差值就是净节省。
//
// 关键点（也是和朴素估算不同的地方）：
// 1. 前缀缓存只认「上一次请求里出现过的内容」。折叠会在轮末重写历史，
//    所以上一轮的检查点到本轮第一次请求时是**新内容**（未命中），
//    不能算进命中前缀里。
// 2. 本轮自己的检查点在轮末才写入，所以本轮请求里没有它；从下一轮起它在每一步请求里
//    都在——首次上行算未命中，其余 steps-1 次按命中价重发（早先只算了首次，漏了重发）。
// 3. 一轮有 k 步，前缀被重发 k 次；轮内新增内容按平均半步处在上下文中（只影响展示的
//    重放总量，不参与命中率拆档，否则同一批 token 会被算两次未命中）。
// 4. 重发的前缀按真实命中率拆成两档：命中部分按缓存价、未命中部分按输入价。
//    早先的版本把「命中率」当成「缓存价的折扣当量」（0.25 之类），
//    结果 98% 的前缀按 0 元计，整份账单只有真账的三分之一。
//    命中率本身也要扣掉「每步新写进历史的内容」再算（resendHitRate）：那部分按定义
//    必定未命中，留在分母里会把纯重发的命中率系统性压低，进而把折叠成本算高。
// 5. 未命中不随上下文体积等比例放大。请求里真正没命中的是「上一次请求之后才写进历史的内容」：
//    每步的思考/回复/工具结果（实测约 2 千 token/步），外加缓存整段失效的事件
//    （系统提示改写等，代价是当时的上下文）。折叠与不折叠这两种视角，每步的新增内容一模一样，
//    差别只在轮边界：折叠发一条摘要，不折叠要重发上一轮最后的回复。
//    所以不折叠视角的未命中锚在折叠视角上，只补轮边界那点差；
//    早先的版本对两种视角都套「未命中率 × 重发量」，等于假定未命中与体积成正比，
//    于是把 6 倍体积算成 6 倍未命中，凭空多出三千万 token。
//
// 校准：请求期还可能被别的压缩引擎改写（本会话里 billion-context 会按自己的策略
// 收缩上下文），所以「surface 重放出来的 token 数」和 provider 真正计费的 token 数
// 并不相等。只要拿到过 provider 回报，就用实测总量反推两个系数（提示词、输出各一个），
// 再把系数套回所有轮次。系数是算出来的，不是调出来的；没有回报时等于 1（不校准）。
//
// 金额：命中、未命中、输出三档各有单价（pricing.js），token × 单价 / 1e6 就是元。
// 输出与折叠无关（同一句回复两种视角都要生成），两边都计入，做差时自然抵消。
//
// 纯函数：输入是 turns.js 的分组 + fold 记录 + 配置，输出是普通对象。

import { estimateChars } from './tokens.js'
import { normalizeUsage, promptTokensOf } from './usage.js'
import { defaultHitRate, moneyOf, pricesOf, roundMoney } from './pricing.js'

// DeepSeek 的前缀缓存命中率实测在 97% 上下；配置里的 cacheHitRate 只是没有回报时的兜底。
const DEFAULT_HIT_RATE = defaultHitRate
// 校准系数的安全区间：样本太少时系数可能离谱，越界就夹住，避免页面出现天文数字。
const PROMPT_SCALE_MIN = 0.02
const PROMPT_SCALE_MAX = 2
const OUTPUT_SCALE_MIN = 0.2
const OUTPUT_SCALE_MAX = 8

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function tokenOf(chars) {
  return estimateChars(Math.max(0, chars))
}

function foldMapOf(folds) {
  if (folds instanceof Map) return folds
  const map = new Map()
  const list = Array.isArray(folds) ? folds : []
  for (const record of list) {
    if (record && typeof record.id === 'string') map.set(record.id, record)
  }
  return map
}

// 同一轮可能被轮内发言切成多组（续接段），也可能是 f2a / f2b 两段折叠：
// 成本要按轮整体算，先把同号的组合并成一组，否则同一轮会被计两次。
function mergeTurns(list) {
  const out = []
  const index = new Map()
  for (const group of list) {
    if (!group || typeof group !== 'object') continue
    if (group.kind !== 'turn' || typeof group.turn !== 'number') {
      out.push(group)
      continue
    }
    const key = 't' + group.turn
    const seen = index.get(key)
    if (!seen) {
      const copy = Object.assign({}, group, {
        steps: num(group.steps),
        chars: num(group.chars),
        checkpointChars: num(group.checkpointChars),
        unfoldedChars: num(group.unfoldedChars),
        outputChars: num(group.outputChars),
      })
      index.set(key, copy)
      out.push(copy)
      continue
    }
    seen.steps += num(group.steps)
    seen.chars += num(group.chars)
    seen.checkpointChars += num(group.checkpointChars)
    seen.unfoldedChars += num(group.unfoldedChars)
    seen.outputChars += num(group.outputChars)
    if (group.folded === true) seen.folded = true
  }
  return out
}

// 唯一会真正上行的系统提示 = 最后一个非空 system 组；更早的版本只是历史副本。
function currentSystemOf(list) {
  let found = null
  for (const group of list) {
    if (!group || group.kind === 'turn') continue
    if (num(group.chars) > 0) found = group
  }
  return found
}

// 同一轮可能折成多段（f2a / f2b），用量只挂在其中任意一条上，按轮去重。
function usageByTurnOf(folds) {
  const map = new Map()
  for (const record of folds.values()) {
    const turn = record && typeof record.turn === 'number' ? record.turn : null
    if (turn === null || map.has(turn)) continue
    const usage = normalizeUsage(record && record.usage)
    if (usage) map.set(turn, usage)
  }
  return map
}

// provider 回报的三档 token：命中、未命中（含写缓存）、输出。
function partsOfUsage(usage) {
  if (!usage) return null
  return {
    hit: num(usage.cacheRead),
    input: num(usage.input) + num(usage.cacheWrite),
    output: num(usage.output),
  }
}

function hitRateOf(config) {
  return clampNumber(config && config.cacheHitRate, 0, 1, DEFAULT_HIT_RATE)
}

// 用实测总量反推校准系数：surface 重放出来的量 → provider 真正计费的量。
function calibrationOf(rows) {
  const covered = rows.filter((row) => row.actualPromptTokens > 0)
  if (covered.length === 0) {
    return { coveredTurns: 0, promptScale: 1, outputScale: 1, measuredHitRate: null }
  }
  const actualPrompt = covered.reduce((sum, row) => sum + row.actualPromptTokens, 0)
  // replayTokens 与结算时的口径一致：拆档的重发量 + 首次上行的新增内容。
  const replayPrompt = covered.reduce((sum, row) => sum + row.replayTokens, 0)
  const actualOutput = covered.reduce((sum, row) => sum + row.actualOutputTokens, 0)
  const replayOutput = covered.reduce((sum, row) => sum + row.outputTokens, 0)
  const hit = covered.reduce((sum, row) => sum + row.actualHitTokens, 0)
  const input = covered.reduce((sum, row) => sum + row.actualInputTokens, 0)
  return {
    coveredTurns: covered.length,
    promptScale: clampNumber(replayPrompt > 0 ? actualPrompt / replayPrompt : 1, PROMPT_SCALE_MIN, PROMPT_SCALE_MAX, 1),
    outputScale: clampNumber(replayOutput > 0 ? actualOutput / replayOutput : 1, OUTPUT_SCALE_MIN, OUTPUT_SCALE_MAX, 1),
    measuredHitRate: hit + input > 0 ? hit / (hit + input) : null,
  }
}

// 命中率必须从「重发量」里算：每步新写进历史的思考/回复/工具结果按定义必定未命中，
// 把它们留在分母里会把纯重发的命中率系统性压低（实测 98.3% 的那一轮，扣掉新增后接近 100%）。
// 用总量算而不是逐轮算，是为了避免单轮的字符估算误差把某一轮推到 0% 或 100%。
function resendHitRateOf(rows, scale, fallback) {
  let hit = 0
  let input = 0
  for (const row of rows) {
    if (!(row.actualPromptTokens > 0)) continue
    const fresh = Math.min(row.actualInputTokens, (row.addedTokens + row.freshTokens) * scale)
    hit += row.actualHitTokens
    input += Math.max(0, row.actualInputTokens - fresh)
  }
  if (hit + input <= 0) return fallback
  return Math.min(1, Math.max(0, hit / (hit + input)))
}

export function buildCost({ groups, folds, config, actual } = {}) {
  const list = mergeTurns(Array.isArray(groups) ? groups : [])
  const foldMap = foldMapOf(folds)
  const currentSystem = currentSystemOf(list)
  const usageByTurn = usageByTurnOf(foldMap)
  const prices = pricesOf(config)
  const rows = []
  let foldedCum = 0
  let unfoldedCum = 0
  // 插件生效前的那一轮没人折得动（当时还没有载荷），它留在会话历史里，
  // 但请求期压缩器和折叠是两回事：把它单列出来，估算和实测的差才对得上账。
  let legacyChars = 0
  // 上一次请求之后才写进历史的内容：本轮请求里它是未命中。
  let pendingNew = 0
  // 上一轮那一行：两种视角在轮边界上的差要靠它算（摘要 vs 回复原文）。
  let prevTurn = null

  for (const group of list) {
    if (!group || typeof group !== 'object') continue
    const chars = Math.max(0, num(group.chars))
    if (group.kind !== 'turn') {
      // 只有当前生效的系统提示会上行；更早的版本留在 surface 里但发不出去，
      // 计进来会把总量抬高几倍，所以这里只算最后一条。
      if (group !== currentSystem) continue
      foldedCum += chars
      unfoldedCum += chars
      pendingNew += chars
      continue
    }
    if (group.prePlugin === true) legacyChars += chars
    const steps = Math.max(1, num(group.steps, 1))
    const checkpointChars = Math.max(0, num(group.checkpointChars))
    // 本轮请求里真正发出去的内容不含本轮自己的检查点（它在轮末才写）。
    const ownChars = Math.max(0, chars - checkpointChars)
    // 旧记录可能没写 unfoldedChars（插件早期版本）。留 0 会让反事实的累计体积不增长，
    // netSaved 算出荒谬值；非折叠轮的原文就是 chars（按定义两者相等），折叠轮只能给一个
    // 下界，但同样好过 0，并在行上标成估算。
    const rawUnfolded = Math.max(0, num(group.unfoldedChars))
    const unfoldedChars = rawUnfolded > 0 ? rawUnfolded : chars
    const unfoldedEstimated = rawUnfolded <= 0
    const outputChars = Math.max(0, num(group.outputChars))
    const baseFolded = Math.max(0, foldedCum - pendingNew)
    const baseUnfolded = unfoldedCum
    const addedTokens = tokenOf(ownChars)
    const unfoldTokens = tokenOf(unfoldedChars)
    const freshTokens = tokenOf(pendingNew)
    // 重发量：前缀每步都要发一次。上一轮检查点在本轮同样每一步都在，但它首次上行是未命中，
    // 所以只有 steps-1 次进「按命中率拆档」的那部分。轮内新增内容首次上行也是未命中，
    // 早先把它整段塞进拆档部分，等于让同一批 token 既按未命中、又按 (1-命中率) 付两次。
    const resendSplit = steps * tokenOf(baseFolded) + (steps - 1) * freshTokens
    const resendFolded = resendSplit + addedTokens * ((steps - 1) / 2)
    // 校准用的重放量：拆档的重发 + 新增内容各付一次首次上行，和结算完全同口径。
    const replayTokens = resendSplit + addedTokens + freshTokens
    const resendUnfolded = steps * tokenOf(baseUnfolded) + unfoldTokens * ((steps - 1) / 2)
    const usage = usageByTurn.get(group.turn) || null
    const actualParts = partsOfUsage(usage)
    // 轮边界上的差：不折叠时上一轮的回复要作为新内容重发一遍，折叠时只发一条摘要。
    // 只有上一轮真的折过才有这个差；没折的短轮两视角一模一样。
    const boundaryDeltaTokens = prevTurn !== null && prevTurn.folded === true
      ? Math.max(0, tokenOf(prevTurn.outputChars) - tokenOf(prevTurn.checkpointChars))
      : 0
    const row = {
      turn: typeof group.turn === 'number' ? group.turn : null,
      steps,
      folded: group.folded === true,
      checkpointChars,
      foldedChars: chars,
      unfoldedChars,
      outputChars,
      resendFolded,
      resendSplit,
      replayTokens,
      resendUnfolded,
      addedTokens,
      freshTokens,
      unfoldTokens,
      unfoldedEstimated,
      outputTokens: tokenOf(outputChars),
      actualPromptTokens: usage ? Math.round(promptTokensOf(usage)) : 0,
      actualHitTokens: actualParts ? Math.round(actualParts.hit) : 0,
      actualInputTokens: actualParts ? Math.round(actualParts.input) : 0,
      actualOutputTokens: actualParts ? Math.round(actualParts.output) : 0,
      actualSteps: usage ? usage.steps : 0,
      boundaryDeltaTokens,
    }
    rows.push(row)
    prevTurn = row

    foldedCum += chars
    unfoldedCum += unfoldedChars
    // 下一轮请求里，折叠过的一轮只剩检查点是新内容；没折叠的一轮整段都还是新内容。
    pendingNew = group.folded === true ? checkpointChars : chars
  }

  const calibration = calibrationOf(rows)
  // 展示沿用 provider 原样回报的命中率；结算用扣掉「每步新增内容」之后的重发命中率。
  const hitRate = calibration.measuredHitRate === null ? hitRateOf(config) : calibration.measuredHitRate
  const scale = calibration.promptScale
  const outScale = calibration.outputScale
  const resendHitRate = resendHitRateOf(rows, scale, hitRate)

  // 逐轮结算：重发的前缀按实测命中率拆成两档，新增内容与上一轮检查点各付一次。
  // 不折叠视角的未命中不重新按体积折一遍，而是锚在折叠视角上、只补轮边界差：
  // 两种视角每步的新增内容一样，体积差全部落在命中的前缀里（体积大 → 命中的更多）。
  const sums = { foldedHit: 0, foldedInput: 0, unfoldedHit: 0, unfoldedInput: 0, output: 0, boundary: 0 }
  for (const row of rows) {
    // 只把「重发量」交给命中率拆档；新增内容（含上一轮检查点）的首次上行固定算未命中。
    const foldedResend = row.resendSplit * scale
    const unfoldedResend = row.resendUnfolded * scale
    const hitFolded = resendHitRate * foldedResend
    const inputFolded = (1 - resendHitRate) * foldedResend + (row.addedTokens + row.freshTokens) * scale
    // 不折叠视角的整份提示词 = 重发量 + 本轮原文；未命中 = 折叠视角的未命中 + 轮边界多出的那点回复。
    const unfoldedPrompt = unfoldedResend + row.unfoldTokens * scale
    const inputUnfolded = Math.min(unfoldedPrompt, Math.max(0, inputFolded + row.boundaryDeltaTokens * scale))
    const hitUnfolded = Math.max(0, unfoldedPrompt - inputUnfolded)
    const outputTokens = row.outputTokens * outScale
    row.foldedHitTokens = Math.round(hitFolded)
    row.foldedInputTokens = Math.round(inputFolded)
    row.unfoldedHitTokens = Math.round(hitUnfolded)
    row.unfoldedInputTokens = Math.round(inputUnfolded)
    row.outputTokens = Math.round(outputTokens)
    row.foldedTokens = Math.round(hitFolded + inputFolded)
    row.unfoldedTokens = Math.round(hitUnfolded + inputUnfolded)
    row.netSavedTokens = row.unfoldedTokens - row.foldedTokens
    // 行金额用未取整的 token 算，页面三分档金额之和与行合计会有亚分级差。
    const foldedParts = { hit: hitFolded, input: inputFolded, output: outputTokens }
    const unfoldedParts = { hit: hitUnfolded, input: inputUnfolded, output: outputTokens }
    const foldedMoney = moneyOf(foldedParts, prices)
    const unfoldedMoney = moneyOf(unfoldedParts, prices)
    row.foldedMoney = foldedMoney.total
    row.unfoldedMoney = unfoldedMoney.total
    row.netSavedMoney = roundMoney(unfoldedMoney.total - foldedMoney.total)
    const actualParts = row.actualPromptTokens > 0
      ? { hit: row.actualHitTokens, input: row.actualInputTokens, output: row.actualOutputTokens }
      : null
    row.actualMoney = actualParts ? moneyOf(actualParts, prices).total : 0

    sums.foldedHit += hitFolded
    sums.foldedInput += inputFolded
    sums.unfoldedHit += hitUnfolded
    sums.unfoldedInput += inputUnfolded
    sums.output += outputTokens
    // 两种视角未命中的差 = 轮边界上「回复原文 − 摘要」的累计，页面用这一项解释差从哪来。
    sums.boundary += row.boundaryDeltaTokens * scale
  }

  const withActual = rows.filter((row) => row.actualPromptTokens > 0)
  const latest = normalizeLatest(actual)
  const contextFoldedTokens = tokenOf(foldedCum)
  const contextUnfoldedTokens = tokenOf(unfoldedCum)
  const legacyTokens = tokenOf(legacyChars)
  // 估算量的是会话历史；真正上行的那份可能还被请求期压缩器改写过。
  // 口径拆成三段，页面才解释得清「为什么估算和账单不是同一个数」：
  //   governedTokens  = 归折叠管的部分（插件生效后的历史 + 当前系统提示），能和实测并排比；
  //   legacyTokens    = 插件生效前那一轮，没人折得动，实测里已被请求期压缩器改写；
  //   externalTokens  = 实测里剩下的部分（工具定义、请求期压缩器注入的摘要等）。
  const governedTokens = Math.max(0, contextFoldedTokens - legacyTokens)
  const drift = latest === null
    ? null
    : {
        estimateTokens: contextFoldedTokens,
        actualPromptTokens: latest.promptTokens,
        legacyTokens,
        eraTokens: governedTokens,
        governedTokens,
        externalTokens: Math.max(0, latest.promptTokens - governedTokens),
        ratio: contextFoldedTokens > 0 ? latest.promptTokens / contextFoldedTokens : 0,
        governedRatio: governedTokens > 0 ? latest.promptTokens / governedTokens : 0,
        overEstimate: contextFoldedTokens > latest.promptTokens * 1.3,
        underEstimate: governedTokens > latest.promptTokens * 1.3,
      }

  // 金额用未取整的三档累计值算一次；行的金额只用于逐轮展示。
  const foldedMoney = moneyOf({ hit: sums.foldedHit, input: sums.foldedInput, output: sums.output }, prices)
  const unfoldedMoney = moneyOf({ hit: sums.unfoldedHit, input: sums.unfoldedInput, output: sums.output }, prices)
  const actualTotals = rows.reduce(
    (sum, row) => {
      sum.hit += row.actualHitTokens
      sum.input += row.actualInputTokens
      sum.output += row.actualOutputTokens
      sum.money += row.actualMoney
      return sum
    },
    { hit: 0, input: 0, output: 0, money: 0 },
  )

  const foldedTotal = rows.reduce((sum, row) => sum + row.foldedTokens, 0)
  const unfoldedTotal = rows.reduce((sum, row) => sum + row.unfoldedTokens, 0)
  const netSavedTotal = unfoldedTotal - foldedTotal

  return {
    ok: true,
    hitRate,
    resendHitRate,
    measuredHitRate: calibration.measuredHitRate,
    calibration,
    prices,
    turns: rows,
    drift,
    totals: {
      turns: rows.length,
      steps: rows.reduce((sum, row) => sum + row.steps, 0),
      foldedTokens: foldedTotal,
      unfoldedTokens: unfoldedTotal,
      netSavedTokens: netSavedTotal,
      savedRate: unfoldedTotal > 0 ? netSavedTotal / unfoldedTotal : 0,
      contextFoldedTokens,
      contextUnfoldedTokens,
      legacyTokens,
      // 三档 token：折叠后 / 不折叠各一份，输出是两者共用的那一份。
      foldedHitTokens: Math.round(sums.foldedHit),
      foldedInputTokens: Math.round(sums.foldedInput),
      unfoldedHitTokens: Math.round(sums.unfoldedHit),
      unfoldedInputTokens: Math.round(sums.unfoldedInput),
      // 不折叠比折叠多付的未命中：只有每轮边界上的那条回复，不随上下文体积放大。
      unfoldedBoundaryTokens: Math.round(sums.boundary),
      outputTokens: Math.round(sums.output),
      foldedMoney: foldedMoney.total,
      unfoldedMoney: unfoldedMoney.total,
      netSavedMoney: roundMoney(unfoldedMoney.total - foldedMoney.total),
      // 实测：只有拿到回报的轮才有；金额按同一套单价结算。
      actualHitTokens: Math.round(actualTotals.hit),
      actualInputTokens: Math.round(actualTotals.input),
      actualOutputTokens: Math.round(actualTotals.output),
      actualMoney: roundMoney(actualTotals.money),
      actualPromptTokens: withActual.reduce((sum, row) => sum + row.actualPromptTokens, 0),
      actualTurns: withActual.length,
      actualSteps: rows.reduce((sum, row) => sum + (row.actualSteps || 0), 0),
      checkpoints: rows.filter((row) => row.checkpointChars > 0).length,
      // 旧记录缺 unfoldedChars、只能拿折叠后体积当下界的轮数：这些轮的「省下」被低估。
      unfoldedEstimatedTurns: rows.filter((row) => row.unfoldedEstimated).length,
      // 最近一次请求的金额：页面要拿它和估算并排显示。
      latestMoney: latest ? moneyOf(partsOfUsage({
        cacheRead: latest.cacheReadTokens,
        input: latest.inputTokens,
        cacheWrite: latest.cacheWriteTokens,
        output: latest.outputTokens,
      }), prices).total : 0,
    },
    latest,
  }
}

// 最近一次请求的 provider 回报；没有就返回 null，页面显示「还没有回报」。
export function normalizeLatest(value) {
  if (!value || typeof value !== 'object') return null
  const prompt = promptTokensOf(value)
  if (prompt <= 0) return null
  return {
    promptTokens: Math.round(prompt),
    inputTokens: num(value.input),
    cacheReadTokens: num(value.cacheRead),
    cacheWriteTokens: num(value.cacheWrite),
    outputTokens: num(value.output),
    turn: typeof value.turn === 'number' ? value.turn : null,
    step: typeof value.step === 'number' ? value.step : null,
    at: num(value.at, 0),
  }
}

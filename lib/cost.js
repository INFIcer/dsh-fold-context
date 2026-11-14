// 折叠的成本模型：把「每轮都要把上下文重发一遍」这件事折算成 token 开销，
// 再拿折叠后的历史和不折叠的历史各算一遍，差值就是净节省。
//
// 关键点（也是和朴素估算不同的地方）：
// 1. 前缀缓存只认「上一次请求里出现过的内容」。折叠会在轮末重写历史，
//    所以上一轮的检查点到本轮第一次请求时是**新内容**（未命中），
//    不能算进命中前缀里。
// 2. 本轮自己的检查点在轮末才写入，所以本轮请求里没有它；从下一轮起它在每一步请求里
//    都在——首次上行算未命中，其余 steps-1 次按命中价重发（早先只算了首次，漏了重发）。
// 3. 一轮有 k 步，前缀被重发 k 次；**轮内新写进上下文的内容（思考、回复、工具结果）
//    从它生成的那一步起也在每一步请求里**，按平均半步处在上下文中重发。
//    折叠发生在轮末，所以折叠轮的轮内内容必须按原文（unfoldedChars）算，不能按折叠后
//    剩下的 chars——后者只剩用户原话与摘要，差一个数量级；早先漏掉这一项，
//    重放量只有实测账单的 1/120，校准系数被顶到上限，估算与实测自然对不上。
// 4. 重发的前缀按真实命中率拆成两档：命中部分按缓存价、未命中部分按输入价。
//    早先的版本把「命中率」当成「缓存价的折扣当量」（0.25 之类），
//    结果 98% 的前缀按 0 元计，整份账单只有真账的三分之一。
//    命中率本身也要扣掉「每步新写进历史的内容」再算（resendHitRate）：那部分按定义
//    必定未命中，留在分母里会把纯重发的命中率系统性压低，进而把折叠成本算高。
// 5. 未命中不随上下文体积等比例放大。请求里真正没命中的是「上一次请求之后才写进历史的内容」：
//    每步的思考/回复/工具结果（实测约 2 千 token/步），外加缓存整段失效的事件
//    （系统提示改写等，代价是当时的上下文）。
//    折叠视角比「完全不装插件」多付三类首次上行内容：检查点摘要、固化消息、召回返回的正文——
//    它们都是新写进历史的东西。原文两种视角都要付一次，所以不折叠视角的未命中 = 折叠视角
//    扣掉这三类，只会更小；折叠省下来的是命中档（前缀体积小 5 倍，重复重发便宜）。
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
// 提示词上限放到 6：历史之外的开销（工具定义、请求期压缩器注入）是每一步都要付的，
// 轮内原文补齐后仍可能需要 1.5~3 倍；夹到 2 会把「模型错了」伪装成「刚好没超」。
const PROMPT_SCALE_MIN = 0.02
const PROMPT_SCALE_MAX = 6
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
  // raw 是没夹断的系数：页面要靠它看出模型本身偏了多少，而不是只看到一个被夹过的 1.00。
  const rawPromptScale = replayPrompt > 0 ? actualPrompt / replayPrompt : 1
  const rawOutputScale = replayOutput > 0 ? actualOutput / replayOutput : 1
  return {
    coveredTurns: covered.length,
    promptScale: clampNumber(rawPromptScale, PROMPT_SCALE_MIN, PROMPT_SCALE_MAX, 1),
    rawPromptScale,
    outputScale: clampNumber(rawOutputScale, OUTPUT_SCALE_MIN, OUTPUT_SCALE_MAX, 1),
    rawOutputScale,
    promptScaleClamped: rawPromptScale > PROMPT_SCALE_MAX || rawPromptScale < PROMPT_SCALE_MIN,
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
    const fresh = Math.min(row.actualInputTokens, (row.liveTokens + row.freshTokens) * scale)
    hit += row.actualHitTokens
    input += Math.max(0, row.actualInputTokens - fresh)
  }
  if (hit + input <= 0) return fallback
  return Math.min(1, Math.max(0, hit / (hit + input)))
}

export function buildCost({ groups, folds, recalls, pins, config, actual } = {}) {
  const list = mergeTurns(Array.isArray(groups) ? groups : [])
  const foldMap = foldMapOf(folds)
  // 插件比「不装插件」多出来的首次上行内容：检查点摘要、固化的重要信息、召回返回的正文。
  // 折叠视角的未命中本来就包含它们（它们作为消息进了上下文），不折叠基线里没有这些东西。
  const recallTokensByTurn = new Map()
  for (const record of Array.isArray(recalls) ? recalls : []) {
    if (!record || typeof record !== 'object') continue
    const tokens = num(record.tokens)
    if (tokens <= 0) continue
    const turn = typeof record.turn === 'number' ? record.turn : 0
    recallTokensByTurn.set(turn, (recallTokensByTurn.get(turn) || 0) + tokens)
  }
  const pinTokens = (Array.isArray(pins) ? pins : []).reduce(
    (sum, pin) => sum + (pin && typeof pin.text === 'string' ? tokenOf(pin.text) : 0),
    0,
  )
  const currentSystem = currentSystemOf(list)
  const usageByTurn = usageByTurnOf(foldMap)
  const prices = pricesOf(config)
  const rows = []
  // 当前生效的系统提示在每个请求里都在。派生消息里它按「版本更新」的位置出现，但那个位置
  // 只是它被改写的时间，不是它开始被发送的时间；按位置累加会把前几轮整个漏掉。
  // 用当前版本的体积从第一个请求起计入：系统提示每步都重发，折叠既省不了它、也不多收它。
  const systemChars = currentSystem ? Math.max(0, num(currentSystem.chars)) : 0
  let foldedCum = systemChars
  let unfoldedCum = systemChars
  // 插件生效前的那一轮没人折得动（当时还没有载荷），它留在会话历史里，
  // 但请求期压缩器和折叠是两回事：把它单列出来，估算和实测的差才对得上账。
  let legacyChars = 0
  // 上一次请求之后才写进历史的内容：本轮请求里它是未命中。
  let pendingNew = 0
  // 上一轮是不是折叠轮：决定本轮 fresh 是不是「插件引入的检查点」。
  let prevFolded = false
  let pinsAssigned = false

  for (const group of list) {
    if (!group || typeof group !== 'object') continue
    const chars = Math.max(0, num(group.chars))
    // 系统提示是同一个提示的不同版本，上面已经按当前版本从第一个请求起计过，
    // 这里不再按位置累加（旧版本留在 surface 里但发不出去，计进来会把总量抬高几倍）。
    if (group.kind !== 'turn') continue
    if (group.prePlugin === true) legacyChars += chars
    const steps = Math.max(1, num(group.steps, 1))
    const checkpointChars = Math.max(0, num(group.checkpointChars))
    // 旧记录可能没写 unfoldedChars（插件早期版本）。留 0 会让反事实的累计体积不增长，
    // netSaved 算出荒谬值；非折叠轮的原文就是 chars（按定义两者相等），折叠轮只能给一个
    // 下界，但同样好过 0，并在行上标成估算。
    const rawUnfolded = Math.max(0, num(group.unfoldedChars))
    const unfoldedChars = rawUnfolded > 0 ? rawUnfolded : chars
    const unfoldedEstimated = rawUnfolded <= 0
    // 折叠轮的 chars 是折叠后剩下的组：用户原话 + 摘要（几十到几千字）；轮内真正在上下文里的
    // 是被折掉的原文（unfoldedChars，常是几十万字）。折叠发生在轮末，所以本轮每一步请求
    // 都带着这份原文，重发必须按它算，不能按 chars-checkpointChars 算。
    const liveChars = group.folded === true ? unfoldedChars : chars
    const outputChars = Math.max(0, num(group.outputChars))
    const baseFolded = Math.max(0, foldedCum - pendingNew)
    const baseUnfolded = unfoldedCum
    // 两种视角的轮内新增内容一模一样（同一轮思考、回复、工具结果）。
    const liveTokens = tokenOf(liveChars)
    const unfoldTokens = liveTokens
    const freshTokens = tokenOf(pendingNew)
    // 不装插件时不存在的东西：上一轮检查点（fresh 里那份）、召回返回正文、固化消息。
    // 折叠视角的未命中已经把它们算进去了，不折叠基线里必须扣掉。
    const pluginOverheadTokens = (prevFolded ? freshTokens : 0)
      + (recallTokensByTurn.get(group.turn) || 0)
      + (pinsAssigned ? 0 : pinTokens)
    pinsAssigned = true
    // 重发量：前缀每步都要发一次。上一轮检查点在本轮同样每一步都在，但它首次上行是未命中，
    // 所以只有 steps-1 次进「按命中率拆档」的那部分。轮内新增内容首次上行是未命中，
    // 之后在轮内剩余步骤里按平均半步重发——这一项是账单的大头，早先漏了它，
    // 折叠视角的重放量只有实测的 1/120。
    const resendSplit = steps * tokenOf(baseFolded) + (steps - 1) * freshTokens + liveTokens * ((steps - 1) / 2)
    const resendFolded = resendSplit + liveTokens
    // 校准用的重放量：拆档的重发 + 新增内容各付一次首次上行，和结算完全同口径。
    const replayTokens = resendSplit + liveTokens + freshTokens
    const resendUnfolded = steps * tokenOf(baseUnfolded) + liveTokens * ((steps - 1) / 2)
    const usage = usageByTurn.get(group.turn) || null
    const actualParts = partsOfUsage(usage)
    const row = {
      turn: typeof group.turn === 'number' ? group.turn : null,
      steps,
      folded: group.folded === true,
      checkpointChars,
      foldedChars: chars,
      unfoldedChars,
      liveChars,
      outputChars,
      resendFolded,
      resendSplit,
      replayTokens,
      resendUnfolded,
      liveTokens,
      freshTokens,
      unfoldTokens,
      unfoldedEstimated,
      outputTokens: tokenOf(outputChars),
      actualPromptTokens: usage ? Math.round(promptTokensOf(usage)) : 0,
      actualHitTokens: actualParts ? Math.round(actualParts.hit) : 0,
      actualInputTokens: actualParts ? Math.round(actualParts.input) : 0,
      actualOutputTokens: actualParts ? Math.round(actualParts.output) : 0,
      actualSteps: usage ? usage.steps : 0,
    }
    row.pluginOverheadTokens = pluginOverheadTokens
    rows.push(row)
    prevFolded = group.folded === true

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
  // 折叠视角就是实测的那一次运行，所以它每一步的未命中总量应该等于 provider 回报的未命中。
  // 重放模型里「本轮新内容 + 上一轮检查点」是未命中的来源；工具定义、请求期压缩器注入、
  // token 密度这些没进模型的量，用同一个系数收口——只调命中/未命中的分配，不改重放总量。
  const projected = []
  for (const row of rows) {
    const foldedResend = row.resendSplit * scale
    const unfoldedResend = row.resendUnfolded * scale
    projected.push({
      row,
      foldedInput: (1 - resendHitRate) * foldedResend + (row.liveTokens + row.freshTokens) * scale,
      foldedTotal: foldedResend + (row.liveTokens + row.freshTokens) * scale,
      unfoldedPrompt: unfoldedResend + row.unfoldTokens * scale,
      outputTokens: row.outputTokens * outScale,
    })
  }
  const coveredProjected = projected.filter((item) => item.row.actualPromptTokens > 0)
  const modeledInput = coveredProjected.reduce((sum, item) => sum + item.foldedInput, 0)
  const reportedInput = coveredProjected.reduce((sum, item) => sum + item.row.actualInputTokens, 0)
  const missScale = modeledInput > 0 && reportedInput > 0
    ? clampNumber(reportedInput / modeledInput, 0.2, 5, 1)
    : 1
  calibration.missScale = missScale

  const sums = { foldedHit: 0, foldedInput: 0, unfoldedHit: 0, unfoldedInput: 0, output: 0 }
  for (const item of projected) {
    const row = item.row
    const foldedInput = Math.min(item.foldedTotal, Math.max(0, item.foldedInput * missScale))
    const foldedHit = item.foldedTotal - foldedInput
    // 不折叠基线锚在折叠视角上，只扣掉插件额外引入的首次上行内容
    // （上一轮检查点、召回返回正文、固化消息）。原文两种视角都要付一次，
    // 所以不折叠的未命中只会更小；省下来的是命中档（前缀体积小 5 倍）。
    const unfoldedInput = Math.min(item.unfoldedPrompt, Math.max(0, foldedInput - row.pluginOverheadTokens))
    const unfoldedHit = item.unfoldedPrompt - unfoldedInput
    row.foldedHitTokens = Math.round(foldedHit)
    row.foldedInputTokens = Math.round(foldedInput)
    row.unfoldedHitTokens = Math.round(unfoldedHit)
    row.unfoldedInputTokens = Math.round(unfoldedInput)
    row.outputTokens = Math.round(item.outputTokens)
    row.foldedTokens = Math.round(foldedHit + foldedInput)
    row.unfoldedTokens = Math.round(unfoldedHit + unfoldedInput)
    row.netSavedTokens = row.unfoldedTokens - row.foldedTokens
    // 行金额用未取整的 token 算，页面三分档金额之和与行合计会有亚分级差。
    const foldedMoney = moneyOf({ hit: foldedHit, input: foldedInput, output: item.outputTokens }, prices)
    const unfoldedMoney = moneyOf({ hit: unfoldedHit, input: unfoldedInput, output: item.outputTokens }, prices)
    row.foldedMoney = foldedMoney.total
    row.unfoldedMoney = unfoldedMoney.total
    row.netSavedMoney = roundMoney(unfoldedMoney.total - foldedMoney.total)
    row.actualMoney = row.actualPromptTokens > 0
      ? moneyOf({ hit: row.actualHitTokens, input: row.actualInputTokens, output: row.actualOutputTokens }, prices).total
      : 0

    sums.foldedHit += foldedHit
    sums.foldedInput += foldedInput
    sums.unfoldedHit += unfoldedHit
    sums.unfoldedInput += unfoldedInput
    sums.output += item.outputTokens
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

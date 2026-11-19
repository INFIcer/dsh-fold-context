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
// 实测的来路与折叠解耦：每轮结束时单独落一条 usage 记录（host.js 的 recordTurnUsage），
// 所以关掉折叠、或这一轮没折，账本仍然拿得到 provider 回报——实测不能被折叠开关关掉。
//
// 金额：命中、未命中、输出三档各有单价（pricing.js），token × 单价 / 1e6 就是元。
// 输出与折叠无关（同一句回复两种视角都要生成），两边都计入，做差时自然抵消。
//
// 峰谷：每一轮按它自己的时间戳（分组 at / usage.at / 记录 at）取峰时或谷时的三档单价；
// 时段由调用方从 fish-token 查好传进来（peak），成本模型不碰 ctx、也不写钟点判断。
// 服务拿不到时全按峰值倍率保守估算，输出里用 peak.fallback / peak.applied 标明。
//
// 纯函数：输入是 turns.js 的分组 + fold 记录 + 配置，输出是普通对象。

import { estimateChars } from './tokens.js'
import { normalizeUsage, promptTokensOf } from './usage.js'
import {
  clampPeakMultiplier,
  defaultHitRate,
  moneyOf,
  peakMultiplierOf,
  pricesAtMultiplier,
  pricesOf,
  rawMoneyOf,
  roundMoney,
} from './pricing.js'

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

// 一条记录的计价时间：取第一个大于 0 的候选。0 / 缺失都表示「这条记录没写时间」，
// 这时判不出峰谷，按峰值倍率保守估算并计入 unknown，不能拿「现在」冒充历史时刻。
function firstTime(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

// chars 必须是「字符数」，不是文本：estimateChars 对非数字静默返回 0，
// 传文本会让那一笔开销凭空消失（固化消息一度整笔算成 0，看不出少了什么）。
// 这里的调用点全是数字，类型错就是 bug，当面报出来比算成 0 好查。
function tokenOf(chars) {
  if (typeof chars !== 'number' || !Number.isFinite(chars)) {
    throw new TypeError('tokenOf 需要字符数（number），收到的是 ' + (chars === null ? 'null' : typeof chars))
  }
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
        at: num(group.at),
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
    // 同号的续接段取最早的那个时间：这一轮第一个请求发生在这里。
    const at = num(group.at)
    if (at > 0 && (seen.at <= 0 || at < seen.at)) seen.at = at
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

// 实测用量按轮汇总。新版本每轮单独落一条 usage 记录（不依附折叠），它是主来源：
// 关掉折叠、或这一轮没折，账本仍能拿到 provider 回报；同一轮被 steering 切成两段时，
// 两条记录是两段各自的增量，相加才是整轮。折叠记录里的 usage 只给旧会话兜底：
// 同一轮折成多段时每段都写同一份，所以按轮取一条而不是相加。
function usageByTurnOf(folds, usages) {
  const map = new Map()
  for (const record of Array.isArray(usages) ? usages : []) {
    if (!record || typeof record !== 'object') continue
    const turn = typeof record.turn === 'number' ? record.turn : null
    if (turn === null) continue
    const usage = normalizeUsage(record)
    if (!usage) continue
    // 记录时间随 usage 带走：峰谷按每条记录自己的时间戳判，老记录没有就留 0。
    const at = num(record.at)
    if (at > 0) usage.at = at
    const seen = map.get(turn)
    if (!seen) {
      map.set(turn, usage)
      continue
    }
    if (at > 0 && (num(seen.at) <= 0 || at < num(seen.at))) seen.at = at
    seen.steps += usage.steps
    seen.input += usage.input
    seen.cacheRead += usage.cacheRead
    seen.cacheWrite += usage.cacheWrite
    seen.output += usage.output
  }
  for (const record of folds.values()) {
    const turn = record && typeof record.turn === 'number' ? record.turn : null
    if (turn === null || map.has(turn)) continue
    const usage = normalizeUsage(record && record.usage)
    if (!usage) continue
    const at = num(record && record.at)
    if (at > 0) usage.at = at
    map.set(turn, usage)
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

// 未取整的三档金额 → 页面口径：每档与合计都收口到六位小数。
// 逐档先取整再加总，和 moneyOf 的形状一致，客户端两处显示不会差一分。
function roundedMoneyParts(raw) {
  const cacheHit = roundMoney(num(raw && raw.cacheHit))
  const input = roundMoney(num(raw && raw.input))
  const output = roundMoney(num(raw && raw.output))
  return { cacheHit, input, output, total: roundMoney(cacheHit + input + output) }
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

export function buildCost({ groups, folds, recalls, pins, config, actual, usages, peak } = {}) {
  const list = mergeTurns(Array.isArray(groups) ? groups : [])
  const foldMap = foldMapOf(folds)
  // 插件比「不装插件」多出来的首次上行内容：检查点摘要、固化的重要信息、召回返回的正文。
  // 折叠视角的未命中本来就包含它们（它们作为消息进了上下文），不折叠基线里没有这些东西。
  //
  // 召回分两笔记：content 是取回的原文，probe 是分段目录与关键词检索返回的那点编号清单。
  // 目录同样是插件引入的一次上行，同样按未命中计价——它也是 fold_recall 的工具结果正文，
  // 只是内容小、且不含原文。「只给目录」的那次调用因此要单列，否则会被当成「没花成本」。
  const recallTokensByTurn = new Map()
  const probeTokensByTurn = new Map()
  for (const record of Array.isArray(recalls) ? recalls : []) {
    if (!record || typeof record !== 'object') continue
    const tokens = num(record.tokens)
    if (tokens <= 0) continue
    const turn = typeof record.turn === 'number' ? record.turn : 0
    const probe = record.mode === 'index' || record.mode === 'search'
    const target = probe ? probeTokensByTurn : recallTokensByTurn
    target.set(turn, (target.get(turn) || 0) + tokens)
  }
  // 重要消息只算模型看得见的那些（pins.js 的 resolvePins 已把被压缩卷走的标成 present: false）；
  // 字数取整条消息（前缀 + 标题 + 正文），和账本里 pinRows 的口径一致。
  const pinTokens = (Array.isArray(pins) ? pins : []).reduce((sum, pin) => {
    if (!pin || pin.present === false) return sum
    const chars = num(pin.chars) > 0 ? num(pin.chars) : typeof pin.text === 'string' ? pin.text.length : 0
    return sum + tokenOf(chars)
  }, 0)
  const currentSystem = currentSystemOf(list)
  const usageByTurn = usageByTurnOf(foldMap, usages)
  const prices = pricesOf(config)
  // 每条已有记录的时间：成本按「轮」聚合，一轮的记录取最早的那个时间当代表点，
  // 优先用分组自己的 at（会话事件的 turn/start 时间），老数据再退回这里。
  const recordTimes = new Map()
  function noteRecordTime(turn, at) {
    const key = num(turn)
    const value = num(at)
    if (value <= 0) return
    const seen = recordTimes.get(key)
    if (seen === undefined || value < seen) recordTimes.set(key, value)
  }
  for (const record of foldMap.values()) noteRecordTime(record.turn, record.at)
  for (const record of Array.isArray(usages) ? usages : []) noteRecordTime(record && record.turn, record && record.at)
  for (const record of Array.isArray(recalls) ? recalls : []) noteRecordTime(record && record.turn, record && record.at)
  for (const pin of Array.isArray(pins) ? pins : []) noteRecordTime(pin && pin.turn, pin && pin.at)

  // 峰谷：时段判定来自 fish.token（web.js 已折算成普通对象）。倍率用 peak.js 定好的
  // 最终值：默认跟随服务报的 multiplier，用户改过本插件设置时以设置为准。
  // 服务缺失/判不出时段时 fallback=true：按峰值倍率保守估算，面板会标明这是回退。
  // 逐条判定抛错或返回坏值时只影响那一条（记成未知、按峰时算），不让路由 500。
  const peakEnabled = !(config && config.peakPricing === false)
  const peakMultiplier = peak && typeof peak.multiplier === 'number' && Number.isFinite(peak.multiplier)
    ? clampPeakMultiplier(peak.multiplier)
    : peakMultiplierOf(config)
  const peakActive = peakEnabled && Boolean(peak) && peak.available === true && typeof peak.pricingAt === 'function'
  // 只有调用方明确说「服务拿不到、按峰时兜底」时才启用回退；
  // 纯函数直接调用（没有 peak 参数）保持原来的谷时价，不把测试与离线工具带进峰时。
  const peakFallback = peakEnabled && Boolean(peak) && peak.available !== true && peak.fallback === true
  const peakApplied = peakActive || peakFallback
  const peakPrices = peakApplied ? pricesAtMultiplier(prices, peakMultiplier) : prices
  const peakNow = peak && peak.now && typeof peak.now === 'object' ? peak.now : null
  const peakCounts = { peak: 0, offPeak: 0, unknown: 0 }
  let peakDegraded = false
  function pricePointOf(at, count = true) {
    const point = num(at)
    if (!peakApplied) return { at: point, peak: null, multiplier: null, prices }
    if (peakFallback) {
      if (count) peakCounts.unknown += 1
      return { at: point, peak: null, multiplier: peakMultiplier, prices: peakPrices }
    }
    if (point <= 0) {
      // 没有时间戳就判不出时段：保守按峰时算，并把这一轮记成未知。
      if (count) peakCounts.unknown += 1
      return { at: 0, peak: null, multiplier: peakMultiplier, prices: peakPrices }
    }
    let info = null
    try {
      info = peak.pricingAt(point)
    } catch {
      info = null
    }
    if (!info || typeof info.peak !== 'boolean') {
      peakDegraded = true
      if (count) peakCounts.unknown += 1
      return { at: point, peak: null, multiplier: peakMultiplier, prices: peakPrices }
    }
    if (count) {
      if (info.peak === true) peakCounts.peak += 1
      else peakCounts.offPeak += 1
    }
    // 倍率 1 与「不区分峰谷」等价：pricesAtMultiplier 直接返回原对象。
    const multiplier = info.peak === true ? peakMultiplier : 1
    return {
      at: point,
      peak: info.peak,
      multiplier,
      prices: info.peak === true ? pricesAtMultiplier(prices, multiplier) : prices,
    }
  }
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
  // 插件额外首次上行的分项合计：页面的「未命中差」要能说清这 2 千 token 花在哪，
  // 只报一个总数时，读的人分不出「目录」与「原文」。
  const overheadTotals = { checkpoint: 0, recall: 0, probe: 0, pin: 0, total: 0 }

  for (const group of list) {
    if (!group || typeof group !== 'object') continue
    const chars = Math.max(0, num(group.chars))
    // 系统提示是同一个提示的不同版本，上面已经按当前版本从第一个请求起计过，
    // 这里不再按位置累加（旧版本留在 surface 里但不计入请求）。
    if (group.kind !== 'turn') continue
    // 全量历史（history.js）会给出「这一轮开始时上下文有多大」：压缩会把旧轮换掉，
    // 基准跟着变小，但之前各轮已按当时的基准结算过，不能用累计和重算。
    if (typeof group.baseFoldedChars === 'number' && Number.isFinite(group.baseFoldedChars)) {
      foldedCum = Math.max(0, group.baseFoldedChars)
    }
    if (typeof group.baseUnfoldedChars === 'number' && Number.isFinite(group.baseUnfoldedChars)) {
      unfoldedCum = Math.max(0, group.baseUnfoldedChars)
    }
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
    // 不装插件时不存在的东西：上一轮检查点（fresh 里那份）、召回返回正文（含分段目录）、固化消息。
    // 折叠视角的未命中已经把它们算进去了，不折叠基线里必须扣掉。
    const overhead = {
      checkpoint: prevFolded ? freshTokens : 0,
      recall: recallTokensByTurn.get(group.turn) || 0,
      probe: probeTokensByTurn.get(group.turn) || 0,
      pin: pinsAssigned ? 0 : pinTokens,
    }
    overhead.total = overhead.checkpoint + overhead.recall + overhead.probe + overhead.pin
    const pluginOverheadTokens = overhead.total
    pinsAssigned = true
    // 重发量：前缀每步都要发一次。上一轮检查点在本轮同样每一步都在，但它首次上行是未命中，
    // 所以把这一次从「按命中率拆档」的那部分里扣掉。轮内新增内容首次上行是未命中，
    // 之后在轮内剩余步骤里按平均半步重发——这一项是账单的大头，早先漏了它，
    // 折叠视角的重放量只有实测的 1/120。
    //
    // 前缀必须按整段（foldedCum）算一次 token，不能拆成 baseFolded + freshTokens 再相加：
    // tokenOf 每段各自 ceil 并加一个块开销，拆开算会让同一份历史在折叠视角多出 steps×(1~5) token。
    // 这个偏差跟真折叠无关，没折叠时会直接变成负的「省下」——页面上那 -673 token 就是它。
    const prefixTokens = steps * tokenOf(foldedCum)
    const resendSplit = prefixTokens - freshTokens + liveTokens * ((steps - 1) / 2)
    const resendFolded = resendSplit + liveTokens
    // 校准用的重放量：拆档的重发 + 新增内容各付一次首次上行，和结算完全同口径。
    const replayTokens = resendSplit + liveTokens + freshTokens
    const resendUnfolded = steps * tokenOf(baseUnfolded) + liveTokens * ((steps - 1) / 2)
    const usage = usageByTurn.get(group.turn) || null
    const actualParts = partsOfUsage(usage)
    // 这一轮的计价时间：分组自带的 at（会话事件时间）优先，老载荷退回该轮已有记录的 at。
    const rowAt = firstTime(num(group.at), usage && usage.at, recordTimes.get(group.turn) || 0)
    const row = {
      turn: typeof group.turn === 'number' ? group.turn : null,
      at: rowAt,
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
    row.pluginOverhead = overhead
    row.pluginOverheadTokens = pluginOverheadTokens
    overheadTotals.checkpoint += overhead.checkpoint
    overheadTotals.recall += overhead.recall
    overheadTotals.probe += overhead.probe
    overheadTotals.pin += overhead.pin
    overheadTotals.total += overhead.total
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
  // 金额按「每条记录自己的单价」逐轮累加：峰谷混合时不能用一组均价去乘总量。
  // 这里存未取整值，最后统一取整；没有峰谷时仍走原来的合计口径，避免引入浮点差。
  const moneySums = {
    folded: { cacheHit: 0, input: 0, output: 0, total: 0 },
    unfolded: { cacheHit: 0, input: 0, output: 0, total: 0 },
    actual: { cacheHit: 0, input: 0, output: 0, total: 0 },
  }
  const premiumSums = { folded: 0, unfolded: 0, actual: 0 }
  function addMoney(target, raw) {
    target.cacheHit += raw.cacheHit
    target.input += raw.input
    target.output += raw.output
    target.total += raw.total
  }
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
    // 峰谷混合时每一行按自己的时间戳取单价；倍率 1 / 谷时拿到的就是原价表。
    const point = pricePointOf(row.at)
    row.prices = point.prices
    row.pricePoint = { at: point.at, peak: point.peak, multiplier: point.multiplier }
    const foldedRaw = rawMoneyOf({ hit: foldedHit, input: foldedInput, output: item.outputTokens }, point.prices)
    const unfoldedRaw = rawMoneyOf({ hit: unfoldedHit, input: unfoldedInput, output: item.outputTokens }, point.prices)
    const foldedRounded = moneyOf({ hit: foldedHit, input: foldedInput, output: item.outputTokens }, point.prices)
    const unfoldedRounded = moneyOf({ hit: unfoldedHit, input: unfoldedInput, output: item.outputTokens }, point.prices)
    row.foldedMoney = foldedRounded.total
    row.unfoldedMoney = unfoldedRounded.total
    row.netSavedMoney = roundMoney(unfoldedRounded.total - foldedRounded.total)
    let actualRaw = null
    let actualRounded = null
    if (row.actualPromptTokens > 0) {
      const actualPartsForRow = { hit: row.actualHitTokens, input: row.actualInputTokens, output: row.actualOutputTokens }
      actualRaw = rawMoneyOf(actualPartsForRow, point.prices)
      actualRounded = moneyOf(actualPartsForRow, point.prices)
      row.actualMoney = actualRounded.total
    } else {
      row.actualMoney = 0
    }
    addMoney(moneySums.folded, foldedRaw)
    addMoney(moneySums.unfolded, unfoldedRaw)
    if (actualRaw) addMoney(moneySums.actual, actualRaw)
    if (peakApplied) {
      const foldedBase = rawMoneyOf({ hit: foldedHit, input: foldedInput, output: item.outputTokens }, prices)
      const unfoldedBase = rawMoneyOf({ hit: unfoldedHit, input: unfoldedInput, output: item.outputTokens }, prices)
      premiumSums.folded += foldedRaw.total - foldedBase.total
      premiumSums.unfolded += unfoldedRaw.total - unfoldedBase.total
      if (actualRaw) {
        const actualBase = rawMoneyOf({ hit: row.actualHitTokens, input: row.actualInputTokens, output: row.actualOutputTokens }, prices)
        premiumSums.actual += actualRaw.total - actualBase.total
      }
    }

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
  // 峰谷混合时总额只能由逐轮金额累加得出；没有峰谷时仍按原来的合计口径算，
  // 保持与旧版本逐位一致（峰谷只是一个新维度，不该顺手改动无峰谷时的数）。
  const foldedMoneyParts = peakApplied ? roundedMoneyParts(moneySums.folded) : foldedMoney
  const unfoldedMoneyParts = peakApplied ? roundedMoneyParts(moneySums.unfolded) : unfoldedMoney
  const actualMoneyParts = peakApplied
    ? roundedMoneyParts(moneySums.actual)
    : moneyOf({ hit: actualTotals.hit, input: actualTotals.input, output: actualTotals.output }, prices)
  const actualMoneyValue = peakApplied ? actualMoneyParts.total : roundMoney(actualTotals.money)
  // 最近一次请求的金额同样按它自己的 at 判峰谷：实测账单里最近一笔也可能是峰时。
  const latestPoint = latest ? pricePointOf(latest.at, false) : null
  const latestMoney = latest
    ? moneyOf(partsOfUsage({
        cacheRead: latest.cacheReadTokens,
        input: latest.inputTokens,
        cacheWrite: latest.cacheWriteTokens,
        output: latest.outputTokens,
      }), latestPoint ? latestPoint.prices : prices).total
    : 0

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
      // 折叠视角比不折叠多付的首次上行，按来源拆开：检查点 / 召回原文 / 分段目录与检索 / 重要消息。
      // 分段目录单独一档：它是 fold_recall 的工具结果，同样是新上行、同样按未命中计价，
      // 只是不带原文，混进「召回原文」里就看不出一份大折叠先给了多大的目录。
      pluginOverheadTokens: Math.round(overheadTotals.total),
      pluginOverhead: {
        checkpoint: Math.round(overheadTotals.checkpoint),
        recall: Math.round(overheadTotals.recall),
        probe: Math.round(overheadTotals.probe),
        pin: Math.round(overheadTotals.pin),
      },
      outputTokens: Math.round(sums.output),
      foldedMoney: foldedMoneyParts.total,
      unfoldedMoney: unfoldedMoneyParts.total,
      netSavedMoney: roundMoney(unfoldedMoneyParts.total - foldedMoneyParts.total),
      // 三档金额（折叠后 / 不折叠 / 实测）：峰谷混合时每档由逐轮单价累加而来，
      // 页面直接用它显示，不再拿一组均价乘总 token。
      money: {
        folded: foldedMoneyParts,
        unfolded: unfoldedMoneyParts,
        actual: actualMoneyParts,
      },
      // 实测：只有拿到回报的轮才有；金额按同一套单价结算。
      actualHitTokens: Math.round(actualTotals.hit),
      actualInputTokens: Math.round(actualTotals.input),
      actualOutputTokens: Math.round(actualTotals.output),
      actualMoney: actualMoneyValue,
      actualPromptTokens: withActual.reduce((sum, row) => sum + row.actualPromptTokens, 0),
      actualTurns: withActual.length,
      actualSteps: rows.reduce((sum, row) => sum + (row.actualSteps || 0), 0),
      checkpoints: rows.filter((row) => row.checkpointChars > 0).length,
      // 旧记录缺 unfoldedChars、只能拿折叠后体积当下界的轮数：这些轮的「省下」被低估。
      unfoldedEstimatedTurns: rows.filter((row) => row.unfoldedEstimated).length,
      // 最近一次请求的金额：页面要拿它和估算并排显示。
      latestMoney,
    },
    // 峰谷口径：面板要用它说明「现在按什么价算、峰时溢价多少」。
    // enabled 是设置开关，available 是计价服务此刻是否可用；两者都真才真的乘倍率。
    peak: {
      enabled: peakEnabled,
      available: Boolean(peak && peak.available === true),
      // active=时段真的查得到并已按各自时间戳分峰谷；fallback=服务拿不到、全按峰时保守估算。
      active: peakActive,
      applied: peakApplied,
      fallback: peakFallback,
      degraded: peakDegraded,
      multiplier: peakMultiplier,
      // 服务自己报的倍率只作对照：最终倍数可能来自服务默认，也可能被用户设置覆盖。
      serviceMultiplier: peakNow && typeof peakNow.multiplier === 'number' ? peakNow.multiplier : null,
      period: peakNow ? (peakNow.peak === true ? 'peak' : 'offpeak') : null,
      peak: peakNow ? peakNow.peak === true : null,
      timezone: peakNow && typeof peakNow.timezone === 'string' ? peakNow.timezone : '',
      nextSwitchAt: peakNow && typeof peakNow.nextSwitchAt === 'number' ? peakNow.nextSwitchAt : null,
      nextPeakAt: peakNow && typeof peakNow.nextPeakAt === 'number' ? peakNow.nextPeakAt : null,
      nextOffPeakAt: peakNow && typeof peakNow.nextOffPeakAt === 'number' ? peakNow.nextOffPeakAt : null,
      // 谷时的原因（周末 / 节假日 / 午休 / 夜间）与节假日历覆盖状态：面板用来解释这个时段。
      reason: peakNow && typeof peakNow.reason === 'string' ? peakNow.reason : '',
      calendar: peakNow && peakNow.calendar && typeof peakNow.calendar === 'object'
        ? { covered: peakNow.calendar.covered === false ? false : peakNow.calendar.covered === true ? true : null }
        : null,
      // 有记录的时段分布：多少轮按峰时、多少轮按谷时、多少轮没有时间戳（按峰时保守兜底）。
      turns: { peak: peakCounts.peak, offPeak: peakCounts.offPeak, unknown: peakCounts.unknown },
      // 峰时溢价：同样一批 token 若全按谷时单价会少付多少，三个口径分开给。
      premium: {
        folded: roundMoney(premiumSums.folded),
        unfolded: roundMoney(premiumSums.unfolded),
        actual: roundMoney(premiumSums.actual),
      },
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

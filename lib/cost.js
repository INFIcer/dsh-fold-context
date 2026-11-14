// 折叠的成本模型：把「每轮都要把上下文重发一遍」这件事折算成 token 开销，
// 再拿折叠后的历史和不折叠的历史各算一遍，差值就是净节省。
//
// 关键点（也是和朴素估算不同的地方）：
// 1. 前缀缓存只认「上一次请求里出现过的内容」。折叠会在轮末重写历史，
//    所以上一轮的检查点到本轮第一次请求时是**新内容**（未命中），
//    不能算进命中前缀里。
// 2. 检查点只在下一轮被发送一次，不重复计费；本轮自己的检查点在本轮请求之后才写入。
// 3. 一轮有 k 步，前缀被重发 k 次；轮内新增内容按平均半步处在上下文中。
//
// 单轮成本 = hit * (k * 前缀 + 新增 * (k - 1) / 2) + miss * (新增 + 上一轮检查点)
// 其中 hit 是配置里的 cacheHitRatio（默认 0.25，对应 DeepSeek 缓存价约为未命中的 1/4）。
// 纯函数：输入是 turns.js 的分组 + fold 记录 + 配置，输出是普通对象。

import { estimateChars } from './tokens.js'
import { normalizeUsage, promptTokensOf } from './usage.js'

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp01(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0.25
  return Math.min(1, Math.max(0, number))
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
      })
      index.set(key, copy)
      out.push(copy)
      continue
    }
    seen.steps += num(group.steps)
    seen.chars += num(group.chars)
    seen.checkpointChars += num(group.checkpointChars)
    seen.unfoldedChars += num(group.unfoldedChars)
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

export function buildCost({ groups, folds, config, actual } = {}) {
  const list = mergeTurns(Array.isArray(groups) ? groups : [])
  const foldMap = foldMapOf(folds)
  const currentSystem = currentSystemOf(list)
  const usageByTurn = usageByTurnOf(foldMap)
  const hit = clamp01(config && config.cacheHitRatio)
  const miss = 1 - hit
  const rows = []
  let foldedCum = 0
  let unfoldedCum = 0
  // 插件生效前的那一轮没人折得动（当时还没有载荷），它留在会话历史里，
  // 但请求期压缩器和折叠是两回事：把它单列出来，估算和实测的差才对得上账。
  let legacyChars = 0
  // 上一次请求之后才写进历史的内容：本轮请求里它是未命中。
  let pendingNew = 0

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
    const unfoldedChars = Math.max(0, num(group.unfoldedChars))
    const baseFolded = Math.max(0, foldedCum - pendingNew)
    const baseUnfolded = unfoldedCum

    const perTurn = (baseChars, addedChars, newChars) => {
      const base = tokenOf(baseChars)
      const added = tokenOf(addedChars)
      const fresh = tokenOf(newChars)
      return hit * (steps * base + added * ((steps - 1) / 2)) + miss * (added + fresh)
    }
    const foldedTokens = perTurn(baseFolded, ownChars, pendingNew)
    const unfoldedTokens = perTurn(baseUnfolded, unfoldedChars, 0)
    const usage = usageByTurn.get(group.turn) || null
    rows.push({
      turn: typeof group.turn === 'number' ? group.turn : null,
      steps,
      folded: group.folded === true,
      checkpointChars,
      foldedChars: chars,
      unfoldedChars,
      foldedTokens: Math.round(foldedTokens),
      unfoldedTokens: Math.round(unfoldedTokens),
      netSavedTokens: Math.round(unfoldedTokens - foldedTokens),
      // 这一轮所有步的实际计费输入之和，直接和本行的 foldedTokens 对照。
      actualPromptTokens: usage ? Math.round(promptTokensOf(usage)) : 0,
      actualSteps: usage ? usage.steps : 0,
    })

    foldedCum += chars
    unfoldedCum += unfoldedChars
    // 下一轮请求里，折叠过的一轮只剩检查点是新内容；没折叠的一轮整段都还是新内容。
    pendingNew = group.folded === true ? checkpointChars : chars
  }

  const foldedTokens = rows.reduce((sum, row) => sum + row.foldedTokens, 0)
  const unfoldedTokens = rows.reduce((sum, row) => sum + row.unfoldedTokens, 0)
  const withActual = rows.filter((row) => row.actualPromptTokens > 0)
  // 只有拿到 provider 回报的轮才能和账单比；其余轮不参与这个差值判断。
  const coveredFoldedTokens = withActual.reduce((sum, row) => sum + row.foldedTokens, 0)
  const latest = normalizeLatest(actual)
  const contextFoldedTokens = tokenOf(foldedCum)
  const contextUnfoldedTokens = tokenOf(unfoldedCum)
  const legacyTokens = tokenOf(legacyChars)
  // 估算量的是会话历史；真正上行的那份可能还被请求期压缩器改写过。
  // 口径拆成三段，页面才解释得清「为什么估算比账单大」：
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

  return {
    ok: true,
    hitRatio: hit,
    turns: rows,
    drift,
    totals: {
      turns: rows.length,
      steps: rows.reduce((sum, row) => sum + row.steps, 0),
      foldedTokens,
      unfoldedTokens,
      netSavedTokens: unfoldedTokens - foldedTokens,
      savedRate: unfoldedTokens > 0 ? (unfoldedTokens - foldedTokens) / unfoldedTokens : 0,
      contextFoldedTokens,
      contextUnfoldedTokens,
      legacyTokens,
      actualPromptTokens: withActual.reduce((sum, row) => sum + row.actualPromptTokens, 0),
      coveredFoldedTokens,
      actualTurns: withActual.length,
      actualSteps: rows.reduce((sum, row) => sum + (row.actualSteps || 0), 0),
      checkpoints: rows.filter((row) => row.checkpointChars > 0).length,
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

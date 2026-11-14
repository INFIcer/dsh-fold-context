// 评测纯计算：把一段会话的真实用量与折叠记录折算成可比较的指标。
//
// 口径只有一句：这里所有 token 都是 provider 回报的实测值，不反推、不估算。
// 反事实（不折叠会花多少）在 lib/cost.js 里，那是重放模型，不是账单；
// 评测要能对账，所以只认 usage，缺 usage 的步骤跳过并单独计数。
//
// 质量代理指标只能从折叠记录里读出来：召回次数、同一段被重复召回、跨轮重复调用。
// 它们只说明「模型有没有明显在做重复劳动」，证明不了摘要够不够——
// 真正的质量结论只能靠同任务的开关对照，见 docs/evaluation.md。

import { moneyOf, pricesOf } from './pricing.js'
import { estimateChars } from './tokens.js'

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

// provider 原始回报用 xxxTokens，折叠记录里存的是归一化后的短名；两种都认。
function pick(usage, key, alias) {
  if (!usage || typeof usage !== 'object') return 0
  if (usage[key] !== undefined) return num(usage[key])
  return num(usage[alias])
}

// 一步模型调用的用量；没有 usage（极少见）返回 null，由调用方计缺失。
export function stepUsageOf(event) {
  const data = event && event.data
  const usage = data && data.usage
  if (!usage || typeof usage !== 'object') return null
  const input = pick(usage, 'input', 'inputTokens')
  const cacheRead = pick(usage, 'cacheRead', 'cacheReadTokens')
  const cacheWrite = pick(usage, 'cacheWrite', 'cacheWriteTokens')
  const output = pick(usage, 'output', 'outputTokens')
  if (input + cacheRead + cacheWrite + output === 0) return null
  return { turn: data.turn, step: data.step, input, cacheRead, cacheWrite, output }
}

function recordsOf(kind, records) {
  return (Array.isArray(records) ? records : []).filter((record) => record && record.kind === kind)
}

// 折叠载荷里的一次工具调用：一条 item 的一段以「[调用 名字] 参数」开头。
export function callsOfFolds(records) {
  const calls = []
  for (const record of recordsOf('fold', records)) {
    if (!Array.isArray(record.items)) continue
    for (const item of record.items) {
      const text = String((item && item.text) || '')
      for (const line of text.split('\n')) {
        const match = /^\[调用 ([^\]]+)\] ([\s\S]*)$/.exec(line)
        if (match) calls.push({ turn: record.turn, name: match[1], args: match[2].trim() })
      }
    }
  }
  return calls
}

// 跨轮重复调用：同一个「名字 + 参数」在更早的轮次出现过，这一轮又调了一次。
// 这是折叠导致遗忘最直接的痕迹，但正常任务也会重复跑同一条命令，只能当线索。
export function repeatedCallsOf(calls) {
  const firstTurn = new Map()
  let repeated = 0
  for (const call of calls) {
    const signature = call.name + '\u0000' + call.args
    const seen = firstTurn.get(signature)
    if (seen === undefined) firstTurn.set(signature, call.turn)
    else if (seen !== call.turn) repeated += 1
  }
  return repeated
}

// 一轮的用量汇总。firstInput 是这一轮第一步的未命中量：
// 折叠在轮末改写历史，若前缀缓存被打断，代价会集中在这一步上。
function turnRowsOf(steps) {
  const byTurn = new Map()
  for (const step of steps) {
    if (!byTurn.has(step.turn)) byTurn.set(step.turn, [])
    byTurn.get(step.turn).push(step)
  }
  const rows = []
  for (const [turn, list] of byTurn) {
    list.sort((a, b) => (a.step || 0) - (b.step || 0))
    const first = list[0]
    const last = list[list.length - 1]
    let input = 0
    let cacheRead = 0
    let output = 0
    for (const step of list) {
      input += step.input
      cacheRead += step.cacheRead
      output += step.output
    }
    rows.push({
      turn,
      steps: list.length,
      input,
      cacheRead,
      output,
      firstInput: first.input,
      promptLast: last.input + last.cacheRead,
    })
  }
  rows.sort((a, b) => a.turn - b.turn)
  return rows
}

export function buildSessionEval({ sessionId, events, records, config } = {}) {
  const steps = []
  let missingUsage = 0
  let turnStarts = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue
    if (event.type === 'turn/start') turnStarts += 1
    if (event.type !== 'assistant/message') continue
    const usage = stepUsageOf(event)
    if (!usage) {
      missingUsage += 1
      continue
    }
    steps.push(usage)
  }

  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const step of steps) {
    totals.input += step.input
    totals.cacheRead += step.cacheRead
    totals.cacheWrite += step.cacheWrite
    totals.output += step.output
  }
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite
  const prices = pricesOf(config)
  const money = moneyOf({ hit: totals.cacheRead, input: totals.input + totals.cacheWrite, output: totals.output }, prices)

  const perTurn = turnRowsOf(steps)
  const folds = recordsOf('fold', records)
  const recalls = recordsOf('recall', records)
  const pins = recordsOf('pin', records)

  let foldedChars = 0
  let checkpointChars = 0
  for (const fold of folds) {
    foldedChars += num(fold.chars)
    checkpointChars += String(fold.note || '').length
  }

  // 同一段被召回两次以上：说明摘要没兜住，模型又回去翻原文。
  const recallsById = new Map()
  let recallTokens = 0
  const recallModes = {}
  for (const recall of recalls) {
    const id = String(recall.id || '').trim()
    if (id) recallsById.set(id, (recallsById.get(id) || 0) + 1)
    recallTokens += recall.tokens ? num(recall.tokens) : estimateChars(num(recall.chars))
    const mode = String(recall.mode || 'direct')
    recallModes[mode] = (recallModes[mode] || 0) + 1
  }
  let repeatedRecallFolds = 0
  for (const count of recallsById.values()) if (count > 1) repeatedRecallFolds += 1

  const calls = callsOfFolds(folds)
  const contextMax = steps.reduce((max, step) => Math.max(max, step.input + step.cacheRead), 0)
  // 每轮第一步的未命中占比：折叠有没有把前缀缓存打坏，全看这一项。
  const firstInput = perTurn.reduce((sum, row) => sum + row.firstInput, 0)
  const firstInputShare = totals.input > 0 ? firstInput / totals.input : 0

  return {
    sessionId: String(sessionId || ''),
    turns: turnStarts || perTurn.length,
    steps: steps.length,
    missingUsage,
    promptTokens,
    inputTokens: totals.input,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    outputTokens: totals.output,
    hitRate: promptTokens > 0 ? totals.cacheRead / promptTokens : 0,
    money,
    prices,
    perTurn,
    firstInputShare,
    contextMax,
    contextLast: steps.length ? steps[steps.length - 1].input + steps[steps.length - 1].cacheRead : 0,
    folds: { count: folds.length, chars: foldedChars, checkpointChars },
    recalls: { count: recalls.length, tokens: recallTokens, modes: recallModes, repeatedRecallFolds },
    pins: { count: pins.length, chars: pins.reduce((sum, pin) => sum + String(pin.text || '').length, 0) },
    quality: {
      recallPerTurn: turnStarts > 0 ? recalls.length / turnStarts : 0,
      toolCalls: calls.length,
      repeatedCalls: repeatedCallsOf(calls),
    },
  }
}

// 两个会话的并排对照：ab 是「开了折叠」，b 是「对照」。
// 只做减法，不做显著性判断——样本不够时别假装有结论，docs/evaluation.md 里写了怎么补。
export function compareEvals(a, b) {
  const rows = []
  const add = (label, left, right) => {
    const delta = (left || 0) - (right || 0)
    const pct = right ? delta / right : left ? 1 : 0
    rows.push({ label, a: left || 0, b: right || 0, delta, pct })
  }
  add('轮次', a.turns, b.turns)
  add('步数', a.steps, b.steps)
  add('输入（未命中）', a.inputTokens, b.inputTokens)
  add('输入（命中）', a.cacheReadTokens, b.cacheReadTokens)
  add('输出', a.outputTokens, b.outputTokens)
  add('合计金额', a.money && a.money.total, b.money && b.money.total)
  add('每轮步数', a.turns ? a.steps / a.turns : 0, b.turns ? b.steps / b.turns : 0)
  add('每轮金额', a.turns ? (a.money && a.money.total) / a.turns : 0, b.turns ? (b.money && b.money.total) / b.turns : 0)
  add('召回次数', a.recalls && a.recalls.count, b.recalls && b.recalls.count)
  add('上下文峰值', a.contextMax, b.contextMax)
  return rows
}

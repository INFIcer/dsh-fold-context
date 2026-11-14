#!/usr/bin/env node
// 离线评测：读会话日志里的 provider 实测用量，加上 fold-store 的折叠记录，算出可对账的指标。
//
// 用法：
//   node tools/eval.mjs <会话 id> [<会话 id> ...] [--home <DSH_HOME>] [--json]
//   node tools/eval.mjs --ab <开了折叠的会话> <对照会话>
//   node tools/eval.mjs --list
//
// 为什么不读插件自己的记账：账本里的「不折叠会花多少」是重放估算，
// 这里只认 provider 回报，所以结论能拿去对账。

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FoldStore } from '../lib/store.js'
import { ConfigStore } from '../lib/config.js'
import { buildSessionEval, compareEvals } from '../lib/eval.js'
import { findLogFile, readEvents } from './session-log.mjs'

function parseArgs(argv) {
  const out = { sessionIds: [], homeDir: process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), json: false, list: false, ab: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') {
      out.homeDir = argv[i + 1]
      i += 1
    } else if (arg === '--json') out.json = true
    else if (arg === '--list') out.list = true
    else if (arg === '--ab') out.ab = true
    else out.sessionIds.push(arg)
  }
  return out
}

// token 数按 K / M 报：这个量级下写全数字没人读得下去。
function tokens(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (Math.abs(number) >= 1000000) return (number / 1000000).toFixed(1) + 'M'
  if (Math.abs(number) >= 1000) return (number / 1000).toFixed(1) + 'K'
  return String(Math.round(number))
}

function money(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return '¥' + number.toFixed(2)
}

function pct(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return (number * 100).toFixed(1) + '%'
}

function pad(value, width, left) {
  const text = String(value)
  return left ? text.padStart(width) : text.padEnd(width)
}

function listSessions(homeDir) {
  const root = join(homeDir, 'fold-store')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.jsonl') && !name.includes('.bak-'))
    .map((name) => name.replace(/\.jsonl$/, ''))
    .sort()
}

function evalOf(homeDir, sessionId) {
  const logFile = findLogFile(homeDir, sessionId)
  const events = logFile ? readEvents(logFile) : []
  const store = new FoldStore({ homeDir, sessionId })
  const records = store.readAll()
  const config = new ConfigStore({ homeDir }).load()
  return { ...buildSessionEval({ sessionId, events, records, config }), logFile }
}

function printSession(result) {
  const lines = []
  lines.push('会话 ' + (result.sessionId || '(未命名)'))
  if (!result.logFile) lines.push('  ! 找不到会话日志：只能统计 fold-store 里的记录，用量全是 0')
  lines.push(
    '  轮 ' + result.turns + ' · 步 ' + result.steps +
    (result.missingUsage ? ' · 缺用量 ' + result.missingUsage : '') +
    ' · 折叠 ' + result.folds.count + ' 段（原 ' + tokens(result.folds.chars) + ' 字 / 摘要 ' + tokens(result.folds.checkpointChars) + ' 字）',
  )
  lines.push(
    '  实测 prompt ' + tokens(result.promptTokens) +
    '（未命中 ' + tokens(result.inputTokens) + ' / 命中 ' + tokens(result.cacheReadTokens) + ' / 写 ' + tokens(result.cacheWriteTokens) + '）' +
    ' · 输出 ' + tokens(result.outputTokens) + ' · 命中率 ' + pct(result.hitRate),
  )
  lines.push(
    '  金额 ' + money(result.money.total) +
    '（命中 ' + money(result.money.cacheHit) + ' / 未命中 ' + money(result.money.input) + ' / 输出 ' + money(result.money.output) + '）' +
    ' · 上下文峰值 ' + tokens(result.contextMax) + ' · 末次 ' + tokens(result.contextLast) +
    ' · 轮首步未命中占 ' + pct(result.firstInputShare),
  )
  const modes = Object.keys(result.recalls.modes).sort().map((key) => key + ' ' + result.recalls.modes[key]).join(' / ')
  lines.push(
    '  召回 ' + result.recalls.count + ' 次' + (modes ? '（' + modes + '）' : '') +
    ' · 返回 ' + tokens(result.recalls.tokens) + ' token · 重复召回 ' + result.recalls.repeatedRecallFolds + ' 段' +
    ' · 重要消息 ' + result.pins.count + ' 条 ' + result.pins.chars + ' 字',
  )
  lines.push(
    '  质量线索：召回/轮 ' + result.quality.recallPerTurn.toFixed(2) +
    ' · 跨轮重复调用 ' + result.quality.repeatedCalls + ' / ' + result.quality.toolCalls,
  )
  if (result.perTurn.length) {
    lines.push('')
    lines.push('  ' + pad('turn', 6, true) + ' ' + pad('steps', 6, true) + ' ' + pad('prompt', 10, true) + ' ' + pad('miss', 9, true) + ' ' + pad('output', 9, true) + ' ' + pad('¥', 8, true))
    // 按金额取前 8 轮：绝对值最大的几轮才决定总账。
    const rows = result.perTurn.slice().sort((a, b) => (b.input + b.cacheRead + b.output) - (a.input + a.cacheRead + a.output)).slice(0, 8)
    const prices = result.prices
    for (const row of rows.sort((a, b) => a.turn - b.turn)) {
      const cost = ((row.cacheRead * prices.cacheHit) + (row.input * prices.input) + (row.output * prices.output)) / 1000000
      lines.push(
        '  ' + pad(row.turn, 6, true) + ' ' + pad(row.steps, 6, true) + ' ' + pad(tokens(row.input + row.cacheRead), 10, true) +
        ' ' + pad(tokens(row.input), 9, true) + ' ' + pad(tokens(row.output), 9, true) + ' ' + pad(money(cost), 8, true),
      )
    }
  }
  return lines.join('\n')
}

function printCompare(a, b) {
  const rows = compareEvals(a, b)
  const lines = []
  lines.push('对照：A = ' + (a.sessionId || 'A') + '（开折叠） · B = ' + (b.sessionId || 'B') + '（对照）')
  lines.push('  ' + pad('指标', 14) + ' ' + pad('A', 12, true) + ' ' + pad('B', 12, true) + ' ' + pad('差值', 12, true) + ' ' + pad('变化', 9, true))
  for (const row of rows) {
    const isMoney = row.label.includes('金额')
    const isRatio = row.label.includes('每轮')
    const fmt = (value) => (isMoney ? money(value) : isRatio ? String(Math.round(value * 100) / 100) : tokens(value))
    const delta = isMoney ? money(row.delta) : isRatio ? String(Math.round(row.delta * 100) / 100) : (row.delta > 0 ? '+' : '') + tokens(row.delta)
    const change = row.b ? (row.pct >= 0 ? '+' : '') + (row.pct * 100).toFixed(1) + '%' : '—'
    lines.push('  ' + pad(row.label, 14) + ' ' + pad(fmt(row.a), 12, true) + ' ' + pad(fmt(row.b), 12, true) + ' ' + pad(delta, 12, true) + ' ' + pad(change, 9, true))
  }
  lines.push('')
  lines.push('  差值 = A − B；负数表示开折叠更省。样本只有两个会话时这是观察，不是结论。')
  return lines.join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.list || args.sessionIds.length === 0) {
    const sessions = listSessions(args.homeDir)
    if (!sessions.length) {
      console.log('fold-store 里没有会话：' + join(args.homeDir, 'fold-store'))
      return
    }
    console.log('fold-store 里的会话（' + args.homeDir + '）：')
    for (const id of sessions) console.log('  ' + id)
    if (!args.sessionIds.length) console.log('\n用法：node tools/eval.mjs <会话 id> [--home <DSH_HOME>] [--json]')
    return
  }
  const results = args.sessionIds.map((id) => evalOf(args.homeDir, id))
  if (args.json) {
    console.log(JSON.stringify(args.ab && results.length >= 2 ? { a: results[0], b: results[1], compare: compareEvals(results[0], results[1]) } : results, null, 2))
    return
  }
  if (args.ab && results.length >= 2) {
    console.log(printCompare(results[0], results[1]))
    return
  }
  console.log(results.map(printSession).join('\n\n'))
}

main()

#!/usr/bin/env node
// 补账：把升级前跑过的轮次，从会话日志里补成每轮一条 usage 记录。
//
// 早先实测只跟着折叠记录落盘：关掉总开关、或这一轮短到不值得折，provider 回报就丢了，
// 账本上只剩估算。新版每轮结束都会单独记一条 usage，但升级之前已经跑完的轮次不会自己补。
// 这个工具只读会话日志（与插件运行期无关），把「有 assistant 回报、又还没有 usage 记录」
// 的轮次补上，重复运行不会重复记。
//
// 用法：
//   node tools/usage-backfill.mjs <会话 id> [<会话 id> ...] [--home <DSH_HOME>] [--all] [--dry-run]
//
// 默认只补已经结束的轮次（会话里已经出现过更晚的轮次），正在跑的最后一轮跳过：
// 那一轮的用量还会继续涨，提早写死会把实测记成半截。确认它已经结束后加 --all 再跑一次。

import { basename, dirname, join } from 'node:path'
import { FoldStore } from '../lib/store.js'
import { findLogFile, readEvents } from './session-log.mjs'

function parseArgs(argv) {
  const out = {
    sessionIds: [],
    homeDir: process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'),
    all: false,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') {
      out.homeDir = argv[i + 1]
      i += 1
    } else if (arg === '--all') out.all = true
    else if (arg === '--dry-run') out.dryRun = true
    else out.sessionIds.push(arg)
  }
  return out
}

// 日志里的 assistant/message 都带 usage；按 provider 的轮号把各步加起来。
// 缺 usage 的调用（极少见）不计步，也不编造 token。
export function usageByTurnOf(events) {
  const byTurn = new Map()
  let lastTurn = 0
  for (const event of events) {
    if (!event) continue
    if (event.type === 'turn/start') {
      const turn = Number(event.data && event.data.turn)
      if (Number.isFinite(turn) && turn > lastTurn) lastTurn = turn
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event.data && event.data.usage
    if (!usage) continue
    const turn = Number(event.data.turn)
    if (!Number.isFinite(turn) || turn <= 0) continue
    if (turn > lastTurn) lastTurn = turn
    const row = byTurn.get(turn) || { turn, steps: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    row.steps += 1
    row.input += Number(usage.inputTokens) || 0
    row.cacheRead += Number(usage.cacheReadTokens) || 0
    row.cacheWrite += Number(usage.cacheWriteTokens) || 0
    row.output += Number(usage.outputTokens) || 0
    byTurn.set(turn, row)
  }
  return { byTurn, lastTurn }
}

function backfill(homeDir, sessionId, { all, dryRun }) {
  const logFile = findLogFile(homeDir, sessionId)
  if (!logFile) return { sessionId, logFile: '', added: 0, skipped: 0, reason: '找不到会话日志' }
  // 日志目录名就是宿主登记的会话 id（通常带 session- 前缀）。插件的 store 也用这个名字，
  // 直接拿参数里的纯 uuid 会写到另一个文件，运行期根本读不到。
  const storeId = basename(dirname(logFile)) || sessionId
  const { byTurn, lastTurn } = usageByTurnOf(readEvents(logFile))
  const store = new FoldStore({ homeDir, sessionId: storeId })
  const recorded = new Set()
  for (const record of store.readAll()) {
    if (record && record.kind === 'usage' && typeof record.turn === 'number') recorded.add(record.turn)
  }
  let added = 0
  let skipped = 0
  for (const [turn, usage] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    if (!all && turn >= lastTurn) {
      // 最后一轮还没结束：用量会继续涨，等它关掉再补。
      skipped += 1
      continue
    }
    if (recorded.has(turn)) {
      skipped += 1
      continue
    }
    if (usage.steps <= 0) continue
    const record = { kind: 'usage', turn, at: Date.now(), ...usage }
    if (!dryRun) store.append(record)
    added += 1
  }
  return { sessionId, storeId, logFile, added, skipped, turns: byTurn.size, lastTurn }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.sessionIds.length === 0) {
    console.log('用法：node tools/usage-backfill.mjs <会话 id> [<会话 id> ...] [--home <DSH_HOME>] [--all] [--dry-run]')
    return
  }
  for (const sessionId of args.sessionIds) {
    const result = backfill(args.homeDir, sessionId, args)
    const name = result.sessionId
    if (!result.logFile) {
      console.log(name + '：' + result.reason)
      continue
    }
    console.log(
      name + '（store ' + result.storeId + '）：日志里 ' + result.turns + ' 轮（最后一轮 T' + result.lastTurn + '），' +
      (args.dryRun ? '将补 ' : '补了 ') + result.added + ' 条 usage 记录，跳过 ' + result.skipped + ' 条' +
      (result.added > 0 && !args.all ? '（正在跑的最后一轮默认跳过；结束后加 --all 再跑一次）' : ''),
    )
  }
}

main()

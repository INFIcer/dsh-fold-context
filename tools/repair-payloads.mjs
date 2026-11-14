// 修历史折叠记录的召回载荷：按记录的 startSeq..endSeq 从会话日志重建 items。
//
// 为什么需要：早期版本按 totalChars（思考 + 回复 + 工具输出）给载荷估预算，
// 但载荷里还有两类不进 total 的文本——段内注入的上下文消息、每条工具调用最多 300 字的参数。
// 预算在段尾前花完时就地截断，被丢掉的正好是最后几步与最终回复：召回长轮次只看到过程、看不到结论。
// 写入侧已经改成不估预算（lib/commit.js），这份脚本负责把旧记录补齐。
//
// 用法：node tools/repair-payloads.mjs <sessionId> [--home <DSH_HOME>] [--dry-run]

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConfigStore } from '../lib/config.js'
import { FoldStore } from '../lib/store.js'
import { recallItems } from '../lib/fold-text.js'
import { findLogFile, readEvents, SURFACE_TYPES } from './session-log.mjs'

function parseArgs(argv) {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const out = { sessionId: '', homeDir: home, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') { out.homeDir = argv[i + 1]; i += 1 }
    else if (arg === '--dry-run') out.dryRun = true
    else if (!out.sessionId) out.sessionId = arg
  }
  return out
}

// 记录里已有的工具结果说明当初就收了，重建时不能反过来丢掉。
function hasToolItems(record) {
  return (record.items || []).some((item) => String(item.text || '').startsWith('[工具结果] '))
}

// 区间里应该进载荷的节点 seq：整段原样覆盖，工具结果按记录原样保留或丢弃。
export function expectedSeqs(record, bySeq, includeToolOutputs) {
  const seqs = []
  for (let seq = record.startSeq; seq <= record.endSeq; seq += 1) {
    const event = bySeq.get(seq)
    if (!event || !SURFACE_TYPES.has(event.type)) continue
    if (event.type === 'tool/result' && includeToolOutputs === false) continue
    seqs.push(seq)
  }
  return seqs
}

export function rebuildItems(record, bySeq, includeToolOutputs) {
  const nodes = expectedSeqs(record, bySeq, includeToolOutputs)
    .map((seq) => bySeq.get(seq))
    .filter(Boolean)
  // 预算交给召回时控制（maxRecallChars），写入侧不设上限，否则又会从尾部截断。
  return recallItems(nodes, Number.MAX_SAFE_INTEGER, includeToolOutputs)
}

function charsOf(items) {
  return (items || []).reduce((sum, item) => sum + String(item.text || '').length, 0)
}

// 只改「载荷不完整」的记录：节点 seq 有缺口的才重建，完整的原样返回。
export function planRepair({ records, bySeq, includeToolOutputs = true }) {
  const next = []
  const changes = []
  for (const record of records) {
    if (!record || record.kind !== 'fold') { next.push(record); continue }
    const includeTools = includeToolOutputs !== false || hasToolItems(record)
    const expected = expectedSeqs(record, bySeq, includeTools)
    const have = new Set((record.items || []).map((item) => item.seq))
    const missing = expected.filter((seq) => !have.has(seq))
    if (missing.length === 0) { next.push(record); continue }
    const items = rebuildItems(record, bySeq, includeTools)
    if (items.length <= (record.items || []).length) { next.push(record); continue }
    changes.push({
      id: record.id,
      turn: record.turn,
      before: (record.items || []).length,
      after: items.length,
      missing: missing.length,
      addedChars: charsOf(items) - charsOf(record.items),
    })
    next.push({ ...record, items })
  }
  return { records: next, changes }
}

function lineOf(record) {
  return JSON.stringify(record)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.sessionId) {
    console.error('用法：node tools/repair-payloads.mjs <sessionId> [--home <DSH_HOME>] [--dry-run]')
    process.exitCode = 2
    return
  }
  const logFile = findLogFile(args.homeDir, args.sessionId)
  if (!logFile) {
    console.error('找不到会话日志：' + args.sessionId)
    process.exitCode = 1
    return
  }
  const bySeq = new Map(readEvents(logFile).map((event) => [event.seq, event]))
  const storeFile = new FoldStore({ homeDir: args.homeDir, sessionId: args.sessionId }).filePath
  let raw = ''
  try {
    raw = readFileSync(storeFile, 'utf8')
  } catch {
    console.error('读不到载荷文件：' + storeFile)
    process.exitCode = 1
    return
  }
  const lines = raw.split('\n').filter((line) => line.trim())
  const parsed = []
  const changes = []
  const config = new ConfigStore({ homeDir: args.homeDir }).load({})
  let folds = 0
  for (const line of lines) {
    let record = null
    try {
      record = JSON.parse(line)
    } catch {
      parsed.push(line)
      continue
    }
    if (!record || record.kind !== 'fold') {
      parsed.push(line)
      continue
    }
    folds += 1
    const one = planRepair({ records: [record], bySeq, includeToolOutputs: config.foldToolOutputs })
    changes.push(...one.changes)
    parsed.push(lineOf(one.records[0]))
  }

  console.log('日志：' + logFile)
  console.log('载荷：' + storeFile)
  console.log('折叠记录 ' + folds + ' 条，需要修复 ' + changes.length + ' 条')
  for (const change of changes) {
    console.log('  ' + change.id + '（第 ' + change.turn + ' 轮）：补齐 ' + change.missing + ' 个节点，' + change.before + ' -> ' + change.after + ' 段，+' + change.addedChars + ' 字')
  }
  if (changes.length === 0 || args.dryRun) return

  const backup = storeFile + '.bak-' + Date.now()
  copyFileSync(storeFile, backup)
  writeFileSync(storeFile, parsed.join('\n') + '\n', 'utf8')
  console.log('已写入，备份：' + backup)
}

// 直接运行才执行；测试要 import planRepair / rebuildItems，不能顺手改盘。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

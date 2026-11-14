// 离线把一份会话日志渲染成逐轮报告的 HTML。
// 用途：没有宿主进程（或宿主还跑着旧代码）时也能检查报告长什么样。
// 用法：node tools/render-report.mjs <sessionId> [--home C:/Users/x/.dsh] [--out <file>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { FoldStore } from '../lib/store.js'
import { ConfigStore } from '../lib/config.js'
import { buildHtmlReport, buildReportModel, buildTextReport, collectRecords, writeReport } from '../lib/inspect.js'

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function parseArgs(argv) {
  const out = { sessionId: '', homeDir: process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), outFile: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') { out.homeDir = argv[i + 1]; i += 1 }
    else if (arg === '--out') { out.outFile = argv[i + 1]; i += 1 }
    else if (!out.sessionId) out.sessionId = arg
  }
  return out
}

// 会话日志是多帧 zstd：每帧一个魔数，逐帧解压再拼回文本。
function decodeFrames(raw) {
  const offsets = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) offsets.push(i)
  }
  let text = ''
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length
    try {
      text += zstdDecompressSync(raw.subarray(offsets[k], end)).toString('utf8')
    } catch {
      // 假魔数（压缩流里正好出现四字节魔数）：跳过这一帧即可。
    }
  }
  return text
}

function findLogFile(homeDir, sessionId) {
  const root = join(homeDir, 'sessions')
  if (!existsSync(root)) return ''
  const bare = String(sessionId).replace(/^session-/, '')
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, 'session-' + bare, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function readEvents(logFile) {
  const lines = decodeFrames(readFileSync(logFile)).split('\n')
  const events = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed.seq === 'number') events.push(parsed)
    } catch {
      // 半行（进程被打断）直接丢弃。
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return events
}

// 重放 surfaceOp：append 追加节点，replace 用新节点替换 [startSeq, endSeq] 区间。
function replaySurface(events) {
  const nodes = []
  for (const event of events) {
    if (!SURFACE_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (op && op.op === 'replace') {
      const startIdx = nodes.indexOf(op.startSeq)
      const endIdx = nodes.indexOf(op.endSeq)
      if (startIdx < 0 || endIdx < 0) continue
      nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    } else {
      nodes.push(event.seq)
    }
  }
  return nodes
}

function deriveMessages(events, nodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const messages = []
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (!event) continue
    const message = event.type === 'user/message' ? event.data : event.data && event.data.message
    if (!message || !Array.isArray(message.content)) continue
    if (event.type !== 'user/message' && message.content.length === 0) continue
    messages.push(message)
  }
  return messages
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.sessionId) {
    console.error('用法：node tools/render-report.mjs <sessionId> [--home <DSH_HOME>] [--out <file>]')
    process.exitCode = 2
    return
  }
  const logFile = findLogFile(args.homeDir, args.sessionId)
  if (!logFile) {
    console.error('找不到会话日志：' + args.sessionId)
    process.exitCode = 1
    return
  }
  const events = readEvents(logFile)
  const nodes = replaySurface(events)
  const derivedMessages = deriveMessages(events, nodes)
  const store = new FoldStore({ homeDir: args.homeDir, sessionId: args.sessionId })
  const records = collectRecords(store)
  const config = new ConfigStore({ homeDir: args.homeDir }).load({})
  const model = buildReportModel({
    sessionId: args.sessionId,
    derivedMessages,
    folds: records.folds,
    pins: records.pins,
    recalls: records.recalls,
    config,
    now: Date.now(),
  })
  const html = buildHtmlReport(model)
  const filePath = writeReport(args.homeDir, { sessionId: args.sessionId, html })
  if (args.outFile) writeFileSyncSafe(args.outFile, html)
  console.log('日志：' + logFile)
  console.log('事件 ' + events.length + ' 条，surface ' + nodes.length + ' 节点，派生消息 ' + derivedMessages.length + ' 条')
  console.log('报告：' + filePath)
  console.log('')
  console.log(buildTextReport(model))
}

function writeFileSyncSafe(filePath, text) {
  try {
    writeFileSync(filePath, text, 'utf8')
  } catch (error) {
    console.error('写出失败：' + (error && error.message))
  }
}

main()

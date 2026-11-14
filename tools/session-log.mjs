// 会话日志读取：session.v4.jsonl.zstd 是多帧 zstd（每帧一次 append），要按魔数逐帧解压。
// 只给离线工具用——插件运行期不读日志（eventAt / snapshotEvents 已弃用，宿主禁止新增调用）。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function decodeFrames(raw) {
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

export function findLogFile(homeDir, sessionId) {
  const root = join(homeDir, 'sessions')
  if (!existsSync(root)) return ''
  const bare = String(sessionId || '').replace(/^session-/, '')
  if (!bare) return ''
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, 'session-' + bare, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return ''
}

export function readEvents(logFile) {
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
export function replaySurface(events) {
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

export function deriveMessages(events, nodes) {
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

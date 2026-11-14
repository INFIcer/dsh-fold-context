// 折叠载荷的存放处：$DSH_HOME/fold-store/<会话>.jsonl，一行一条记录。
//
// 为什么不用会话日志：宿主没有稳定的「按 seq 读日志」接口（eventAt/snapshotEvents 已弃用），
// 而召回必须取回原文，所以由插件自己持久化。代价是 fork 出的新会话读不到父会话载荷，
// 召回会返回 not_found——已知且可接受的降级。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { storeDirName } from './constants.js'

// 会话 id 直接进文件名不安全：只留字母数字与 ._-，其余折成下划线；取尾部 80 字防超长。
export function safeFileName(sessionId) {
  const raw = String(sessionId || 'unknown')
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_')
  const tail = cleaned.slice(-80)
  return tail || 'unknown'
}

export class FoldStore {
  constructor({ homeDir, sessionId, dir }) {
    this.dir = dir || join(homeDir, storeDirName)
    this.filePath = join(this.dir, safeFileName(sessionId) + '.jsonl')
  }

  append(record) {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8')
      return true
    } catch {
      // 写不进去只影响召回，不能影响会话本身。
      return false
    }
  }

  // 坏行（写到一半被杀）直接跳过：返回的永远是能解析的完整记录。
  readAll() {
    let text = ''
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const record = JSON.parse(trimmed)
        if (record && typeof record === 'object') out.push(record)
      } catch {
        // 半行就丢。
      }
    }
    return out
  }

  folds() {
    const map = new Map()
    for (const record of this.readAll()) {
      if (record.kind === 'fold' && typeof record.id === 'string') map.set(record.id, record)
    }
    return map
  }

  findFold(id) {
    return this.folds().get(String(id))
  }

  recallCount(id) {
    const key = String(id)
    let count = 0
    for (const record of this.readAll()) {
      if (record.kind === 'recall' && record.id === key) count += 1
    }
    return count
}

  pins() {
    const out = []
    for (const record of this.readAll()) {
      if (record.kind === 'pin' && typeof record.text === 'string') out.push(record)
    }
    return out
  }

  appendRecall(id) {
    return this.append({ kind: 'recall', id: String(id), at: Date.now() })
  }
}

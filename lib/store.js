// 折叠载荷的存放处：$DSH_HOME/fold-store/<会话>.jsonl，一行一条记录。
//
// 为什么不用会话日志：宿主没有稳定的「按 seq 读日志」接口（eventAt/snapshotEvents 已弃用），
// 而召回必须取回原文，所以由插件自己持久化。代价是 fork 出的新会话读不到父会话载荷，
// 召回会返回 not_found——已知且可接受的降级。
//
// 性能：文件只在第一次访问时解析一次，之后所有读都走内存；append 追加一行并同步更新内存。
// 早先每个 findFold/recallCount 都重读并 JSON.parse 整个文件，而且是在 turn-stopping 的同步路径上，
// 会话越长轮末阻塞越久。
//
// 容量：超过 maxStoreTokens（每会话）时，从最旧的 fold 载荷开始清理（pin 与召回记录保留），
// 清理过的编号记在一条 prune 记录里，召回时能区分「被清理」与「从来没有过」。
// 最新的一条 fold 无论多大都保留：它最可能被召回。

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { storeDirName } from './constants.js'

export const DEFAULT_MAX_STORE_CHARS = 8000000

// 会话 id 直接进文件名不安全：只留字母数字与 ._-，其余折成下划线；取尾部 80 字防超长。
export function safeFileName(sessionId) {
  const raw = String(sessionId || 'unknown')
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_')
  const tail = cleaned.slice(-80)
  return tail || 'unknown'
}

function recordSize(record) {
  try {
    return JSON.stringify(record).length + 1
  } catch {
    return 0
  }
}

export class FoldStore {
  constructor({ homeDir, sessionId, dir, maxChars }) {
    this.dir = dir || join(homeDir, storeDirName)
    this.filePath = join(this.dir, safeFileName(sessionId) + '.jsonl')
    this.maxCharsOf = typeof maxChars === 'function'
      ? maxChars
      : () => (typeof maxChars === 'number' ? maxChars : DEFAULT_MAX_STORE_CHARS)
    this.records = null
    this.pruned = new Set()
    this.size = 0
    this.needsNewline = false
  }

  // 第一次访问时把整份文件读进内存；坏行（写到一半被杀）直接跳过。
  load() {
    if (this.records) return this.records
    let text = ''
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      this.records = []
      this.size = 0
      return this.records
    }
    const records = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const record = JSON.parse(trimmed)
        if (record && typeof record === 'object') records.push(record)
      } catch {
        // 半行就丢。
      }
    }
    this.records = records
    this.size = text.length
    this.needsNewline = text.length > 0 && !text.endsWith('\n')
    for (const record of records) {
      if (record.kind !== 'prune' || !Array.isArray(record.ids)) continue
      for (const id of record.ids) this.pruned.add(String(id))
    }
    return this.records
  }

  // 返回副本：调用方排序、装饰记录时不会改到索引里的对象。
  readAll() {
    return this.load().slice()
  }

  append(record) {
    try {
      this.load()
      mkdirSync(this.dir, { recursive: true })
      // 上一次写到一半留下的半行：先补一个换行，别让新记录接在半行后面一起坏掉。
      const prefix = this.needsNewline && this.size > 0 ? '\n' : ''
      const line = JSON.stringify(record) + '\n'
      appendFileSync(this.filePath, prefix + line, 'utf8')
      this.size += (prefix + line).length
      this.needsNewline = false
      this.records.push(record)
      this.prune()
      return true
    } catch {
      // 写不进去只影响召回，不能影响会话本身。
      return false
    }
  }

  // 超上限时重写文件：保留全部 pin/recall/未知记录，fold 载荷从新到旧装，装不下的编号记进 prune。
  prune() {
    const maxChars = Number(this.maxCharsOf())
    if (!(maxChars > 0) || this.size <= maxChars) return
    const records = this.records
    const fixed = []
    const folds = []
    for (const record of records) {
      if (!record || typeof record !== 'object') continue
      if (record.kind === 'prune') continue
      if (record.kind === 'fold') folds.push(record)
      else fixed.push(record)
    }
    let budget = maxChars - fixed.reduce((sum, record) => sum + recordSize(record), 0)
    const keepFold = new Set()
    const prunedIds = []
    for (let i = folds.length - 1; i >= 0; i -= 1) {
      const record = folds[i]
      const size = recordSize(record)
      // 最新的一条 fold 无条件保留：它最可能被召回，宁可让文件略超上限。
      if (keepFold.size === 0 || size <= budget) {
        keepFold.add(record)
        budget -= size
      } else {
        prunedIds.push(String(record.id || ''))
      }
    }
    if (prunedIds.length === 0) return
    for (const id of prunedIds) this.pruned.add(id)
    const kept = []
    for (const record of records) {
      if (!record || typeof record !== 'object' || record.kind === 'prune') continue
      if (record.kind === 'fold' && !keepFold.has(record)) continue
      kept.push(record)
    }
    // 合并历史 pruned ids：只写本轮的话，重启后 isPruned 只认识最后一批，
    // 更早被清理的折叠会被误报成「从来没有过」。
    kept.push({ kind: 'prune', ids: [...this.pruned], at: Date.now() })
    const text = kept.map((record) => JSON.stringify(record)).join('\n') + '\n'
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, this.filePath)
    this.records = kept
    this.size = text.length
    this.needsNewline = false
  }

  folds() {
    const map = new Map()
    for (const record of this.load()) {
      if (record.kind === 'fold' && typeof record.id === 'string') map.set(record.id, record)
    }
    return map
  }

  findFold(id) {
    const key = String(id)
    for (const record of this.load()) {
      if (record.kind === 'fold' && record.id === key) return record
    }
    return undefined
  }

  // 载荷是否因为容量上限被清理过：召回时要能区分「清理」与「从来没有」。
  isPruned(id) {
    this.load()
    return this.pruned.has(String(id))
  }

  recallCount(id) {
    const key = String(id)
    let count = 0
    for (const record of this.load()) {
      // 目录查询与关键词检索只花 token、不返回原文，不算「内容召回」；固化提醒只数后者。
      if (record.kind !== 'recall' || record.id !== key) continue
      if (record.mode === 'index' || record.mode === 'search') continue
      count += 1
    }
    return count
  }

  // 同一句话重复发布会写多条记录（模型重发、重启后重放都算），
  // 这里按 label 去重：保留最后一条（内容最新），顺序沿用第一次出现的位置。
  pins() {
    const out = new Map()
    for (const record of this.load()) {
      if (record.kind === 'pin' && typeof record.text === 'string') out.set(String(record.id || ''), record)
    }
    return [...out.values()]
  }

  // 召回记录带上轮次与返回正文字数，统计页才能把召回成本算到正确的轮上。
  // 旧记录没有这两个字段，统计时会退回「按被召回折叠所在的轮」估算。
  appendRecall(id, extra) {
    const detail = extra && typeof extra === 'object' ? extra : {}
    const record = { kind: 'recall', id: String(id), at: Date.now() }
    if (typeof detail.turn === 'number' && Number.isFinite(detail.turn) && detail.turn > 0) record.turn = Math.floor(detail.turn)
    if (typeof detail.chars === 'number' && Number.isFinite(detail.chars) && detail.chars > 0) record.chars = Math.floor(detail.chars)
    if (typeof detail.tokens === 'number' && Number.isFinite(detail.tokens) && detail.tokens > 0) record.tokens = Math.floor(detail.tokens)
    if (typeof detail.mode === 'string' && detail.mode.length > 0) record.mode = detail.mode
    return this.append(record)
  }
}

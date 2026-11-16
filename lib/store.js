// 折叠载荷的存放处：$DSH_HOME/fold-store/<会话>.jsonl，一行一条记录。
//
// 为什么不用会话日志：宿主没有稳定的「按 seq 读日志」接口（eventAt/snapshotEvents 已弃用），
// 而召回必须取回原文，所以由插件自己持久化。
// fork 出的会话从父会话继承检查点（seed 里带着父会话的折叠编号），载荷却写在父会话的文件里：
// 单条读取（findFold/isPruned）沿 parentSession 只读回退到父 store，账本汇总与写入仍只算本会话。
//
// 性能：文件只在第一次访问时解析一次，之后所有读都走内存；append 追加一行并同步更新内存。
// 早先每个 findFold/recallCount 都重读并 JSON.parse 整个文件，而且是在 turn-stopping 的同步路径上，
// 会话越长轮末阻塞越久。
//
// 容量：超过 maxStoreTokens（每会话）时，从最旧的 fold 载荷开始清理（pin 与召回记录保留），
// 清理过的编号记在一条 prune 记录里，召回时能区分「被清理」与「从来没有过」。
// 最新的一条 fold 无论多大都保留：它最可能被召回。

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { storeDirName } from './constants.js'

export const DEFAULT_MAX_STORE_CHARS = 8000000

// 文件指纹：mtime + 字节数。两个都看是为了不漏掉「同一毫秒内写完、大小却变了」的追加。
function fileStamp(path) {
  try {
    const stat = statSync(path)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

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
  constructor({ homeDir, sessionId, dir, maxChars, parentStoreOf, hasParentOf }) {
    this.sessionId = String(sessionId || '')
    this.dir = dir || join(homeDir, storeDirName)
    this.filePath = join(this.dir, safeFileName(sessionId) + '.jsonl')
    // 父 store 解析：返回父会话的 FoldStore，没有父会话或解析不了时返回 null。
    // hasParentOf 只回答「宿主说这个会话有父会话吗」，用来区分「没有父会话」与「父会话不可达」。
    this.parentStoreOf = typeof parentStoreOf === 'function' ? parentStoreOf : null
    this.hasParentOf = typeof hasParentOf === 'function' ? hasParentOf : null
    this.maxCharsOf = typeof maxChars === 'function'
      ? maxChars
      : () => (typeof maxChars === 'number' ? maxChars : DEFAULT_MAX_STORE_CHARS)
    this.records = null
    this.pruned = new Set()
    this.size = 0
    // 文件指纹：mtime 与字节数。外部进程（补账工具、手工修复）改动文件后靠它发现。
    this.fileBytes = 0
    this.mtimeMs = 0
    this.needsNewline = false
  }

  // 第一次访问时把整份文件读进内存；坏行（写到一半被杀）直接跳过。
  // 文件也可能被外部进程改（tools/usage-backfill.mjs 补账、手工修复），所以每次访问先比一次
  // 指纹：变了就重读。只多一次 stat，正常路径（本实例自己 append）不会触发重解析。
  load() {
    if (this.records && !this.changedOnDisk()) return this.records
    let text = ''
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      this.records = []
      this.size = 0
      this.fileBytes = 0
      this.mtimeMs = 0
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
    const stamp = fileStamp(this.filePath)
    this.fileBytes = stamp.size
    this.mtimeMs = stamp.mtimeMs
    this.needsNewline = text.length > 0 && !text.endsWith('\n')
    for (const record of records) {
      if (record.kind !== 'prune' || !Array.isArray(record.ids)) continue
      for (const id of record.ids) this.pruned.add(String(id))
    }
    return this.records
  }

  changedOnDisk() {
    const stamp = fileStamp(this.filePath)
    if (stamp.mtimeMs === 0 && this.mtimeMs === 0) return false
    return stamp.mtimeMs !== this.mtimeMs || stamp.size !== this.fileBytes
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
      const stamp = fileStamp(this.filePath)
      this.fileBytes = stamp.size
      this.mtimeMs = stamp.mtimeMs
      this.needsNewline = false
      this.records.push(record)
      this.prune()
      return true
    } catch {
      // 写不进去只影响召回，不能影响会话本身。
      return false
    }
  }

  // 整份重写：删除一条记录没法靠追加完成，只能写临时文件再原子替换。
  // 调用方保证 records 已经是完整的新内容（含那条合并后的 prune 记录）。
  rewrite(records) {
    const text = records.length === 0 ? '' : records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    mkdirSync(this.dir, { recursive: true })
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, this.filePath)
    this.records = records
    this.size = text.length
    const stamp = fileStamp(this.filePath)
    this.fileBytes = stamp.size
    this.mtimeMs = stamp.mtimeMs
    this.needsNewline = false
  }

  // 撤回一条还没被检查点引用的载荷：检查点写入失败时它就成了孤儿，留着还会永久占用
  // 同一个编号（之后同一轮再折会撞号跳过）。返回是否已确认库里没有这条记录。
  remove(id) {
    try {
      this.load()
      const key = String(id)
      const kept = this.records.filter((record) => !(record && record.kind === 'fold' && record.id === key))
      if (kept.length === this.records.length) return true
      this.rewrite(kept)
      return true
    } catch {
      // 重写失败时内存里的记录已经不可信：让调用方知道这条孤儿还在。
      return false
    }
  }

  // 轮内发布、还没注入会话的重要消息：先落一条 pending 记录，注入成功后才删。
  // 进程退出、运行时被淘汰、插件 stop 都会丢掉内存队列，靠这条记录才能补投。
  pendingPins() {
    const out = []
    for (const record of this.load()) {
      if (record && record.kind === 'pin-pending' && typeof record.pid === 'string') out.push(record)
    }
    return out
  }

  resolvePending(pid) {
    try {
      this.load()
      const key = String(pid)
      const kept = this.records.filter((record) => !(record && record.kind === 'pin-pending' && record.pid === key))
      if (kept.length === this.records.length) return true
      this.rewrite(kept)
      return true
    } catch {
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
    this.rewrite(kept)
  }

  folds() {
    const map = new Map()
    for (const record of this.load()) {
      if (record.kind === 'fold' && typeof record.id === 'string') map.set(record.id, record)
    }
    return map
  }

  // 父 store 只读回退：seen 防环（正常父子链是 DAG，防御自引用与重复构造）。
  parentStore(seen) {
    if (!this.parentStoreOf) return null
    let parent = null
    try {
      parent = this.parentStoreOf(this.sessionId)
    } catch {
      return null
    }
    if (!parent || parent === this) return null
    if (seen && seen.has(parent)) return null
    return parent
  }

  // 这个会话声明了父会话，但父 store 现在拿不到：召回失败时要说「暂时读不到」，不能说「从来没有过」。
  parentUnreachable() {
    if (!this.hasParentOf) return false
    let declared = false
    try {
      declared = Boolean(this.hasParentOf(this.sessionId))
    } catch {
      declared = false
    }
    if (!declared) return false
    return this.parentStore(new Set()) === null
  }

  findFold(id) {
    return this.findFoldIn(String(id), new Set())
  }

  findFoldIn(id, seen) {
    seen.add(this)
    for (const record of this.load()) {
      if (record.kind === 'fold' && record.id === id) return record
    }
    const parent = this.parentStore(seen)
    return parent ? parent.findFoldIn(id, seen) : undefined
  }

  // 载荷是否因为容量上限被清理过：召回时要能区分「清理」与「从来没有」。
  isPruned(id) {
    return this.isPrunedIn(String(id), new Set())
  }

  isPrunedIn(id, seen) {
    seen.add(this)
    this.load()
    if (this.pruned.has(id)) return true
    const parent = this.parentStore(seen)
    return parent ? parent.isPrunedIn(id, seen) : false
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

// 「重要消息」在账本里到底占多少：以模型此刻看得见的那几条为准。
//
// store 里的 pin 记录只证明「这条消息发布过」。它和上下文会漂移：
// 载荷可能被整理、pin 可能被官方压缩卷走、补投可能还没落盘。
// 只按记录计费时，账本会给模型看不到的内容收钱（pinsLost 只用来显示、不减少成本），
// 也会漏掉还在上下文里的那些：实测本会话账本 389 token、模型视角 3.8k token，差一个数量级。
//
// 所以判定顺序是：
// 1. surface（派生消息里 source.kind = pin 的那些）是准的——它就是上下文里的字；
// 2. 记录只补轮次与发布时间，并把「记录里有、上下文里没了」的标成 present: false；
//    这类记录再分三种，账本分开讲，不然一律报成「被压缩卷走」会误导：
//    duplicate（同标题同正文，上下文里还有另一条）、
//    superseded（同标题不同正文，已被重发的那条取代）、
//    其余才是真被压缩卷走的；
// 3. 上下文里有、记录里没有的标成 recorded: false，同样计入（它确实占着上下文）。
//
// 拿不到会话时 surface 为 null：退回旧口径（按记录算，present = null 表示未知），
// 不硬把「读不到」当成「不存在」。
import { randomUUID } from 'node:crypto'
import { pinPrefix, recentPinPrefix, recentPinSuffix, sourcePin } from './constants.js'

const PIN_HEAD = pinPrefix + ' '

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 近期重要的头带发布轮次，位数不定，所以按行整体匹配、按行整体剥，不能套固定长度公式。
const RECENT_HEAD = new RegExp('^' + escapeRegExp(recentPinPrefix) + '\\d+' + escapeRegExp(recentPinSuffix) + ' ')

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function labelOf(record) {
  return textOf(record && record.id) || textOf(record && record.label) || '重要结论'
}

function levelOfRecord(record) {
  return record && record.level === 'recent' ? 'recent' : 'permanent'
}

function firstLineOf(text) {
  const full = textOf(text)
  const end = full.indexOf('\n')
  return end < 0 ? full : full.slice(0, end)
}

// 只认这两种头，而且要求头后面跟一个空格。正文里引用过同样的字样不会被误剥，
// 除非它长得和真实头一模一样——那种情况下本来也分不出是引用还是头。
function hasPinHead(line) {
  return line.startsWith(PIN_HEAD) || RECENT_HEAD.test(line)
}

// 一条 pin 消息的首行头。省略 level 或传 permanent 时与旧版完全一致；
// recent 把发布轮次写进头里，模型据此跟当前检查点的轮次比较，判断这条是否已经隔了几轮。
export function pinHeadOf({ label, level, turn } = {}) {
  const name = textOf(label)
  if (level === 'recent') {
    // 轮次未知时写 0，不假装是第 1 轮。
    const n = typeof turn === 'number' && Number.isFinite(turn) && turn > 0 ? Math.floor(turn) : 0
    return recentPinPrefix + n + recentPinSuffix + ' ' + name
  }
  return PIN_HEAD + name
}

// 一条 pin 就是一条 user 消息：头一行是头 + 标题，其后是正文。
// 头是模型认出「这条不是用户刚说的话」的唯一依据，两种 level 的头必须都能精确解析。
export function createPinMessage({ label, text, level, turn }) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: pinHeadOf({ label, level, turn }) + '\n' + textOf(text) }],
    source: { kind: sourcePin, label },
  }
}

// surface 给的是整条消息，store 里只有正文：首行是已知头就剥掉整行，剩下的才是正文。
// 旧消息只有 permanent 头，新消息可能是 recent 头，两者都认；其余原样返回。
export function pinBodyOf(text) {
  const full = textOf(text)
  if (!full) return ''
  const line = firstLineOf(full)
  if (!hasPinHead(line)) return full
  return full.length === line.length ? '' : full.slice(line.length + 1)
}

// 一条消息属于哪种 level：只看头。没有头的正文按 permanent（旧记录没有 level，也按它算）。
export function pinLevelOfText(text) {
  return RECENT_HEAD.test(firstLineOf(text)) ? 'recent' : 'permanent'
}

// 一条 pin 消息的完整字长：实际的头（含 recent 的轮次位数）+ 换行 + 正文。
// 记录只有正文，所以要从这个形状倒推；surface 有整条消息，直接用它的长度。
export function pinCharsOf(label, body, level, turn) {
  return pinHeadOf({ label, level, turn }).length + 1 + textOf(body).length
}

// surface 可能是三种形状：宿主给的 {label, text} 数组、旧调用方传的 label 集合、null（未知）。
function surfaceOf(surface) {
  if (!surface) return null
  if (surface instanceof Set) return { labels: surface, entries: null }
  if (!Array.isArray(surface)) return null
  const entries = []
  for (const item of surface) {
    if (typeof item === 'string') {
      entries.push({ label: item, text: '' })
      continue
    }
    if (!item || typeof item !== 'object') continue
    entries.push({ label: textOf(item.label), text: textOf(item.text) })
  }
  return { labels: null, entries }
}

function fromRecord(record, present) {
  const label = labelOf(record)
  const body = textOf(record.text)
  const level = levelOfRecord(record)
  const turn = num(record.turn)
  return {
    kind: 'pin',
    id: label,
    text: body,
    // 级别只跟着记录与解析结果走（账本/前端不加徽标）；recent 的轮次也在这里带出去。
    level,
    chars: pinCharsOf(label, body, level, turn),
    turn,
    at: num(record.at),
    present,
    recorded: true,
  }
}

// 配对与去重键：标题 + 级别 + 正文。同名同正文的 permanent 与 recent 是两条不同的消息，
// 只按标题配会让它们互相套错，recent 的轮次与头长都会跟着错。
function pinKey(label, level, text) {
  return label + '\u0000' + level + '\u0000' + text
}

function signatureOf(record) {
  return pinKey(labelOf(record), levelOfRecord(record), textOf(record.text))
}

function takeRecord(records, used, label, level) {
  for (let index = 0; index < records.length; index += 1) {
    if (used[index]) continue
    if (labelOf(records[index]) !== label) continue
    if (levelOfRecord(records[index]) !== level) continue
    used[index] = true
    return records[index]
  }
  return null
}

// 逐条配对：先配标题、级别、正文完全一致的，再退一步只按标题 + 级别配。
//
// 顺序不能反。同一标题重发过两次时（订正版），上下文里留的是新版那条消息，
// 记录里新旧两条都在；只按标题取「第一条没用掉的」，会把旧记录配给新消息，
// 于是新记录被判成「被压缩卷走」——明明上下文里就是它的正文。
function pairRecords(records, entries) {
  const used = new Array(records.length).fill(false)
  const pairs = new Array(entries.length).fill(null)
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry.text) continue
    const signature = pinKey(entry.label, pinLevelOfText(entry.text), pinBodyOf(entry.text))
    for (let at = 0; at < records.length; at += 1) {
      if (used[at]) continue
      if (signatureOf(records[at]) !== signature) continue
      used[at] = true
      pairs[index] = records[at]
      break
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (pairs[index]) continue
    const entry = entries[index]
    pairs[index] = takeRecord(records, used, entry.label, pinLevelOfText(entry.text))
  }
  return { pairs, used }
}

export function resolvePins(pins, surface) {
  const records = (Array.isArray(pins) ? pins : []).filter(
    (record) => record && typeof record === 'object' && record.kind === 'pin',
  )
  const view = surfaceOf(surface)
  if (!view) return records.map((record) => fromRecord(record, null))
  const entries = view.entries
    ? view.entries
    : [...view.labels].map((label) => ({ label, text: '' }))
  const { pairs, used } = pairRecords(records, entries)
  const matchedSig = new Set()
  // 「被取代」也按标题 + 级别认：同名但不同级别的消息不算谁取代了谁。
  const visibleKeys = new Set()
  const list = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const record = pairs[index]
    if (record) matchedSig.add(signatureOf(record))
    const full = entry.text
    const label = entry.label || (record ? labelOf(record) : '重要结论')
    // surface 里有整条消息时它才是级别的事实来源；没有才退回记录。
    const level = full ? pinLevelOfText(full) : record ? levelOfRecord(record) : 'permanent'
    visibleKeys.add(pinKey(label, level, ''))
    const turn = record ? num(record.turn) : 0
    // surface 的整条消息就是上下文里的字：它的长度才是要计费的那个数。
    const body = full ? pinBodyOf(full) : record ? textOf(record.text) : ''
    list.push({
      kind: 'pin',
      id: label,
      text: body,
      level,
      chars: full ? full.length : pinCharsOf(label, body, level, turn),
      turn,
      at: record ? num(record.at) : 0,
      present: true,
      recorded: Boolean(record),
    })
  }
  for (let index = 0; index < records.length; index += 1) {
    if (used[index]) continue
    const row = fromRecord(records[index], false)
    // 配对用尽后剩下的记录有三种来源，账本要分清，否则一律报成「被卷走」会误导：
    // 重复（同标题同正文，上下文里明明还有一条）、旧版本（同标题不同正文，已被重发的那条取代）、
    // 真被压缩卷走（上下文里连这个标题都没有了）。
    row.duplicate = matchedSig.has(signatureOf(records[index]))
    row.superseded = !row.duplicate &&
      visibleKeys.has(pinKey(labelOf(records[index]), levelOfRecord(records[index]), ''))
    list.push(row)
  }
  return list
}

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
import { pinPrefix } from './constants.js'

const PIN_HEAD = pinPrefix + ' '

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function labelOf(record) {
  return textOf(record && record.id) || textOf(record && record.label) || '重要结论'
}

// 一条 pin 消息的形状是 `【重要·永不折叠】 标题\n正文`。surface 给的是整条消息，
// 这里剥掉第一行标题，剩下的才是 store 里那个 text 字段。
export function pinBodyOf(text, label) {
  const full = textOf(text)
  if (!full) return ''
  const head = PIN_HEAD + textOf(label)
  if (full === head) return ''
  if (full.startsWith(head + '\n')) return full.slice(head.length + 1)
  const firstLine = full.indexOf('\n')
  if (full.startsWith(PIN_HEAD) && firstLine >= 0) return full.slice(firstLine + 1)
  return full
}

// 一条 pin 消息的完整字长：前缀 + 标题 + 换行 + 正文。
// 记录只有正文，所以要从这个形状倒推；surface 有整条消息，直接用它的长度。
export function pinCharsOf(label, body) {
  return PIN_HEAD.length + textOf(label).length + 1 + textOf(body).length
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
  return {
    kind: 'pin',
    id: label,
    text: body,
    chars: pinCharsOf(label, body),
    turn: num(record.turn),
    at: num(record.at),
    present,
    recorded: true,
  }
}

// 记录与 surface 按标题配对：同一标题可能发布过多次（订正后重发），
// 配对是「一对一先用掉」，所以两条标题相同但内容不同的消息都会各自成行。
// 同一条消息被记了两遍时（重发订正版、旧记录没清掉），两条记录标题与正文完全一致。
// 用它把「重复记录」与「真被压缩卷走」区分开：前者上下文里明明还在。
// 比的是正文本身而不是字数：字数相同的不同内容（订正前/后）不能算重复。
function signatureOf(record) {
  return labelOf(record) + '\u0000' + textOf(record.text)
}

function takeRecord(records, used, label) {
  for (let index = 0; index < records.length; index += 1) {
    if (used[index]) continue
    if (labelOf(records[index]) !== label) continue
    used[index] = true
    return records[index]
  }
  return null
}

// 逐条配对：先配正文完全一致的，再退一步只按标题配。
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
    const signature = entry.label + '\u0000' + pinBodyOf(entry.text, entry.label)
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
    pairs[index] = takeRecord(records, used, entries[index].label)
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
  const visibleLabels = new Set()
  const list = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const record = pairs[index]
    if (record) matchedSig.add(signatureOf(record))
    const full = entry.text
    const label = entry.label || (record ? labelOf(record) : '重要结论')
    visibleLabels.add(label)
    // surface 的整条消息就是上下文里的字：它的长度才是要计费的那个数。
    const body = full ? pinBodyOf(full, entry.label) : record ? textOf(record.text) : ''
    list.push({
      kind: 'pin',
      id: label,
      text: body,
      chars: full ? full.length : pinCharsOf(label, body),
      turn: record ? num(record.turn) : 0,
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
    row.superseded = !row.duplicate && visibleLabels.has(labelOf(records[index]))
    list.push(row)
  }
  return list
}

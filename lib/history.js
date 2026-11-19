// 全量历史账本：按会话事件重放，给每一轮留下「当时的上下文体积」。
//
// 为什么不能只用派生消息：压缩（compaction）会把旧轮从模型视角整段换掉
// （一条 compact-checkpoint 消息 + surfaceOp=replace），派生消息里就只剩最近几轮。
// 可成本要回答的是「这段会话一路重放下来花了多少」——被卷走的那几轮，账已经发生过，
// 不能跟着历史一起消失。事件日志里每一轮的内容都还在，所以从事件重放。
//
// 每一轮记四个量，口径与 turns.js 的分组一致：
//   chars           折叠视角下这一轮留在上下文里的字符数（用户原话 + 检查点摘要）
//   unfoldedChars   不折叠视角下这一轮的字符数（被折掉的原文也算进来）
//   checkpointChars 检查点摘要的字符数（折叠轮才有，下一轮的首次上行按它算）
//   outputChars     模型自己写出来的字符数（思考 + 回复 + 调用参数），与折叠无关
// 另外记这一轮开始时的上下文体积（baseFoldedChars / baseUnfoldedChars）。
// 压缩之后基准会变小，趋势图上就是那个台阶；但之前各轮已经按当时的基准结算过，不再重算。
//
// 纯函数：输入是会话事件 + 折叠记录，输出是 turns.js 同形状的分组数组。

import { asMessage, messageEntries } from './inspect.js'
import { outputCharsOf } from './turns.js'

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function buildHistoryGroups({ events, folds } = {}) {
  const list = Array.isArray(events) ? events : []
  const foldMap = folds instanceof Map ? folds : new Map()
  const groups = []
  // 当前上下文里的节点：{ seq, turn, chars, unfoldedChars, checkpoint }
  // turn 为 null 的是压缩摘要这类不属于任何一轮的内容，只进基准、不进任何一轮的账。
  const nodes = []
  let current = null
  let systemChars = 0

  function liveChars(key) {
    let total = 0
    for (const node of nodes) {
      if (node.turn === null) continue
      total += numberOrZero(node[key])
    }
    return total
  }

  function openTurn(turn, at) {
    current = {
      kind: 'turn',
      turn,
      // 这一轮开始的时间（会话事件里的 time）：成本模型按它判峰谷，历史记录各按各自时刻还原。
      at: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0,
      steps: 0,
      chars: 0,
      unfoldedChars: 0,
      checkpointChars: 0,
      outputChars: 0,
      folded: false,
      hadFold: false,
      originalChars: 0,
      // 这一轮开始时的上下文：系统提示 + 之前各轮（压缩过就按压缩后的体积）。
      baseFoldedChars: systemChars + liveChars('chars'),
      baseUnfoldedChars: systemChars + liveChars('unfoldedChars'),
    }
    groups.push(current)
    return current
  }

  // 结算一轮：折叠视角取「现在还在上下文里的这一轮的节点」，不折叠视角取这一轮的全部原文。
  function finalize(group) {
    if (!group) return
    let chars = 0
    let checkpointChars = 0
    for (const node of nodes) {
      if (node.turn !== group.turn) continue
      chars += numberOrZero(node.chars)
      if (node.checkpoint) checkpointChars += numberOrZero(node.chars)
    }
    // 整轮都被压缩卷走（少见）：内容确实在上下文里存在过，按原文补回来，
    // 不然这一轮会算成 0 字符，页面上看起来像「这一轮没花过钱」。
    if (chars === 0 && group.originalChars > 0) chars = group.originalChars
    group.chars = chars
    group.checkpointChars = checkpointChars
    group.folded = group.hadFold
    group.unfoldedChars = group.hadFold ? group.originalChars : chars
    group.steps = Math.max(1, group.steps)
    // 内部字段不交给成本模型，避免它被当成新口径。
    delete group.hadFold
    delete group.originalChars
    delete group.closed
  }

  for (const event of list) {
    if (!event) continue
    if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') {
      finalize(current)
      openTurn(event.data.turn, event.time)
      continue
    }
    if (event.type === 'step/start') {
      if (current) current.steps += 1
      continue
    }
    if (!SURFACE_TYPES.has(event.type)) continue
    const message = asMessage(event)
    if (!message) continue
    const entry = messageEntries({ derivedMessages: [event], folds: foldMap })[0]
    if (!entry) continue
    if (entry.role === 'system') {
      // 系统提示按最后一条非空的算：请求信封里带的是它，旧版本留在 surface 里不发。
      if (numberOrZero(entry.chars) > 0) systemChars = entry.chars
      continue
    }
    const op = event.surfaceOp
    if (op && op.op === 'replace') {
      const start = nodes.findIndex((node) => node.seq === op.startSeq)
      const end = nodes.findIndex((node) => node.seq === op.endSeq)
      if (start >= 0 && end >= start) nodes.splice(start, end - start + 1)
      else nodes.length = 0
    }
    const node = {
      seq: event.seq,
      turn: current ? current.turn : null,
      chars: entry.chars,
      unfoldedChars: entry.chars,
      checkpoint: entry.isCheckpoint,
    }
    if (entry.isCheckpoint) {
      const items = entry.foldRecord && Array.isArray(entry.foldRecord.items) ? entry.foldRecord.items : []
      if (items.length > 0) {
        let total = 0
        for (const item of items) total += numberOrZero(item && item.chars)
        node.unfoldedChars = total
      }
      if (current) current.hadFold = true
    } else if (current) {
      current.originalChars += numberOrZero(entry.chars)
    }
    if (current && entry.role === 'assistant') current.outputChars += outputCharsOf(entry.blocks)
    nodes.push(node)
  }
  finalize(current)

  // 插件生效前的那几轮：第一个折叠轮之前的历史，没人折得动，成本上单列。
  let firstFolded = -1
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].folded) { firstFolded = i; break }
  }
  if (firstFolded > 0) {
    for (let i = 0; i < firstFolded; i += 1) groups[i].prePlugin = true
  }
  return groups
}

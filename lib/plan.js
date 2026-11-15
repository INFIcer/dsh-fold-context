// 把一轮的 surface 节点切成「可折叠片段」。
//
// 片段从第一条非 keeper 节点开始。keeper 包括用户原话、调度指令、重要消息、上一轮摘要、
// system/message，以及全部上下文注入与开发者消息：一次性注入折掉就永久丢失；会重放的
// 那几种，宿主按「消息还在不在 surface 里」决定要不要再发，折掉省下的量会被完整重发抵消。
// 片段在三种地方断开：keeper 消息、上一步的工具还没回来、或本轮结束。断开的目的是不把
// 「一次工具调用」和它的结果分到两个片段里。

import { isKeeper, messageOf, toolCallsOf } from './fold-text.js'

export function planSegments(nodes) {
  const segments = []
  let current = null

  // pending 是「已发出、还没回来的工具调用」。非空说明当前步没走完，片段必须在这里截断。
  function close() {
    if (!current) return
    let items = current.nodes
    if (current.pending.size > 0) items = items.slice(0, current.stepStart)
    if (items.length > 0) segments.push(items)
    current = null
  }

  for (const node of nodes) {
    if (!node) continue
    // 系统提示词不是片段内容：宿主常在两个被跟踪节点之间 append 一条新的 system/message，
    // 不在这里断开的话，替换区间会把它一起扫进检查点（下一轮宿主虽会补一条，但前缀会多抖一次）。
    if (node.type === 'system/message') {
      close()
      continue
    }
    if (isKeeper(node)) {
      close()
      continue
    }
    if (node.type === 'assistant/message') {
      if (current && current.pending.size > 0) close()
      if (!current) current = { nodes: [], pending: new Set(), stepStart: 0 }
      current.stepStart = current.nodes.length
      current.nodes.push(node)
      for (const call of toolCallsOf(messageOf(node))) {
        if (call.id) current.pending.add(call.id)
      }
      continue
    }
    // 落单的 tool/result 找不到它对应的 assistant，折了反而把配对拆开，直接跳过
    if (node.type === 'tool/result' && !current) continue
    if (!current) current = { nodes: [], pending: new Set(), stepStart: 0 }
    if (node.type === 'tool/result') {
      current.nodes.push(node)
      const message = messageOf(node)
      const callId = message && typeof message.toolCallId === 'string' ? message.toolCallId : ''
      if (callId) current.pending.delete(callId)
      continue
    }
    // 走到这里的节点理论上不存在（user/message 与 developer/message 都是 keeper）：
    // 保守起见仍收进片段，而不是静默跳过。
    current.nodes.push(node)
  }
  close()
  return segments
}

// 片段里最靠前的 assistant 消息决定折叠编号的语义（第几轮的哪一段）。
export function segmentStartSeq(segment) {
  return segment.length > 0 ? segment[0].seq : -1
}

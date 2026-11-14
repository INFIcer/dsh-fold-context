// 把一轮的 surface 节点切成「可折叠片段」。
//
// 片段可以从前导的上下文注入开始：agent-loop 在每轮第一条 assistant 之前插入一条
// runtime-context（或开发者消息），它没有配对约束，折掉后下一轮会自动补回。
// 片段在三种地方断开：keeper 消息（用户原话 / 重要消息 / 上一轮摘要）、上一步的工具还没回来、
// 或本轮结束。断开的目的是不把「一次工具调用」和它的结果分到两个片段里。

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
    // 其它 surface 节点（运行时上下文注入的用户消息、开发者消息）跟当前片段一起折叠：
    // 上下文注入在折叠后由 agent-loop 自动补回，不留残骸。
    current.nodes.push(node)
  }
  close()
  return segments
}

// 片段里最靠前的 assistant 消息决定折叠编号的语义（第几轮的哪一段）。
export function segmentStartSeq(segment) {
  return segment.length > 0 ? segment[0].seq : -1
}

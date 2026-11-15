// 把一轮的 surface 节点切成「可折叠片段」。
//
// 片段从第一条非 keeper 节点开始。keeper 包括用户原话、调度指令、重要消息、上一轮摘要、
// system/message，以及全部上下文注入与开发者消息：一次性注入折掉就永久丢失；会重放的
// 那几种，宿主按「消息还在不在 surface 里」决定要不要再发，折掉省下的量会被完整重发抵消。
// 片段在三种地方断开：keeper 消息、上一步的工具还没回来、或本轮结束。断开的目的是不把
// 「一次工具调用」和它的结果分到两个片段里。
//
// 另有一类步骤整步保留：读文件、写文件、加载技能。技能正文是操作规则，文件与记忆的内容
// 是事实依据，折成摘要后模型会拿着「读过什么」的印象做错事，重读一次并不便宜。判据只看
// 工具名与调用参数，不判断语义；命中时先收掉上一段，这条 assistant 消息与它后面的
// tool/result 都不进片段，因此调用与结果始终成对。

import { isKeeper, messageOf, toolCallsOf } from './fold-text.js'

// 文件 API 的模式清单：本机上的文件操作多半由 run_code 完成（所有工具都走代码执行器），
// 工具名与路径参数都看不出来，只能扫调用参数原文。PowerShell 的 cmdlet 大小写不敏感，
// 统一转小写再比较；带括号的两组也靠括号区分 readFile( 与 readFileSync(。
const FILE_OP_PATTERNS = [
  'tools.read(', 'tools.write(', 'tools.edit(', 'tools.multi_edit(', 'tools.apply_patch(', 'tools.skill(',
  'readfilesync(', 'readfile(', 'writefilesync(', 'writefile(', 'appendfilesync(', 'createreadstream(', 'createwritestream(',
  'get-content', 'set-content', 'add-content', 'out-file', 'new-item',
]

// 清单字段是逗号分隔的字符串；空项与大小写都忽略。
function splitList(value) {
  if (typeof value !== 'string') return []
  const out = []
  for (const item of value.split(',')) {
    const one = item.trim().toLowerCase()
    if (one) out.push(one)
  }
  return out
}

// 路径片段与参数原文按同一口径归一：反斜杠换成 /、连续斜杠压成一个、统一小写。
// JSON 参数里的 Windows 路径是双反斜杠，不归一化就匹配不到 dev-notes/ 这类片段。
function normalizeForMatch(text) {
  return String(text || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
}

// 一次工具调用命中任一判据，整个步骤都保留原文。
function keepsStep(node, plan) {
  const message = messageOf(node)
  for (const call of toolCallsOf(message)) {
    if (plan.tools.has(call.name.toLowerCase())) return true
    const args = normalizeForMatch(call.arguments)
    if (!args) continue
    if (plan.paths.some((fragment) => args.includes(fragment))) return true
    if (plan.fileOps && FILE_OP_PATTERNS.some((pattern) => args.includes(pattern))) return true
  }
  return false
}

export function planSegments(nodes, options) {
  const settings = options || {}
  // 没传选项时按「不保护」处理：清单默认值只维护在 config.js 一处，调用方总是把生效配置传进来。
  const plan = {
    tools: new Set(splitList(settings.keepTools)),
    paths: splitList(settings.keepPaths).map((fragment) => normalizeForMatch(fragment)),
    fileOps: Boolean(settings.keepFileOps),
  }
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
      // 受保护的步骤：收掉上一段后整步跳过。它后面的 tool/result 找不到 current，
      // 走下面「落单 tool/result」的分支自然留在原文里，不需要额外状态。
      if (keepsStep(node, plan)) {
        close()
        continue
      }
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

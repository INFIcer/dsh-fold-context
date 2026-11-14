// 逐轮视图：把「模型视角」的消息整理成大轮，供报告页按轮展示。
//
// 一轮 = 一条用户原话 + 它之后的回复、思考、工具调用、折叠检查点与上下文注入。
// 系统提示词单独成块（它从不折叠，混进某轮会让人以为它被折掉了）；
// 重要消息跟着它出现的位置走，不挪到别处。
// 这里只有纯函数：不读会话、不写盘，输入输出都是普通对象，测试可以单独覆盖。

const MARKERS = [
  { prefix: '[思考] ', kind: 'think' },
  { prefix: '[回复] ', kind: 'reply' },
  { prefix: '[工具结果] ', kind: 'result' },
  { prefix: '[注入消息] ', kind: 'inject' },
  { prefix: '[开发者消息] ', kind: 'developer' },
]

const CALL_PREFIX = '[调用 '

function markerAt(line) {
  for (const marker of MARKERS) {
    if (line.indexOf(marker.prefix) === 0) {
      return { kind: marker.kind, name: '', prefixLength: marker.prefix.length }
    }
  }
  if (line.indexOf(CALL_PREFIX) !== 0) return null
  const end = line.indexOf(']')
  if (end < 0) return null
  const name = line.slice(CALL_PREFIX.length, end)
  const prefixLength = end + 1 + (line.charAt(end + 1) === ' ' ? 1 : 0)
  return { kind: 'call', name, prefixLength }
}

// 正文块按角色决定底色：assistant 的 text 是回复，tool 的 text 是工具结果。
function textKindOf(role) {
  if (role === 'tool') return 'result'
  if (role === 'assistant') return 'reply'
  if (role === 'developer') return 'developer'
  return 'text'
}

// 一条消息的内容块：思考、正文、工具调用分开，报告才能按类型上底色。
export function blocksOfMessage(message, role) {
  const content = message && Array.isArray(message.content) ? message.content : []
  const blocks = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'reasoning') {
      blocks.push({ kind: 'think', name: '', text: typeof block.text === 'string' ? block.text : '' })
      continue
    }
    if (block.type === 'tool-call') {
      blocks.push({
        kind: 'call',
        name: typeof block.name === 'string' ? block.name : 'unknown',
        text: typeof block.arguments === 'string' ? block.arguments : '',
      })
      continue
    }
    if (typeof block.text === 'string') {
      blocks.push({ kind: textKindOf(role), name: '', text: block.text })
      continue
    }
    if (block.type) blocks.push({ kind: 'other', name: '', text: '[' + String(block.type) + ']' })
  }
  return blocks
}

// 折叠载荷一段 = 一条节点，同一段里可能有思考、回复与工具调用；按行首前缀拆开。
// 正文内部换行不丢：锚点行之后的行都并回上一个块。
export function blocksOfFoldItem(text) {
  const value = typeof text === 'string' ? text : ''
  const blocks = []
  let current = null
  for (const line of value.split('\n')) {
    const marker = markerAt(line)
    if (marker) {
      current = { kind: marker.kind, name: marker.name, text: line.slice(marker.prefixLength) }
      blocks.push(current)
      continue
    }
    if (!current) {
      current = { kind: 'text', name: '', text: line }
      blocks.push(current)
      continue
    }
    current.text += '\n' + line
  }
  return blocks.filter((block) => block.text.length > 0 || block.kind === 'call')
}

// 消息在逐轮视图里的身份：用户原话、上下文注入、折叠摘要、重要消息、回复、工具结果……
export function entryKindOf(entry) {
  if (!entry) return 'text'
  if (entry.isCheckpoint) return 'checkpoint'
  if (entry.isPin) return 'pin'
  const role = entry.role ? String(entry.role) : ''
  const sourceKind = entry.sourceKind ? String(entry.sourceKind) : ''
  if (role === 'system') return 'system'
  if (role === 'tool') return 'result'
  if (role === 'developer') return 'developer'
  // schedule 是调度器投递的用户指令，和真人输入一样算一轮的开头，只是来源写「计划」。
  if (role === 'user') return sourceKind === 'user' || sourceKind === 'schedule' ? 'user' : 'inject'
  return 'reply'
}

function newGroup(kind) {
  return {
    kind,
    turn: null,
    entries: [],
    foldIds: [],
    pinLabels: [],
    chars: 0,
    checkpointChars: 0,
    unfoldedChars: 0,
    steps: 0,
    userText: '',
    replyText: '',
    lastCheckpointText: '',
    folded: false,
    prePlugin: false,
    short: false,
  }
}

function replyTextOfEntry(entry) {
  let out = ''
  for (const block of entry.blocks) {
    if (block.kind === 'reply') out += block.text
  }
  return out
}

function itemIsAssistant(item) {
  for (const block of item.blocks) {
    if (block.kind === 'think' || block.kind === 'reply' || block.kind === 'call') return true
  }
  return false
}

function itemReplyText(item) {
  let out = ''
  for (const block of item.blocks) {
    if (block.kind === 'reply') out += block.text
  }
  return out
}

// 分组：用户原话开一轮；system 全部抽到最前面单独成块，绝不进任何一轮。
// 一轮结束后到下一个用户消息之间的东西（折叠检查点、调度投递、注入上下文）算这一轮的尾巴，归这一轮。
export function buildTurnGroups({ entries, minFoldChars } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const groups = []
  const systemEntries = []
  const tail = []
  for (const entry of list) {
    if (entryKindOf(entry) === 'system') systemEntries.push(entry)
    else tail.push(entry)
  }
  let current = null

  function open(kind) {
    current = newGroup(kind)
    groups.push(current)
    return current
  }

  for (const entry of tail) {
    const kind = entryKindOf(entry)
    if (kind === 'user') {
      open('turn')
    } else if (!current) {
      // 历史开头没有用户消息（极少见）：也当一轮，免得内容被丢掉。
      open('turn')
    }
    if (!current) continue

    current.entries.push(entry)
    current.chars += typeof entry.chars === 'number' ? entry.chars : 0

    if (kind === 'user' && !current.userText) current.userText = String(entry.text || '')
    if (kind === 'pin') current.pinLabels.push(String(entry.pinLabel || entry.sourceLabel || '重要消息'))

    if (kind === 'checkpoint') {
      if (entry.foldId) current.foldIds.push(entry.foldId)
      current.lastCheckpointText = String(entry.text || '')
      current.checkpointChars += typeof entry.chars === 'number' ? entry.chars : 0
      const record = entry.foldRecord
      if (record) {
        const items = Array.isArray(record.items) ? record.items : []
        for (const item of items) {
          current.unfoldedChars += typeof item.chars === 'number' ? item.chars : 0
          if (itemIsAssistant(item)) current.steps += 1
          const reply = itemReplyText(item)
          if (reply) current.replyText = reply
        }
      }
      continue
    }

    if (kind === 'reply') {
      current.steps += 1
      const reply = replyTextOfEntry(entry)
      if (reply) current.replyText = reply
    }
  }

  for (const group of groups) {
    // 折叠组的「不折叠字符」= 原文 items + 没被折掉的普通消息。
    group.unfoldedChars += group.chars - group.checkpointChars
    group.folded = group.foldIds.length > 0
  }

  // 系统提示词整体提前：它从不参与折叠，放最前面既不打断轮次，也方便对照。
  if (systemEntries.length > 0) {
    const systemGroup = newGroup('system')
    systemGroup.entries = systemEntries
    for (const entry of systemEntries) systemGroup.chars += typeof entry.chars === 'number' ? entry.chars : 0
    systemGroup.unfoldedChars = systemGroup.chars
    groups.unshift(systemGroup)
  }

  numberTurns(groups, minFoldChars)
  return groups
}

// 轮次编号按用户消息出现的顺序数（从 1 起）：fold 记录里的 turn 是进程内计数，
// 重启后会从 1 重来，拿它当全局编号会串号。顺序编号对报告来说永远是对的。
// 第一个折叠组之前的未折叠组 = 插件生效前留下的历史，单独标注而不是伪装成「没折」。
function numberTurns(groups, minFoldChars) {
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  let firstFoldedIndex = -1
  for (let i = 0; i < turnGroups.length; i += 1) {
    turnGroups[i].turn = i + 1
    if (turnGroups[i].folded && firstFoldedIndex < 0) firstFoldedIndex = i
  }

  const threshold = typeof minFoldChars === 'number' && minFoldChars > 0 ? minFoldChars : 0
  for (let i = 0; i < turnGroups.length; i += 1) {
    const group = turnGroups[i]
    if (group.folded) continue
    if (firstFoldedIndex >= 0 && i < firstFoldedIndex) {
      group.prePlugin = true
      continue
    }
    if (threshold > 0 && group.unfoldedChars < threshold) group.short = true
  }

  groups.forEach((group, index) => {
    group.ordinal = index + 1
    if (typeof group.saved !== 'number') group.saved = group.unfoldedChars - group.chars
    group.saveRate = group.unfoldedChars > 0 ? group.saved / group.unfoldedChars : 0
  })
}

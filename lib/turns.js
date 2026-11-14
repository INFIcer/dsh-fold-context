// 逐轮视图：把「模型视角」的消息整理成大轮，供报告页按轮展示。
//
// 一轮 = 一条用户原话 + 它之后的回复、思考、工具调用、折叠检查点与上下文注入。
// 系统提示词按它出现的时间单独成块（它从不折叠，混进某轮会让人以为它被折掉了）；
// 后一版系统提示词只保留与前一版的差异，避免整段重发几万字。
// 重要消息跟着它出现的位置走，不挪到别处。
// 这里只有纯函数：不读会话、不写盘，输入输出都是普通对象，测试可以单独覆盖。

import { diffLines } from './diff.js'

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

// 折叠载荷一段 = 一条节点。段首前缀决定这段的身份：只有助手生成的段（以
// [思考]/[回复]/[调用 开头）才可能同时含思考、回复与工具调用，才需要再按行首前缀拆。
// 工具结果、注入消息、开发者消息整段就是一个块——它们的正文经常引用本插件自己的
// 标记（报告、源码、日志里都有 '[回复] ' 这种字样），再拆就会切出假回复段，
// 召回目录与分段召回都会把这些假段当成真回复。
const SPLITTABLE_KINDS = new Set(['think', 'reply', 'call'])

// 助手段内部，标记只按生成顺序出现：先思考、再回复、最后是若干个调用。
// 已经进入回复阶段后又出现一行 '[思考] '，那只可能是回复正文在引用标记，不是新块。
const PHASE = { think: 0, reply: 1, call: 2 }

function keepable(block) {
  return block.text.length > 0 || block.kind === 'call'
}

export function blocksOfFoldItem(text) {
  const value = typeof text === 'string' ? text : ''
  const lines = value.split('\n')
  const head = markerAt(lines[0])
  if (!head || !SPLITTABLE_KINDS.has(head.kind)) {
    const block = head
      ? { kind: head.kind, name: head.name, text: value.slice(head.prefixLength) }
      : { kind: 'text', name: '', text: value }
    return keepable(block) ? [block] : []
  }
  const blocks = []
  let current = null
  let phase = -1
  for (const line of lines) {
    const marker = markerAt(line)
    if (marker && SPLITTABLE_KINDS.has(marker.kind) && PHASE[marker.kind] >= phase) {
      phase = PHASE[marker.kind];
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
  return blocks.filter(keepable)
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
    // 助手自己生成的字数（思考 + 回复 + 工具调用参数）：输出计价的依据，与折叠无关。
    outputChars: 0,
    steps: 0,
    userText: '',
    replyText: '',
    // 折叠把回复原文裁掉了时，摘要里还留着回复开头，拿它当预览。
    replyNote: '',
    lastCheckpointText: '',
    folded: false,
    prePlugin: false,
    short: false,
    // 这一组里第一个检查点属于哪一轮；用来发现「下一轮的触发消息被折掉了」。
    checkpointTurn: null,
    // 系统提示词的版本号与和上一版的差异；普通轮次为 0 / null。
    version: 0,
    diff: null,
    diffOf: 0,
  }
}

function replyTextOfEntry(entry) {
  let out = ''
  for (const block of entry.blocks) {
    if (block.kind === 'reply') out += block.text
  }
  return out
}

// 输出的 token 取决于模型自己写了多少：思考、回复、工具调用参数都算，工具结果不算。
const OUTPUT_KINDS = { think: true, reply: true, call: true }

function outputCharsOf(blocks) {
  let total = 0
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || OUTPUT_KINDS[block.kind] !== true) continue
    total += typeof block.text === 'string' ? block.text.length : 0
  }
  return total
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

// 一条消息的纯文本：系统提示词只有一个正文块，优先用它，退回拼块。
function systemTextOf(entry) {
  if (entry && typeof entry.text === 'string' && entry.text) return entry.text
  let out = ''
  const blocks = entry && Array.isArray(entry.blocks) ? entry.blocks : []
  for (const block of blocks) {
    if (!block || typeof block.text !== 'string') continue
    out += (out ? '\n' : '') + block.text
  }
  return out
}

// 分组：用户原话开一轮；系统提示词按出现顺序单独成块，绝不进任何一轮。
// 一轮结束后到下一个用户消息之间的东西（折叠检查点、调度投递、注入上下文）算这一轮的尾巴，归这一轮。
export function buildTurnGroups({ entries, minFoldChars } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const groups = []
  let current = null
  let previousSystem = null

  function open(kind) {
    current = newGroup(kind)
    groups.push(current)
    return current
  }

  for (const entry of list) {
    const kind = entryKindOf(entry)
    if (kind === 'system') {
      // 系统提示词更新落在两轮之间：先关掉上一轮，再按时间顺序插一块。
      current = null
      const group = open('system')
      group.entries.push(entry)
      group.chars += typeof entry.chars === 'number' ? entry.chars : 0
      group.version = previousSystem ? previousSystem.version + 1 : 1
      if (previousSystem) {
        group.diffOf = previousSystem.version
        group.diff = diffLines(previousSystem.text, systemTextOf(entry), {
          context: 2,
          maxDiffLines: 160,
          lineCap: 2000,
        })
      }
      previousSystem = { version: group.version, text: systemTextOf(entry) }
      // 系统块不属于任何一轮：后面的消息要另起一块，不能续在它后面。
      current = null
      continue
    }
    if (kind === 'user') {
      open('turn')
    } else if (!current) {
      // 历史开头没有用户消息（极少见）：也当一轮，免得内容被丢掉。
      open('turn')
    }
    // 一轮的触发消息也可能被折掉（例如调度器投递的 user/message），
    // 那时两轮之间就没有用户消息当界碑，只能靠检查点里的 turn 换轮。
    if (kind === 'checkpoint' && current && current.checkpointTurn !== null) {
      const turn = checkpointTurnOf(entry)
      if (turn !== null && turn !== current.checkpointTurn) open('turn')
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
      if (current.checkpointTurn === null) current.checkpointTurn = checkpointTurnOf(entry)
      const record = entry.foldRecord
      if (record) {
        const items = Array.isArray(record.items) ? record.items : []
        for (const item of items) {
          current.unfoldedChars += typeof item.chars === 'number' ? item.chars : 0
          if (itemIsAssistant(item)) current.steps += 1
          current.outputChars += outputCharsOf(item.blocks)
          const reply = itemReplyText(item)
          if (reply) current.replyText = reply
        }
      }
      if (!current.replyText) {
        const match = String(entry.text || '').match(/· 回复约 \d+ 字，开头「([^」]*)」/)
        if (match) current.replyNote = match[1]
      }
      continue
    }

    if (kind === 'reply') {
      current.steps += 1
      current.outputChars += outputCharsOf(entry.blocks)
      const reply = replyTextOfEntry(entry)
      if (reply) current.replyText = reply
    }
  }

  for (const group of groups) {
    // 折叠组的「不折叠字符」= 原文 items + 没被折掉的普通消息。
    group.unfoldedChars += group.chars - group.checkpointChars
    group.folded = group.foldIds.length > 0
  }

  numberTurns(groups, minFoldChars)
  return groups
}

// 这条折叠记录所属的会话轮次：turn/start 带的是会话自己的计数，跨重启不重来。
function checkpointTurnOf(entry) {
  const record = entry && entry.foldRecord
  const turn = record && typeof record.turn === 'number' && Number.isFinite(record.turn) ? record.turn : null
  return turn
}

function knownTurnOf(group) {
  for (const entry of group.entries) {
    if (entryKindOf(entry) !== 'checkpoint') continue
    const turn = checkpointTurnOf(entry)
    if (turn !== null) return turn
  }
  return null
}

// 轮次号优先取 fold 记录里的 turn（会话自己的计数），推不出来时按相邻轮次递增/回退。
// 一条用户消息不一定开一个新轮次：轮内 steering 会把同一轮切成两段，后一段标成「续」。
// 第一个折叠组之前的未折叠组 = 插件生效前留下的历史，单独标注而不是伪装成「没折」。
function numberTurns(groups, minFoldChars) {
  const turnGroups = groups.filter((group) => group.kind === 'turn')
  let firstFoldedIndex = -1
  let knownSeen = false
  for (let i = 0; i < turnGroups.length; i += 1) {
    const group = turnGroups[i]
    group.knownTurn = knownTurnOf(group)
    group.turn = null
    group.continuation = false
    if (group.knownTurn !== null) knownSeen = true
    if (group.folded && firstFoldedIndex < 0) firstFoldedIndex = i
  }

  // 向后：已知轮次直接用，未知的取上一轮 +1。
  let last = null
  for (const group of turnGroups) {
    if (group.knownTurn !== null) {
      group.turn = group.knownTurn
      last = group.knownTurn
      continue
    }
    if (last !== null) {
      last += 1
      group.turn = last
    }
  }
  // 向前回填开头的未折叠轮次（插件生效前那段）。
  let next = null
  for (let i = turnGroups.length - 1; i >= 0; i -= 1) {
    const group = turnGroups[i]
    if (group.knownTurn !== null) {
      next = group.knownTurn
      continue
    }
    if (typeof group.turn === 'number') {
      next = group.turn
      continue
    }
    if (next !== null) {
      group.turn = Math.max(1, next - 1)
      next = group.turn
    }
  }

  // 一次都没折过：没有锚点可推，只能按出现顺序编号，报告里会标成「未折叠」。
  if (!knownSeen) {
    for (let i = 0; i < turnGroups.length; i += 1) turnGroups[i].turn = i + 1
  }

  // 同一轮被轮内发言切开：标成续接，免得两段同号看起来像串号。
  let previous = null
  for (const group of turnGroups) {
    if (group.turn === previous && previous !== null) group.continuation = true
    if (group.turn !== null) previous = group.turn
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

// 上下文构成：把逐轮历史折成「按用途分类的 token 数」，供模型视角页画占比和时间线。
//
// 两种视角：
//   folded   = 模型现在真正看到的历史（检查点算一类「折叠摘要」）
//   unfolded = 假设一次都没折过（检查点换回原文的思考/回复/工具/注入）
// 分类只按用途，不按消息条数：一条 assistant 消息里的思考和工具调用会分开计。
//
// 计价口径与宿主 token-meter 的 contextBreakdown 对齐：
// - 每条消息按块计（正文/思考 ceil(len/4)+4，工具调用名与参数各算一张，再 +4 角色开销）；
// - system 提示词是整段渲染结果，按整段一次 ceil + 一次角色开销，不分块；
// - 工具定义来自请求信封，不随折叠变化，两边都计入。
// 纯函数：输入是 turns.js 的分组结果，输出是普通对象，测试可以单独覆盖。

import { BLOCK_OVERHEAD, CHARS_PER_TOKEN } from './tokens.js'

const CATEGORIES = [
  { key: 'system', label: '系统提示' },
  // dsh-context 浏览器只把最后一条非空 system/message 当当前提示词；更早的版本留在
  // surface 里但不计入请求预测（provider 实际 prompt 也支持这个口径），所以这里只作参考。
  { key: 'systemHistory', label: '旧版系统提示（不计入）', reference: true },
  { key: 'toolDefs', label: '工具定义' },
  { key: 'user', label: '用户原话' },
  { key: 'assistant', label: '思考与回复' },
  { key: 'tools', label: '工具调用与结果' },
  { key: 'inject', label: '上下文注入' },
  { key: 'checkpoint', label: '折叠摘要' },
  { key: 'pin', label: '重要消息' },
]

const KEYS = CATEGORIES.map((item) => item.key)
// 只把会发给模型的分类计入总量；reference 类只展示数字，不参与占比与合计。
const COUNTED_KEYS = CATEGORIES.filter((item) => item.reference !== true).map((item) => item.key)
// 消息类：折叠/不折叠对比时缩放这些档；旧版系统提示不计入。
const MESSAGE_KEYS = ['user', 'assistant', 'tools', 'inject', 'checkpoint', 'pin']

function blank() {
  const bucket = {}
  for (const key of KEYS) bucket[key] = 0
  return bucket
}

function add(bucket, key, value) {
  if (!bucket || KEYS.indexOf(key) < 0) return
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (number > 0) bucket[key] += number
}

function sum(bucket) {
  let total = 0
  for (const key of COUNTED_KEYS) total += bucket[key] || 0
  return total
}

function textChars(block) {
  return block && typeof block.text === 'string' ? block.text.length : 0
}

// 一块内容的 token：正文/思考按字数，工具调用把名字与参数各算一段；块开销统一 +4。
function blockTokens(block) {
  if (!block || typeof block !== 'object') return 0
  if (block.kind === 'call') {
    const name = typeof block.name === 'string' ? block.name : ''
    return Math.ceil(name.length / CHARS_PER_TOKEN) + Math.ceil(textChars(block) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  const chars = textChars(block)
  return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) + BLOCK_OVERHEAD : 0
}

function blocksTokens(blocks) {
  let total = 0
  for (const block of Array.isArray(blocks) ? blocks : []) total += blockTokens(block)
  return total
}

// 一条消息：内容块相加，再加角色的固定开销；system 按整段一次 ceil（与宿主口径一致）。
function entryTokens(entry) {
  const blocks = Array.isArray(entry && entry.blocks) ? entry.blocks : []
  if (entry && entry.role === 'system') {
    let chars = 0
    for (const block of blocks) chars += textChars(block)
    return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) + BLOCK_OVERHEAD : 0
  }
  if (blocks.length === 0) {
    const chars = typeof (entry && entry.chars) === 'number' ? entry.chars : 0
    return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) + BLOCK_OVERHEAD : 0
  }
  return blocksTokens(blocks) + BLOCK_OVERHEAD
}

// 折叠原文的一段（一条原始消息）：同样按块计价，再加角色开销。
function itemTokens(item) {
  const blocks = Array.isArray(item && item.blocks) ? item.blocks : []
  if (blocks.length === 0) {
    const chars = typeof (item && item.chars) === 'number' ? item.chars : 0
    return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) + BLOCK_OVERHEAD : 0
  }
  return blocksTokens(blocks) + BLOCK_OVERHEAD
}

// 内容块按用途归类：思考与正文算助手输出，调用与结果算工具，注入与开发者消息算上下文。
function addBlocks(bucket, blocks, fallback) {
  const list = Array.isArray(blocks) ? blocks : []
  for (const block of list) {
    const chars = textChars(block)
    if (chars <= 0) continue
    const kind = block && block.kind
    if (kind === 'think' || kind === 'reply') add(bucket, 'assistant', chars)
    else if (kind === 'call' || kind === 'result') add(bucket, 'tools', chars)
    else if (kind === 'inject' || kind === 'developer') add(bucket, 'inject', chars)
    else if (kind === 'system') add(bucket, 'system', chars)
    else add(bucket, fallback, chars)
  }
}

function categoryOf(entry) {
  if (!entry || typeof entry !== 'object') return 'inject'
  if (entry.isCheckpoint) return 'checkpoint'
  if (entry.isPin) return 'pin'
  const role = entry.role ? String(entry.role) : ''
  const sourceKind = entry.sourceKind ? String(entry.sourceKind) : ''
  if (role === 'system') return 'system'
  if (role === 'tool') return 'tools'
  if (role === 'developer') return 'inject'
  // schedule 是调度器投递的用户指令，和真人输入一样归用户侧。
  if (role === 'user') return sourceKind === 'user' || sourceKind === 'schedule' ? 'user' : 'inject'
  if (role === 'assistant') return 'assistant'
  return 'inject'
}

// 同一份内容在 chars 与 tokens 两套桶里各记一次：chars 供图例看原文量，tokens 供占比与合计。
function addEntry(charsBucket, tokensBucket, entry, view, currentSystem) {
  let category = categoryOf(entry)
  // 系统提示只认最后一条非空 system；更早的版本单列，免得整类被累加成几倍。
  if (category === 'system' && entry !== currentSystem) category = 'systemHistory'
  if (category === 'checkpoint' && view === 'unfolded') {
    const record = entry.foldRecord
    const items = record && Array.isArray(record.items) ? record.items : null
    if (items && items.length > 0) {
      for (const item of items) {
        addBlocks(charsBucket, item && item.blocks, 'inject')
        if (tokensBucket) splitTokensByBlocks(tokensBucket, item && item.blocks, 'inject', itemTokens(item))
      }
      return
    }
  }
  if (category === 'assistant') {
    const blocks = Array.isArray(entry.blocks) ? entry.blocks : []
    if (blocks.length > 0) {
      addBlocks(charsBucket, blocks, 'assistant')
      // 一条 assistant 消息可能同时有思考、回复与调用：tokens 按整条消息计一次角色开销，
      // 分档时按各块的实际占比拆开，才能和 dsh-context 的「助手消息」对上。
      splitTokensByBlocks(tokensBucket, blocks, 'assistant', entryTokens(entry))
      return
    }
  }
  add(charsBucket, category, entry.chars)
  if (tokensBucket) add(tokensBucket, category, entryTokens(entry))
}

// 折叠原文里的一段可能混着思考/回复/调用：token 也按块拆到对应档。
function splitTokensByBlocks(bucket, blocks, fallback, total) {
  const list = Array.isArray(blocks) ? blocks : []
  let counted = 0
  const parts = []
  for (const block of list) {
    if (!block || (textChars(block) <= 0 && block.kind !== 'call')) continue
    const tokens = blockTokens(block)
    if (tokens <= 0) continue
    let category = fallback
    if (block.kind === 'result' || block.kind === 'call') category = 'tools'
    else if (block.kind === 'inject' || block.kind === 'developer') category = 'inject'
    else if (block.kind === 'think' || block.kind === 'reply') category = 'assistant'
    parts.push({ category, tokens })
    counted += tokens
  }
  // 剩余的角色开销记到主档；没有可计价的块时整条落到 fallback。
  if (counted <= 0) {
    add(bucket, fallback, total)
    return
  }
  for (const part of parts) add(bucket, part.category, (part.tokens / counted) * total)
}

// 当前系统提示 = 最后一条非空的 system 消息（与宿主 token-meter 的 contextBreakdown 同口径）。
// 之前的版本不是当前提示词，但仍在 surface 里，所以单列一类而不是丢掉。
function currentSystemOf(groups) {
  let found = null
  for (const group of groups) {
    const entries = Array.isArray(group && group.entries) ? group.entries : []
    for (const entry of entries) {
      if (!entry || entry.role !== 'system') continue
      if (typeof entry.chars === 'number' && entry.chars > 0) found = entry
    }
  }
  return found
}

function labelOf(group) {
  if (!group || typeof group !== 'object') return ''
  if (group.kind === 'system') return 'S' + (typeof group.version === 'number' ? group.version : 1)
  if (typeof group.turn === 'number') return 'T' + group.turn
  return ''
}

export function buildComposition({ groups, timeline } = {}) {
  // 时间线（按会话事件重放）优先：它能看见折叠与压缩的台阶，也是当前预测的来源。
  if (timeline && Array.isArray(timeline.points) && timeline.points.length > 0) {
    return {
      categories: timeline.categories,
      totals: timeline.totals,
      points: timeline.points,
    }
  }
  // 退化路径：没有会话日志时，按当前 surface 的分组重建一条累计曲线（看不到历史台阶）。
  const list = Array.isArray(groups) ? groups : []
  const currentSystem = currentSystemOf(list)
  const points = []
  let runningFolded = blank()
  let runningUnfolded = blank()
  let runningFoldedTokens = blank()
  let runningUnfoldedTokens = blank()
  for (let i = 0; i < list.length; i += 1) {
    const group = list[i] && typeof list[i] === 'object' ? list[i] : {}
    const folded = blank()
    const unfolded = blank()
    const foldedTokens = blank()
    const unfoldedTokens = blank()
    const entries = Array.isArray(group.entries) ? group.entries : []
    for (const entry of entries) {
      addEntry(folded, foldedTokens, entry, 'folded', currentSystem)
      addEntry(unfolded, unfoldedTokens, entry, 'unfolded', currentSystem)
    }
    for (const key of KEYS) {
      runningFolded[key] += folded[key]
      runningUnfolded[key] += unfolded[key]
      runningFoldedTokens[key] += foldedTokens[key] || 0
      runningUnfoldedTokens[key] += unfoldedTokens[key] || 0
    }
    points.push({
      ordinal: typeof group.ordinal === 'number' ? group.ordinal : i + 1,
      kind: group.kind === 'system' ? 'system' : 'turn',
      turn: typeof group.turn === 'number' ? group.turn : null,
      label: labelOf(group),
      folded,
      unfolded,
      totals: { folded: sum(folded), unfolded: sum(unfolded) },
      tokens: { folded: foldedTokens, unfolded: unfoldedTokens },
      tokensTotals: { folded: sum(foldedTokens), unfolded: sum(unfoldedTokens) },
      cumulative: {
        folded: Object.assign({}, runningFolded),
        unfolded: Object.assign({}, runningUnfolded),
      },
      cumulativeTokens: {
        folded: Object.assign({}, runningFoldedTokens),
        unfolded: Object.assign({}, runningUnfoldedTokens),
      },
    })
  }
  const lastPoint = points.length > 0 ? points[points.length - 1] : null
  const totalFolded = lastPoint ? lastPoint.cumulative.folded : blank()
  const totalUnfolded = lastPoint ? lastPoint.cumulative.unfolded : blank()
  const totalFoldedTokens = lastPoint ? lastPoint.cumulativeTokens.folded : blank()
  const totalUnfoldedTokens = lastPoint ? lastPoint.cumulativeTokens.unfolded : blank()
  return {
    categories: CATEGORIES.map((item) => ({
      key: item.key,
      label: item.label,
      reference: item.reference === true,
    })),
    totals: {
      folded: Object.assign({}, totalFolded),
      unfolded: Object.assign({}, totalUnfolded),
      sum: { folded: sum(totalFolded), unfolded: sum(totalUnfolded) },
      tokens: {
        folded: Object.assign({}, totalFoldedTokens),
        unfolded: Object.assign({}, totalUnfoldedTokens),
        sum: { folded: sum(totalFoldedTokens), unfolded: sum(totalUnfoldedTokens) },
      },
    },
    points,
  }
}

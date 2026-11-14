// 上下文构成：把逐轮历史折成「按用途分类的字符数」，供模型视角页画占比和时间线。
//
// 两种视角：
//   folded   = 模型现在真正看到的历史（检查点算一类「折叠摘要」）
//   unfolded = 假设一次都没折过（检查点换回原文的思考/回复/工具/注入）
// 分类只按用途，不按消息条数：一条 assistant 消息里的思考和工具调用会分开计。
// 纯函数：输入是 turns.js 的分组结果，输出是普通对象，测试可以单独覆盖。

const CATEGORIES = [
  { key: 'system', label: '系统提示' },
  // 提示词每换一版就整段再发一次：旧版仍留在历史里，但不是「当前生效的那一版」。
  { key: 'systemHistory', label: '旧版系统提示' },
  { key: 'user', label: '用户原话' },
  { key: 'assistant', label: '思考与回复' },
  { key: 'tools', label: '工具调用与结果' },
  { key: 'inject', label: '上下文注入' },
  { key: 'checkpoint', label: '折叠摘要' },
  { key: 'pin', label: '重要消息' },
]

const KEYS = CATEGORIES.map((item) => item.key)

function blank() {
  const bucket = {}
  for (const key of KEYS) bucket[key] = 0
  return bucket
}

function add(bucket, key, chars) {
  if (!bucket || KEYS.indexOf(key) < 0) return
  const value = typeof chars === 'number' && Number.isFinite(chars) ? chars : 0
  if (value > 0) bucket[key] += value
}

function sum(bucket) {
  let total = 0
  for (const key of KEYS) total += bucket[key] || 0
  return total
}

function textChars(block) {
  return block && typeof block.text === 'string' ? block.text.length : 0
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

function addEntry(bucket, entry, view, currentSystem) {
  let category = categoryOf(entry)
  // 系统提示只认最后一条非空 system；更早的版本单列，免得整类被累加成几倍。
  if (category === 'system' && entry !== currentSystem) category = 'systemHistory'
  if (category === 'checkpoint' && view === 'unfolded') {
    const record = entry.foldRecord
    const items = record && Array.isArray(record.items) ? record.items : null
    if (items && items.length > 0) {
      for (const item of items) addBlocks(bucket, item && item.blocks, 'inject')
      return
    }
  }
  if (category === 'assistant') {
    const blocks = Array.isArray(entry.blocks) ? entry.blocks : []
    if (blocks.length > 0) {
      addBlocks(bucket, blocks, 'assistant')
      return
    }
  }
  add(bucket, category, entry.chars)
}

// 当前系统提示 = 最后一条非空的 system 消息（与宿主 token-meter 的 contextBreakdown 同口径）。
// 之前的版本不是当前提示词，但仍在 surface 里、仍会发给模型，所以单列一类而不是丢掉。
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

export function buildComposition({ groups } = {}) {
  const list = Array.isArray(groups) ? groups : []
  const currentSystem = currentSystemOf(list)
  const points = []
  const runningFolded = blank()
  const runningUnfolded = blank()

  for (let i = 0; i < list.length; i += 1) {
    const group = list[i] && typeof list[i] === 'object' ? list[i] : {}
    const folded = blank()
    const unfolded = blank()
    const entries = Array.isArray(group.entries) ? group.entries : []
    for (const entry of entries) {
      addEntry(folded, entry, 'folded', currentSystem)
      addEntry(unfolded, entry, 'unfolded', currentSystem)
    }
    for (const key of KEYS) {
      runningFolded[key] += folded[key]
      runningUnfolded[key] += unfolded[key]
    }
    points.push({
      ordinal: typeof group.ordinal === 'number' ? group.ordinal : i + 1,
      kind: group.kind === 'system' ? 'system' : 'turn',
      turn: typeof group.turn === 'number' ? group.turn : null,
      label: labelOf(group),
      folded,
      unfolded,
      totals: { folded: sum(folded), unfolded: sum(unfolded) },
      cumulative: {
        folded: Object.assign({}, runningFolded),
        unfolded: Object.assign({}, runningUnfolded),
      },
    })
  }

  const last = points.length > 0 ? points[points.length - 1] : null
  const totalFolded = last ? last.cumulative.folded : blank()
  const totalUnfolded = last ? last.cumulative.unfolded : blank()
  return {
    categories: CATEGORIES.map((item) => ({ key: item.key, label: item.label })),
    totals: {
      folded: Object.assign({}, totalFolded),
      unfolded: Object.assign({}, totalUnfolded),
      sum: { folded: sum(totalFolded), unfolded: sum(totalUnfolded) },
    },
    points,
  }
}

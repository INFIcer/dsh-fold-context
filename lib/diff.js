// 行级差异：系统提示词每次更新都会整段重发，后续版本只展示变化，才看得清改了什么。
//
// 纯函数，不 import 宿主包。算法是先剥掉公共前后缀，再对中间部分做 LCS 动态规划；
// 中间部分过大时退化成「整段替换」，宁可粗糙也不能把一次请求拖住。
// 返回的 hunks 带上下文行，客户端按 @@ -a +b @@ 的样式渲染。

const DEFAULTS = {
  context: 3,
  maxCells: 4000000,
  maxDiffLines: 600,
  lineCap: 4000,
}

function settingsOf(options) {
  const source = options && typeof options === 'object' ? options : {}
  return {
    context: typeof source.context === 'number' && source.context >= 0 ? Math.floor(source.context) : DEFAULTS.context,
    maxCells: typeof source.maxCells === 'number' && source.maxCells > 0 ? Math.floor(source.maxCells) : DEFAULTS.maxCells,
    maxDiffLines: typeof source.maxDiffLines === 'number' && source.maxDiffLines > 0 ? Math.floor(source.maxDiffLines) : DEFAULTS.maxDiffLines,
    lineCap: typeof source.lineCap === 'number' && source.lineCap > 0 ? Math.floor(source.lineCap) : DEFAULTS.lineCap,
  }
}

function splitLines(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  return text.split('\n')
}

function cloneLine(text, cap) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= cap) return value
  return value.slice(0, cap) + ' …（本行还有 ' + (value.length - cap) + ' 字）'
}

function opOf(t, text) {
  return { t, text: typeof text === 'string' ? text : '' }
}

function middleOps(a, b, maxCells) {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => opOf('add', text))
  if (m === 0) return a.map((text) => opOf('del', text))
  if (n * m > maxCells) {
    // 太大：不逐行比，直接标成整段删除 + 整段新增。
    return a.map((text) => opOf('del', text)).concat(b.map((text) => opOf('add', text)))
  }
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * width
    const nextRow = (i + 1) * width
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[row + j] = dp[nextRow + j + 1] + 1
      } else {
        const down = dp[nextRow + j]
        const right = dp[row + j + 1]
        dp[row + j] = down >= right ? down : right
      }
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(opOf('ctx', a[i]))
      i += 1
      j += 1
      continue
    }
    if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push(opOf('del', a[i]))
      i += 1
    } else {
      ops.push(opOf('add', b[j]))
      j += 1
    }
  }
  while (i < n) {
    ops.push(opOf('del', a[i]))
    i += 1
  }
  while (j < m) {
    ops.push(opOf('add', b[j]))
    j += 1
  }
  return ops
}

// 差异结果：same 表示两段完全一样；add/del 是总行数；hunks 只带改动附近的行。
export function diffLines(before, after, options) {
  const settings = settingsOf(options)
  const a = splitLines(before)
  const b = splitLines(after)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  if (start === a.length && start === b.length) {
    return { same: true, add: 0, del: 0, hunks: [], truncated: false, clipped: false }
  }

  const ops = []
  for (let i = 0; i < start; i += 1) ops.push(opOf('ctx', a[i]))
  const middle = middleOps(a.slice(start, endA), b.slice(start, endB), settings.maxCells)
  for (const op of middle) ops.push(op)
  for (let i = endA; i < a.length; i += 1) ops.push(opOf('ctx', a[i]))

  let add = 0
  let del = 0
  for (const op of ops) {
    if (op.t === 'add') add += 1
    else if (op.t === 'del') del += 1
  }
  if (add === 0 && del === 0) {
    return { same: true, add: 0, del: 0, hunks: [], truncated: false, clipped: false }
  }

  // 每个操作对应的前后版本行号，hunk 头用它。
  const aNo = new Array(ops.length + 1)
  const bNo = new Array(ops.length + 1)
  aNo[0] = 1
  bNo[0] = 1
  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k]
    aNo[k + 1] = aNo[k] + (op.t === 'add' ? 0 : 1)
    bNo[k + 1] = bNo[k] + (op.t === 'del' ? 0 : 1)
  }

  const changed = []
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k].t !== 'ctx') changed.push(k)
  }

  const ranges = []
  let from = changed[0]
  let to = changed[0]
  for (let i = 1; i < changed.length; i += 1) {
    if (changed[i] === to + 1) {
      to = changed[i]
      continue
    }
    ranges.push([from, to])
    from = changed[i]
    to = changed[i]
  }
  ranges.push([from, to])

  const hunks = []
  let budget = settings.maxDiffLines
  let truncated = false
  let clipped = false
  for (const range of ranges) {
    if (budget <= 0) {
      truncated = true
      break
    }
    const s = Math.max(0, range[0] - settings.context)
    const e = Math.min(ops.length, range[1] + settings.context + 1)
    const lines = []
    for (let k = s; k < e && budget > 0; k += 1) {
      const op = ops[k]
      const text = cloneLine(op.text, settings.lineCap)
      if (text.length !== op.text.length) clipped = true
      lines.push({ t: op.t, text })
      budget -= 1
    }
    // 预算在改动区间内部就用光了：这一段的剩余行没进 hunk，标成截断。
    if (budget <= 0 && s + lines.length < e) truncated = true
    hunks.push({
      aStart: aNo[s],
      bStart: bNo[s],
      aLines: aNo[e] - aNo[s],
      bLines: bNo[e] - bNo[s],
      lines,
    })
  }

  return { same: false, add, del, hunks, truncated, clipped }
}

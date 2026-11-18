import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { buildFoldIndex, describeFold, foldParts, renderFoldParts } from '../lib/recall.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientFile = join(here, '..', 'client', 'client.js')

// 客户端 bundle 是被浏览器模块加载器接管的 CJS：这里用最小假件把它当普通模块跑起来，
// 只验证注册面（顶栏 View 与插件页配置位），不验证渲染结果。
function loadClient(options = {}) {
  const source = readFileSync(clientFile, 'utf8')
  let definition
  const fakeWindow = {
    __ModuleLoader__: {
      load(next) { definition = next },
    },
  }
  // states：按顺序给每个 useState 喂初值，用来把一页真实数据摊开渲染。
  let cursor = 0
  const react = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type, props: props || {}, children }
    },
    // open 让展开态可测：收起态是默认值，展开态才看得到 details 的正文。
    useState(value) {
      if (options.states) {
        const next = options.states[cursor]
        cursor += 1
        return [next === undefined ? value : next, function () {}]
      }
      return [options.open === true ? true : value, function () {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    Fragment: 'fragment',
  }
  const run = new Function('window', 'document', 'fetch', source)
  run(fakeWindow, undefined, function () { return Promise.reject(new Error('no network in test')) })
  assert.ok(definition, '客户端 bundle 应当调用 __ModuleLoader__.load')
  const module = definition.factory(function (name) {
    assert.equal(name, 'react')
    return react
  })
  return { definition, module }
}

function fakeCtx() {
  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject(key, callback) {
        injected.push(key)
        const dispose = callback()
        return function () { if (typeof dispose === 'function') dispose() }
      },
      register(options, component) {
        registered.push({ options, component })
        return function () {}
      },
    },
  }
  return { ctx, injected, registered }
}

test('折叠页顶栏：粘性标题条、两个标签页，且不再有逐轮报告与手动刷新', () => {
  // 顶栏要冻在视口上沿；账本与模型视角各一个标签；过时的 HTML 报告入口与冗余的刷新按钮都删掉了。
  const { module } = loadClient({
    states: ['ledger', { text: '更新于 12:00:00 · 每 5 秒自动刷新', error: '' }, false, { status: 'loading', data: null, error: '', at: 0 }],
  })
  const json = JSON.stringify(module.__test.FoldStatsView({ sessionId: 's1' }))
  assert.ok(json.includes('"position":"sticky"'), '顶栏要 sticky')
  assert.ok(json.includes('"top":0'), '顶栏要贴住视口上沿')
  assert.ok(json.includes('上下文折叠'), '要有标题')
  assert.ok(json.includes('更新于 12:00:00'), '「更新于」应当由当前标签页回填到顶栏')
  assert.ok(json.includes('账本') && json.includes('模型视角'), '两个标签页都要在')
  assert.equal(json.includes('逐轮报告'), false)
  assert.equal(json.includes('/fold-report'), false)
  assert.equal(json.includes('"刷新"'), false)
})

test('折叠页选任 composer 浮层：页面自己滚动，宿主据此隐藏两侧拖宽分割线', () => {
  // 宿主的对话列两侧各有一条绝对定位的拖宽把手（10px、col-resize），压在 View 之上；
  // 只有 View 根节点带 data-conversation-composer-overlay 时它才被 display:none 掉。
  // 折叠页漏掉这个属性，页面上就还能拖着改列宽——轨迹页与统计页都靠这一档关掉交互。
  const { module } = loadClient({
    states: ['ledger', { text: '', error: '' }, false, { status: 'loading', data: null, error: '', at: 0 }],
  })
  const tree = module.__test.FoldStatsView({ sessionId: 's1' })
  assert.equal(tree.props['data-conversation-composer-overlay'], '')
  // 选了浮层，composer 不再占流：页面必须自己拥有滚动容器，并在底部留出 composer 的实时高度，
  // 否则最后一屏内容会滚不到浮层上面。
  assert.equal(tree.props.style.overflowY, 'auto')
  assert.equal(tree.props.style.height, '100%')
  assert.ok(tree.props.style.padding.includes('var(--dsh-composer-height'), tree.props.style.padding)
  // 没有会话的兜底态同样挂这个根：只要这一页在，把手就不该活过来。
  const empty = loadClient({ states: ['ledger', null, null] })
  const notice = empty.module.__test.FoldStatsView({})
  assert.equal(notice.props['data-conversation-composer-overlay'], '')
})

test('客户端 bundle 声明 id 与 slots 依赖', () => {
  const { definition, module } = loadClient()
  assert.equal(definition.id, 'dsh-fold-context')
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')
})

test('apply 注册对话顶栏 View 与插件页配置位', () => {
  const { module } = loadClient()
  const { ctx, injected, registered } = fakeCtx()
  module.apply(ctx)
  assert.deepEqual(injected, ['conversation.view', 'plugins.bundle.config'])
  assert.equal(registered.length, 2)
  const view = registered[0].options
  assert.equal(view.name, 'conversation.view')
  assert.equal(view.id, 'fold-stats')
  assert.equal(typeof view.label, 'function')
  assert.equal(view.label(), '折叠')
  assert.equal(typeof registered[0].component, 'function')
  const config = registered[1].options
  assert.equal(config.name, 'plugins.bundle.config')
  // keyed slot 的键必须是组合包名，插件管理页拿它判断是否渲染配置区
  assert.equal(config.key, 'dsh-fold-context')
  assert.equal(typeof registered[1].component, 'function')
})

function demoComposition() {
  const keys = ['system', 'systemHistory', 'toolDefs', 'user', 'assistant', 'tools', 'inject', 'checkpoint', 'pin']
  const labels = ['系统提示', '旧版系统提示', '工具定义', '用户原话', '思考与回复', '工具调用与结果', '上下文注入', '折叠摘要', '重要消息']
  const bucket = (values) => {
    const out = {}
    keys.forEach((key, index) => { out[key] = values[index] || 0 })
    return out
  }
  const sumOf = (values) => keys.reduce((sum, key) => sum + (values[key] || 0), 0)
  const foldedChars = bucket([84381, 328999, 0, 500, 12000, 4000, 1000, 3000, 300])
  const unfoldedChars = bucket([90000, 328999, 0, 500, 900000, 700000, 8000, 0, 300])
  // token 桶：与 chars 同一量级，工具定义两边相同（来自请求信封）。
  const foldedTokens = bucket([21095, 0, 11196, 125, 3000, 1000, 250, 750, 75])
  const unfoldedTokens = bucket([22500, 0, 11196, 125, 225000, 175000, 2000, 0, 75])
  const firstFolded = bucket([21095, 0, 11196, 125, 3000, 1000, 250, 750, 0])
  const firstUnfolded = bucket([22500, 0, 11196, 125, 225000, 175000, 2000, 0, 0])
  const secondFolded = bucket([0, 0, 0, 0, 0, 0, 0, 0, 75])
  return {
    categories: keys.map((key, index) => ({ key, label: labels[index] })),
    totals: {
      folded: foldedChars,
      unfolded: unfoldedChars,
      sum: { folded: sumOf(foldedChars), unfolded: sumOf(unfoldedChars) },
      tokens: {
        folded: foldedTokens,
        unfolded: unfoldedTokens,
        sum: { folded: sumOf(foldedTokens), unfolded: sumOf(unfoldedTokens) },
      },
    },
    points: [
      {
        ordinal: 1,
        kind: 'turn',
        turn: 1,
        label: 'T1',
        folded: bucket([84381, 0, 0, 500, 12000, 4000, 1000, 3000, 0]),
        unfolded: bucket([90000, 0, 0, 500, 900000, 700000, 8000, 0, 0]),
        totals: { folded: 110500, unfolded: 1698500 },
        tokens: { folded: firstFolded, unfolded: firstUnfolded },
        tokensTotals: { folded: sumOf(firstFolded), unfolded: sumOf(firstUnfolded) },
        cumulative: {
          folded: bucket([84381, 0, 0, 500, 12000, 4000, 1000, 3000, 0]),
          unfolded: bucket([90000, 0, 0, 500, 900000, 700000, 8000, 0, 0]),
        },
        cumulativeTokens: { folded: firstFolded, unfolded: firstUnfolded },
      },
      {
        ordinal: 2,
        kind: 'turn',
        turn: 2,
        label: 'T2',
        folded: bucket([0, 0, 0, 0, 0, 0, 0, 0, 300]),
        unfolded: bucket([0, 0, 0, 0, 0, 0, 0, 0, 300]),
        totals: { folded: 300, unfolded: 300 },
        tokens: { folded: secondFolded, unfolded: secondFolded },
        tokensTotals: { folded: sumOf(secondFolded), unfolded: sumOf(secondFolded) },
        cumulative: { folded: foldedChars, unfolded: unfoldedChars },
        cumulativeTokens: { folded: foldedTokens, unfolded: unfoldedTokens },
      },
    ],
  }
}

test('构成面板、图表与重要消息行能渲染（冒烟）', () => {
  const { module } = loadClient()
  const components = module.__test
  assert.ok(components, '客户端应暴露内部组件供冒烟测试')
  const composition = demoComposition()
  const panel = components.CompositionPanel({ composition })
  assert.equal(typeof panel, 'object')
  assert.equal(panel.type, 'div')
  const chart = components.CompositionChart({ points: composition.points, view: 'unfolded', mode: 'step' })
  assert.equal(chart.type, 'div', '图表外层是测宽容器')
  const svg = chart.children[0]
  assert.equal(svg.type, 'svg')
  // 趋势图高度固定，不随宽度等比放大
  assert.equal(svg.props.height, 132)
  assert.ok(svg.children.length > 0)
  // 面积画当前视角，另一视角用虚线对照，两个视角能同框比较
  assert.ok(JSON.stringify(svg).includes('strokeDasharray'))
  // 趋势标题的说明要跟着视角切换：虚线永远指「另一个」，指反了比不写还误导
  assert.equal(components.otherViewLabel('folded'), '虚线是不折叠视角')
  assert.equal(components.otherViewLabel('unfolded'), '虚线是折叠后视角')
  // 默认视角是折叠后，说明写不折叠；切到不折叠时说明反过来指折叠后
  assert.ok(JSON.stringify(panel).includes('虚线是不折叠视角'))
  const unfoldedPanel = loadClient({ states: ['unfolded'] }).module.__test.CompositionPanel({ composition })
  assert.ok(JSON.stringify(unfoldedPanel).includes('虚线是折叠后视角'))
  assert.ok(!JSON.stringify(unfoldedPanel).includes('虚线是不折叠视角'))
  // 一轮里带一条重要消息：卡片本身与消息行都要能构造出来
  const turn = components.TurnCard({
    group: {
      kind: 'turn',
      turn: 2,
      folded: true,
      foldIds: ['f2'],
      pinLabels: ['结论'],
      // 首包只有分组头与重要消息；普通条目展开这一轮时才从 /fold-turn 取。
      pins: [
        { index: 1, role: 'user', sourceKind: 'fold-pin', isPin: true, pinLabel: '结论', seq: 9, chars: 12, blocks: [{ kind: 'text', text: 'pin' }] },
      ],
    },
  })
  assert.equal(typeof turn, 'object')
  const text = JSON.stringify(panel) + JSON.stringify(turn)
  assert.ok(text.includes('折叠后'))
  assert.ok(text.includes('重要消息'))
  // 两条构成 bar 共用比例尺：不折叠铺满，折叠后按总量比例缩短，长度差就是省下的量
  const section = panel.children[0]
  const foldedLine = section.children[1]
  const unfoldedLine = section.children[2]
  const foldedFill = foldedLine.children[1].children[0]
  const unfoldedTrack = unfoldedLine.children[1]
  const unfoldedFill = unfoldedTrack.children[0]
  const foldedWidth = parseFloat(foldedFill.props.style.width)
  const unfoldedWidth = parseFloat(unfoldedFill.props.style.width)
  assert.equal(unfoldedWidth, 100)
  assert.ok(foldedWidth > 0 && foldedWidth < unfoldedWidth / 2, '折叠后的条应明显短于不折叠：' + foldedWidth + '%')
  // 不折叠条上有一道竖线，标出折叠后保留到的位置
  assert.equal(unfoldedTrack.children.length, 2)
  assert.equal(unfoldedTrack.children[1].props.style.left, foldedWidth.toFixed(2) + '%')
})

test('模型视角：近期重要与长期重要的卡片分色，旧字符串标签仍能渲染', () => {
  const { module } = loadClient()
  const components = module.__test
  const pinEntry = (patch) => Object.assign({
    index: 1, role: 'user', sourceKind: 'fold-pin', isPin: true,
    seq: 9, chars: 12, blocks: [{ kind: 'text', text: '正文' }],
  }, patch)

  const recent = JSON.stringify(components.EntryView({
    entry: pinEntry({ pinLevel: 'recent', pinLabel: '临时结论', sourceLabel: '近期重要（可能过时）' }),
  }))
  // 近期重要：角色文字改口径，整块换天蓝底与蓝色竖线。
  assert.ok(recent.includes('近期重要「临时结论」'), recent.slice(0, 400))
  assert.ok(recent.includes('#0284c7'), '近期重要用天蓝')
  assert.ok(recent.includes('rgba(2,132,199,.10)'), '近期重要用浅蓝底')
  assert.equal(recent.includes('#8250df'), false, '近期重要不该再用长期重要的紫')

  const permanent = JSON.stringify(components.EntryView({
    entry: pinEntry({ pinLevel: 'permanent', pinLabel: '部署路径', sourceLabel: '重要消息（永不折叠）' }),
  }))
  assert.ok(permanent.includes('重要消息「部署路径」'))
  assert.ok(permanent.includes('#8250df'), '长期重要保持紫色')
  assert.equal(permanent.includes('#0284c7'), false)

  // 旧载荷：标签是纯字符串、条目没有 pinLevel，仍按长期重要渲染。
  const legacy = JSON.stringify(components.TurnCard({
    group: { kind: 'turn', turn: 3, folded: true, foldIds: ['f3'], pinLabels: ['旧结论'], pins: [] },
  }))
  assert.ok(legacy.includes('重要消息·旧结论'), legacy.slice(0, 500))
  assert.ok(legacy.includes('#8250df'))

  // 新载荷：标签带级别，近期重要蓝色、长期重要紫色，轮卡片上分得开。
  const mixed = JSON.stringify(components.TurnCard({
    group: {
      kind: 'turn', turn: 4, folded: true, foldIds: ['f4'],
      pinLabels: [{ label: '临时结论', level: 'recent' }, { label: '部署路径', level: 'permanent' }],
      pins: [],
    },
  }))
  assert.ok(mixed.includes('近期重要·临时结论'), mixed.slice(0, 600))
  assert.ok(mixed.includes('重要消息·部署路径'))
  assert.ok(mixed.includes('#0284c7'))
  assert.ok(mixed.includes('#8250df'))
})

test('成本提示只拿「归折叠管的部分」跟实测比，并点明两笔额外开销', () => {
  const { module } = loadClient()
  const noteFor = module.__test.costDriftNote
  assert.equal(typeof noteFor, 'function')
  // 真实形态：折叠后总计 269k（含插件生效前那一轮 222k），实测 62k。
  // 提示若拿总计去比，会得出「实测只有估算的 23%」这种误导结论。
  const note = noteFor({
    estimateTokens: 268943,
    actualPromptTokens: 62390,
    legacyTokens: 221973,
    eraTokens: 46970,
    governedTokens: 46970,
    externalTokens: 15420,
    ratio: 0.2319,
    governedRatio: 1.3282,
    overEstimate: true,
    underEstimate: false,
  })
  assert.ok(note.includes('本插件覆盖的历史约 47.0k token'), note)
  assert.ok(note.includes('实测最近一次请求 62.4k token'), note)
  assert.equal(note.includes('269.0k'), false, '不能用折叠后总计去跟实测比：' + note)
  assert.ok(note.includes('插件生效前那一轮约 222.0k token'), note)
  assert.ok(note.includes('约 15.4k token 是历史之外的开销'), note)
  assert.ok(note.includes('133%'), note)
  // 实测更大时给的是「差额在历史之外」，不是「估算偏高」
  const under = noteFor({ governedTokens: 1000, actualPromptTokens: 4000, externalTokens: 3000, governedRatio: 4, underEstimate: true })
  assert.ok(under.includes('实测比本插件覆盖的部分大'), under)
  assert.ok(under.includes('差额来自历史之外的开销'), under)
  // 还没有 provider 回报时说明原因，不编数字
  assert.ok(noteFor(null).includes('要等本轮有一次模型调用'))
})

test('未命中说明把插件额外开销按来源拆开，分段目录单列', () => {
  const { module } = loadClient()
  const note = module.__test.missNote({
    foldedInputTokens: 5000,
    unfoldedInputTokens: 3200,
    pluginOverhead: { checkpoint: 57, recall: 999, probe: 993, pin: 104 },
  })
  // 目录那 993 token 要单独出现，否则读者会以为「只给目录」没花成本。
  assert.ok(note.includes('分段目录与检索 993'), note)
  assert.ok(note.includes('召回原文 999'), note)
  assert.ok(note.includes('检查点 57'), note)
  assert.ok(note.includes('重要消息 104'), note)
  assert.ok(note.includes('合计 1.8k token'), note)
  // 没有分项时退回旧的笼统说法，不编数字。
  const plain = module.__test.missNote({ foldedInputTokens: 400, unfoldedInputTokens: 100 })
  assert.ok(plain.includes('检查点、固化消息、召回正文'), plain)
  assert.ok(plain.includes('同样算在这笔未命中里'), plain)
})

test('成本参考：头部按 token 计，金额只作折算', () => {
  const { module } = loadClient()
  assert.equal(typeof module.__test.formatMoney, 'function')
  // 金额极小也给得出数，且不出现科学计数法。
  assert.equal(module.__test.formatMoney(0), '¥0')
  assert.equal(module.__test.formatMoney(0.0002), '¥0.0002')
  assert.equal(module.__test.formatMoney(-1.5), '−¥1.50')

  const section = module.__test.CostSection({
    cost: {
      prices: { cacheHit: 0.2, input: 2, output: 3 },
      latest: { promptTokens: 850 },
      drift: null,
      totals: {
        turns: 1,
        steps: 2,
        foldedTokens: 1100,
        unfoldedTokens: 3400,
        foldedHitTokens: 1000,
        foldedInputTokens: 100,
        unfoldedHitTokens: 3000,
        unfoldedInputTokens: 400,
        outputTokens: 50,
        netSavedTokens: 2300,
        savedRate: 0.68,
        foldedMoney: 0.0004,
        unfoldedMoney: 0.0045,
        netSavedMoney: 0.0041,
        actualTurns: 1,
        actualSteps: 2,
        actualHitTokens: 800,
        actualInputTokens: 50,
        actualOutputTokens: 20,
        actualPromptTokens: 850,
        actualMoney: 0.0003,
        latestMoney: 0.0002,
      },
      turns: [{
        turn: 1,
        steps: 2,
        foldedTokens: 1100,
        unfoldedTokens: 3400,
        netSavedTokens: 2300,
        netSavedMoney: 0.0041,
        actualPromptTokens: 850,
      }],
    },
  })
  const text = JSON.stringify(section)
  // 收益与成本用 token 报；金额只在按类别拆分的参考表里出现。
  assert.ok(text.includes('成本参考（按单价折算）'), text.slice(0, 300))
  assert.ok(text.includes('折叠后累计'))
  assert.ok(text.includes('不折叠累计'))
  assert.ok(text.includes('净省'))
  assert.equal(text.includes('折叠后账单'), false, '折叠后账单不再以金额为主指标')
  assert.equal(text.includes('净省金额'), false, '逐轮表不再报净省金额')
  assert.ok(text.includes('缓存命中输入'))
  assert.ok(text.includes('输入（未命中）'))
  assert.ok(text.includes('单价（¥ / M）'))
  assert.ok(text.includes('实测账单'))
  // 命中 1000 token × ¥0.2/M = ¥0.0002
  assert.ok(text.includes('¥0.0002'), text.slice(0, 500))
  // 单价这一列是数值本身，不是金额格式
  assert.ok(text.includes('"¥0.2"'))
})

test('账本头部只用 token 报收益，不出现人民币', () => {
  const { module } = loadClient()
  const kpis = module.__test.ledgerKpis({
    folds: 32,
    savedChars: 6480502,
    savedTokens: 1632463,
    saveRate: 0.99,
    recalls: 5,
    recallTokens: 4600,
    recalledFolds: 3,
    pins: 1,
    pinChars: 245,
    pinTokens: 71,
    netTokens: 1627792,
  }, { tokens: 2000 })
  assert.deepEqual(kpis.map(function (item) { return item.value }), ['+1.6M token', '−4.6k token', '−71 token', '+1.6M token'])
  assert.equal(kpis.some(function (item) { return String(item.value).includes('¥') || String(item.hint).includes('¥') }), false)
  assert.ok(kpis[0].hint.includes('32 段折叠'))
  assert.ok(kpis[1].hint.includes('5 次召回'))
  // 目录/检索不算召回次数（和 store.recallCount 一致），但要让人看见它们也花了 token。
  const withProbes = module.__test.ledgerKpis({
    savedTokens: 100, savedChars: 400, saveRate: 0.5, folds: 1,
    recalls: 5, probes: 3, recallTokens: 4600, recalledFolds: 3,
    pins: 0, pinChars: 0, pinTokens: 0, netTokens: 90,
  }, { tokens: 0 })
  assert.ok(withProbes[1].hint.includes('5 次召回 + 3 次目录/检索'), withProbes[1].hint)
  // 目录与检索只花 token、不返回原文，成本要算，页面得说清这一条。
  assert.ok(withProbes[1].hint.includes('同样计入成本'), withProbes[1].hint)
})

// 收益与成本都不该再拿单价折成人民币：真实请求会被缓存、压缩器和工具定义改写。
test('客户端不再用金额描述折叠收益', () => {
  const source = readFileSync(clientFile, 'utf8')
  assert.equal(source.includes("折叠收益', value: '+' + formatMoney"), false)
  assert.equal(source.includes('moneyNote'), false)
})

test('模型视角：顶部用 KPI 展示关键数字，不再铺大段说明', () => {
  const payload = {
    status: 'ready',
    data: {
      ok: true,
      empty: false,
      totals: {
        messages: 294,
        chars: 877024,
        tokens: 222200,
        checkpoints: 0,
        pins: 0,
        savedChars: 0,
        saveRate: 0,
        staleSystem: { count: 0, chars: 0 },
      },
      actual: {
        promptTokens: 289892,
        inputTokens: 657,
        cacheReadTokens: 289235,
        cacheWriteTokens: 0,
        outputTokens: 1200,
        turn: 8,
        step: 1,
        at: 1,
      },
      groups: [],
      warns: [],
      config: { enabled: false },
      recallTotals: {},
    },
    error: '',
    at: 1794800000000,
  }
  const { module } = loadClient({ states: [payload, 0, false, null, null] })
  const json = JSON.stringify(module.__test.ModelView({ sessionId: 's1' }))
  // 关键数字各占一张 KPI：消息、字数、估算、最近请求、省下。
  assert.ok(json.includes('294 条'))
  assert.ok(json.includes('877.0k 字'))
  assert.ok(json.includes('222.2k token'))
  assert.ok(json.includes('289.9k token'))
  assert.ok(json.includes('新输入 657'))
  assert.ok(json.includes('省下'))
  // 旧的整段说明与 provider 长句不再占位。
  assert.equal(json.includes('折叠后的会话历史'), false)
  assert.equal(json.includes('provider 回报：最近一次请求的计费输入'), false)
  assert.equal(json.includes('这里的估算与账单同向'), false)
})

test('模型视角：轮内正文按需拉，首包只带分组头与重要消息', () => {
  const source = readFileSync(clientFile, 'utf8')
  assert.ok(source.includes("fetch('/fold-turn?session='"), '展开一轮时才去取这一轮的正文')
  assert.ok(source.includes('正在读取这一轮的正文…'))
  assert.ok(source.includes('这一轮的正文读取失败'))
  // 卡片外的常显部分只认 group.pins；轮内条目不再从首包读
  assert.ok(source.includes('var pins = Array.isArray(group.pins) ? group.pins : []'))
  assert.equal(source.includes('var entries = Array.isArray(group.entries) ? group.entries : []\n      var pins'), false)
})

test('参数表单只挂在插件页，折叠 tab 不再有设置入口', () => {
  const source = readFileSync(clientFile, 'utf8')
  assert.ok(source.includes("['ledger', '账本']"))
  assert.ok(source.includes("['model', '模型视角']"))
  assert.equal(source.includes("'settings', '设置'"), false)
  assert.ok(source.includes("fetch('/fold-config'"))
  // 重要消息不再在页顶单独汇总，改为按时间顺序贴在轮次里
  assert.equal(source.includes('PinsPanel'), false)
  // 构成图跟着账本走：账本单独拉 /fold-composition，模型视角不再画它
  assert.ok(source.includes("fetch('/fold-composition?session='"))
  assert.ok(source.includes('COMPOSITION_REFRESH_MS'))
  assert.equal(source.includes('data.composition'), false)
  // 两张图左右并排，窄屏自动堆叠，不再被拉成一整条
  assert.ok(source.includes('repeat(auto-fit, minmax(320px, 1fr))'))
})
test('账单页写明命中率与校准来源', () => {
  const { module } = loadClient()
  const note = module.__test.calibrationNote({
    hitRate: 0.975,
    measuredHitRate: 0.975,
    calibration: { coveredTurns: 6, promptScale: 0.48, outputScale: 1.92 },
  })
  assert.ok(note.includes('命中率 97.5%（provider 实测）'), note)
  assert.ok(note.includes('按 6 轮回报反推校准'), note)
  assert.ok(note.includes('提示词 ×0.48'), note)
  assert.ok(note.includes('输出 ×1.92'), note)
  // 结算用的是扣掉每步新增内容后的命中率；它和展示值差得多时要写出来，别让人拿展示值反算金额。
  const settled = module.__test.calibrationNote({
    hitRate: 0.983,
    resendHitRate: 0.999,
    measuredHitRate: 0.983,
    calibration: { coveredTurns: 1, promptScale: 1, outputScale: 1 },
  })
  assert.ok(settled.includes('扣掉每步新增内容后'), settled)
  const cold = module.__test.calibrationNote({})
  assert.ok(cold.includes('（默认值）'), cold)
  assert.ok(cold.includes('按 1 计'), cold)
  // 没给 prices 时用空闲时段默认价，不退回 V3.2 那套。
  const section = module.__test.CostSection({ cost: { totals: {}, turns: [] } })
  assert.ok(JSON.stringify(section).includes('命中 ¥0.02'), JSON.stringify(section).slice(0, 400))
})
test('折叠原文面板与召回同形：整段/目录两种形态与目录行格式', () => {
  const { module } = loadClient()
  const t = module.__test
  const record = {
    items: [
      { seq: 7, blocks: [
        { kind: 'think', text: '[思考] ' + '思'.repeat(40) },
        { kind: 'call', name: 'read', text: '[调用 read] {}' },
        { kind: 'reply', text: '[回复] ' + '答'.repeat(30) },
      ] },
      { seq: 8, blocks: [{ kind: 'result', text: '[工具结果] ' + '果'.repeat(50) }] },
    ],
  }
  const parts = t.foldPartsOf(record)
  assert.equal(parts.length, 4)
  assert.equal(parts[0].no, 1)
  assert.equal(parts[3].no, 4)
  assert.equal(parts[1].kind, 'call')

  // 小记录：目录比原文还长，整段返回。
  const small = t.recallPlan(record)
  assert.equal(small.direct, true)

  // 大记录才轮到目录；每行在预览与原文间二选一，预览长度由 previewChars 决定。
  const longRecord = { items: Array.from({ length: 10 }, function (_, i) { return { seq: i + 1, blocks: [{ kind: 'think', text: '[思考] ' + '思'.repeat(400) }] } }) }
  const longPlan = t.recallPlan(longRecord)
  assert.equal(longPlan.direct, false)
  const longLines = t.recallIndexLines(longPlan.parts, longPlan.previewChars)
  assert.ok(longLines[0].includes('…'), longLines[0])
  assert.ok(longLines[0].length < 400 * 0.5, '预览不该被比例截短：' + longLines[0].length)

  const lines = t.recallIndexLines(parts, 10)
  assert.ok(lines[0].startsWith('#1 [思考] '))
  // 目录行同时给字数与 token：字数在 formatCharsTokens 里带「字」，token 以（≈N token）结尾。
  assert.ok(lines[0].includes('字（≈'))
  assert.ok(lines[0].includes('…'), '长段给截断预览：' + lines[0])
  // 短段（{}）截成预览并不更短：这一行直接给原文。
  assert.ok(lines[1].startsWith('#2 [调用 read] '))
  assert.ok(lines[1].endsWith('：{}'), '短段直接给原文：' + lines[1])
})

test('客户端分段与召回同规则：长 markdown 回复按标题切段', () => {
  const { module } = loadClient()
  const t = module.__test
  const md = '## 结论\n' + 'a'.repeat(120) + '\n## 改动\n' + 'b'.repeat(120)
  const record = { items: [{ seq: 1, blocks: [{ kind: 'reply', text: '[回复] ' + md }] }] }
  assert.equal(t.foldPartsOf(record).length, 1)
  const split = t.foldPartsOf(record, { replySplitChars: 100 })
  assert.equal(split.length, 2)
  assert.equal(split[0].kind, 'reply')
  assert.ok(split[0].text.startsWith('[回复] ## 结论'), split[0].text)
  assert.equal(split[0].chars, ('## 结论\n' + 'a'.repeat(120)).length)
})

test('模型视角的召回标记：条目、折叠段与轮次标签', () => {
  const { module } = loadClient()
  const t = module.__test
  assert.equal(t.recallChipLabel({ id: 'f1c', parts: '48' }), '召回 f1c · 段 48')
  assert.equal(t.recallChipLabel({ id: 'f3', query: 'lib/web.js' }), '召回 f3 · 筛「lib/web.js」')
  assert.equal(t.recallChipLabel({ query: 'lib/web.js' }), '检索「lib/web.js」')
  assert.ok(t.recallCallTitle({ id: 'f1c', via: 'run_code' }).includes('在 run_code 里调用'))

  // 段号优先于原始选择器：parts 写 reply，解析出的 #128 才是「取过哪一段」。
  assert.equal(t.recallChipLabel({ id: 'f4', parts: 'reply', segments: [128], segmentCount: 1 }), '召回 f4 · 段 #128')
  assert.equal(t.recallChipLabel({ id: 'f3', parts: '1,3-5', segments: [1, 3, 4, 5], segmentCount: 4 }), '召回 f3 · 段 #1,#3-#5')
  // 段号超出下发上限时给区间加总数，不让 chip 变成一串数字。
  assert.equal(t.recallChipLabel({ id: 'f3', parts: 'all', segments: [1, 2, 3], segmentCount: 9 }), '召回 f3 · 段 #1-#3 等 9 段')
  assert.ok(t.recallCallTitle({ id: 'f4', parts: 'reply', segments: [128], segmentCount: 1 }).includes('取回 #128'))
  // 工具结果写明的三种形态：整段、只给目录、失败。chip 不假装有段号，原因写在 title 里。
  assert.equal(t.recallChipLabel({ id: 'f3', outcome: 'direct', segments: [1, 2, 3], segmentCount: 3 }), '召回 f3 · 整段 3 段')
  assert.equal(t.recallChipLabel({ id: 'f3', outcome: 'index', segments: [1, 2], segmentCount: 2 }), '召回 f3 · 目录 2 段')
  assert.equal(t.recallChipLabel({ id: 'f3', outcome: 'error', note: '折叠 f3 里没有回复段' }), '召回 f3 · 未取回')
  assert.ok(t.recallCallTitle({ id: 'f3', outcome: 'error', note: '折叠 f3 里没有回复段' }).includes('未取回：折叠 f3 里没有回复段'))
  assert.ok(t.recallCallTitle({ id: 'f3', outcome: 'direct' }).includes('整段返回'))

  const entry = t.EntryView({
    entry: {
      index: 2,
      role: 'assistant',
      roleLabel: '助手',
      chars: 10,
      blocks: [{ kind: 'call', name: 'run_code', text: 'await tools.fold_recall({ id: "f1c" })' }],
      recallCalls: [{ id: 'f1c', query: '', parts: '48', via: 'run_code' }],
    },
  })
  const entryText = JSON.stringify(entry)
  assert.ok(entryText.includes('召回 f1c · 段 48'), entryText.slice(0, 600))

  const checkpoint = t.EntryView({
    entry: {
      index: 3,
      role: 'user',
      isCheckpoint: true,
      foldId: 'f1c',
      chars: 20,
      blocks: [],
      recallCalls: [],
      foldedRecallCount: 2,
      recalledCount: 3,
      foldRecord: {
        id: 'f1c',
        items: [{ seq: 5, chars: 10, blocks: [{ kind: 'call', name: 'fold_recall', text: '{}' }], recallCalls: [{ id: 'f2', query: '', parts: '', via: '' }] }],
      },
    },
  })
  const checkpointText = JSON.stringify(checkpoint)
  assert.ok(checkpointText.includes('含召回 2 次'), checkpointText.slice(0, 600))
  assert.ok(checkpointText.includes('被召回 3 次'), checkpointText.slice(0, 600))

  const turn = t.TurnCard({
    group: {
      kind: 'turn',
      turn: 1,
      steps: 1,
      chars: 100,
      recallCallCount: 2,
      recallSearchCount: 1,
      recalledCount: 1,
      pins: [],
    },
  })
  const turnText = JSON.stringify(turn)
  assert.ok(turnText.includes('召回 2 次'), turnText.slice(0, 800))
  assert.ok(turnText.includes('检索 1 次'), turnText.slice(0, 800))
  assert.ok(turnText.includes('被召回 1 次'), turnText.slice(0, 800))
})

test('段级召回标记：目录行、段头与折叠原文面板都带次数', () => {
  const { module } = loadClient()
  const t = module.__test
  const parts = [
    { no: 1, kind: 'think', name: '', text: '第一段', chars: 3 },
    { no: 2, kind: 'result', name: '', text: '第二段', chars: 3 },
  ]
  const lines = t.recallIndexLines(parts, 20, { 2: 2 })
  assert.equal(lines[0].includes('召回×'), false)
  assert.ok(lines[1].includes('召回×2'), lines[1])

  const record = {
    items: [
      { seq: 1, blocks: [{ kind: 'think', text: '第一段' }] },
      { seq: 2, blocks: [{ kind: 'result', text: '第二段' }] },
    ],
  }
  const item = t.FoldItem({ index: 2, recallCount: 2, item: record.items[1] })
  assert.ok(JSON.stringify(item).includes('被召回 2 次'), JSON.stringify(item).slice(0, 500))
  // 收起的折叠原文面板也要在标题上给出合计，不必逐段展开。
  const original = t.FoldOriginal({ record: record, recalledParts: { 2: 2 } })
  assert.ok(JSON.stringify(original).includes('其中 1 段被召回 2 次'), JSON.stringify(original).slice(0, 600))
  assert.equal(t.partRecallCount({ 2: 2 }, 2), 2)
  assert.equal(t.partRecallCount({ 2: 2 }, 3), 0)
})

test('被检索：检索引用落到分段目录，目录反过来能查到检索', () => {
  const { module } = loadClient()
  const t = module.__test

  // 1) 检索 chip 直接写命中量：只给 query 的调用没有折叠编号，命中的是一条条折叠的目录。
  assert.equal(
    t.recallChipLabel({ query: 'lib/web.js', outcome: 'search', searchFoldCount: 2, searchPartCount: 3 }),
    '检索「lib/web.js」 · 2 折叠 3 段',
  )

  // 2) 检索调用的引用：每条折叠先一行「分段目录」，再逐段列出命中的段号。
  const captured = []
  t.NAV.refs = function (info) { captured.push(info) }
  t.openCallRefs({
    query: 'lib/web.js',
    outcome: 'search',
    searchFoldCount: 2,
    searchPartCount: 3,
    searchHits: [
      { id: 'f1', turn: 1, count: 2, totalParts: 3, numbers: [1, 2], unlisted: 1, loc: { o: 2, i: 5 } },
      // 命中的折叠不在这份历史里：不推可点条目，也不冒充落到别处。
      { id: 'f9', turn: 1, count: 1, totalParts: 2, numbers: [1] },
    ],
  })
  const panel = captured[0]
  assert.ok(panel.title.includes('检索调用 · 检索「lib/web.js」'), panel.title)
  assert.ok(panel.items[0].label.includes('f1（第 1 轮）· 分段目录 · 命中 2/3 段'), panel.items[0].label)
  assert.deepEqual(panel.items[0].target, { o: 2, i: 5, dir: true })
  assert.equal(panel.items[1].label, 'f1 段 #1')
  assert.deepEqual(panel.items[1].target, { o: 2, i: 5, part: 1 })
  assert.equal(panel.items.some((item) => item.label.startsWith('f9')), false)
  assert.ok(panel.note.includes('另有 1 段命中'), panel.note)

  // 3) 目录反过来查检索：段级走 searchedParts，折叠级走 searchedRefs。
  t.openSearchRefs({ 2: [{ o: 2, i: 5, t: 2, query: 'lib/web.js' }] }, [], 2)
  const segPanel = captured[1]
  assert.equal(segPanel.title, '第 2 段被检索过')
  assert.ok(segPanel.items[0].label.includes('检索「lib/web.js」'), segPanel.items[0].label)
  assert.deepEqual(segPanel.items[0].target, { o: 2, i: 5 })
  t.openSearchRefs({}, [{ o: 2, i: 5, t: 2, query: 'lib/web.js', count: 2, totalParts: 3, numbers: [1, 2] }], 0)
  const dirPanel = captured[2]
  assert.equal(dirPanel.title, '这张分段目录被检索过')
  assert.ok(dirPanel.items[0].label.includes('命中 2/3 段'), dirPanel.items[0].label)
  assert.ok(dirPanel.items[0].label.includes('#1-#2'), dirPanel.items[0].label)

  // 4) 段级标记：段头「被检索」、目录行「检索×N」，与被召回分开算。
  assert.equal(t.partSearchCount({ 2: [{}, {}] }, 2), 2)
  assert.equal(t.partSearchCount({ 2: [{}, {}] }, 1), 0)
  const item = t.FoldItem({
    index: 2,
    item: { seq: 3, chars: 20, blocks: [{ kind: 'result', text: '第二段' }] },
    searchedParts: { 2: [{ o: 2, i: 5, query: 'lib/web.js' }] },
  })
  const itemText = JSON.stringify(item)
  assert.ok(itemText.includes('被检索 1 次'), itemText.slice(0, 500))
  assert.ok(itemText.includes('"color":"#f97316"'), itemText.slice(0, 500))
  const lines = t.recallIndexLines(
    [
      { no: 1, kind: 'think', name: '', text: '第一段', chars: 3 },
      { no: 2, kind: 'result', name: '', text: '第二段', chars: 3 },
    ],
    20,
    { 2: 2 },
    { 1: [{ o: 2, i: 5 }] },
  )
  assert.ok(lines[0].includes('检索×1'), lines[0])
  assert.equal(lines[1].includes('检索×'), false, lines[1])
  assert.ok(lines[1].includes('召回×2'), lines[1])

  // 5) 目录被检索与折叠原文合计：收起时也能看出「只是被检索、没取原文」。
  t.openSearchRefs({}, [{ o: 2, i: 5, t: 2, query: 'lib/web.js', count: 2, totalParts: 3, numbers: [1, 2] }], 0)
  const longRecord = { items: Array.from({ length: 40 }, function (_, i) { return { seq: i + 1, blocks: [{ kind: 'think', text: '[思考] ' + '思'.repeat(400) }] } }) }
  const original = t.FoldOriginal({
    record: longRecord,
    searchedParts: { 2: [{ o: 2, i: 5 }] },
    searchedRefs: [{ o: 2, i: 5, t: 2, count: 2, totalParts: 40, numbers: [2, 5] }],
    searchedCount: 1,
  })
  const originalText = JSON.stringify(original)
  assert.ok(originalText.includes('其中 1 段被检索 1 次'), originalText.slice(0, 900))

  // 6) 检查点条目与轮次标签也带「被检索」，与页头合计同向相加。
  const checkpoint = t.EntryView({
    entry: {
      index: 6,
      role: 'user',
      isCheckpoint: true,
      foldId: 'f1',
      chars: 20,
      blocks: [],
      searchedCount: 1,
      searchedPartCount: 2,
      searchedRefs: [{ o: 2, i: 5, t: 2, query: 'lib/web.js', count: 2, totalParts: 3 }],
      searchedParts: { 2: [{ o: 2, i: 5, t: 2, query: 'lib/web.js' }] },
      foldRecord: { id: 'f1', items: [{ seq: 1, chars: 4, blocks: [{ kind: 'think', text: '第一段' }] }] },
    },
  })
  const checkpointText = JSON.stringify(checkpoint)
  assert.ok(checkpointText.includes('被检索 1 次 · 2 段次'), checkpointText.slice(0, 700))
  assert.ok(checkpointText.includes('"color":"#f97316"'), checkpointText.slice(0, 700))

  const turn = t.TurnCard({
    group: { kind: 'turn', turn: 1, steps: 1, chars: 100, searchedCount: 1, searchedPartCount: 2, pins: [] },
  })
  const turnText = JSON.stringify(turn)
  assert.ok(turnText.includes('被检索 1 次 · 2 段次'), turnText.slice(0, 900))
})

test('召回标记按方向分色：被召回红、召回黄、检索橘黄', () => {
  const { module } = loadClient()
  const t = module.__test
  // 三种方向各自的颜色：同一屏里要能只凭颜色分出「谁取了原文」「谁只是检索」「谁被取过」。
  const entry = t.EntryView({
    entry: {
      index: 2,
      role: 'assistant',
      chars: 10,
      blocks: [],
      recallCalls: [{ id: 'f4', parts: 'reply', segments: [128], segmentCount: 1 }, { query: 'lib/web.js' }],
      foldedRecallCount: 1,
      foldedSearchCount: 1,
      recalledCount: 2,
      recalledPartCount: 3,
    },
  })
  const entryText = JSON.stringify(entry)
  assert.ok(entryText.includes('"color":"#eab308"'), '召回调用是黄的：' + entryText.slice(0, 400))
  assert.ok(entryText.includes('"color":"#f97316"'), '检索是橘黄的：' + entryText.slice(0, 400))
  assert.ok(entryText.includes('"color":"#ef4444"'), '被召回是红的：' + entryText.slice(0, 400))

  // 是召回还是检索按有没有折叠编号分：只给 query 的不动原文，算检索。
  const searchOnly = t.EntryView({ entry: { index: 3, role: 'assistant', chars: 5, blocks: [], recallCalls: [{ query: 'design.md' }] } })
  assert.ok(JSON.stringify(searchOnly).includes('"color":"#f97316"'))
  assert.equal(JSON.stringify(searchOnly).includes('"color":"#eab308"'), false)

  // 段条目里的调用、折叠原文标题的合计、目录行的召回次数都跟同一套颜色走。
  const item = t.FoldItem({
    index: 4,
    recallCount: 2,
    item: { seq: 128, chars: 20, recallCalls: [{ id: 'f4', parts: 'reply', segments: [128], segmentCount: 1 }], blocks: [{ kind: 'reply', text: '[回复] hi' }] },
  })
  const itemText = JSON.stringify(item)
  assert.ok(itemText.includes('"color":"#eab308"'), itemText.slice(0, 400))
  assert.ok(itemText.includes('"color":"#ef4444"'), itemText.slice(0, 400))

  const record = { items: Array.from({ length: 40 }, function (_, i) { return { seq: i + 1, blocks: [{ kind: 'think', text: '[思考] ' + '思'.repeat(400) }] } }) }
  const original = t.FoldOriginal({ record: record, recalledParts: { 2: 3 } })
  const originalText = JSON.stringify(original)
  assert.ok(originalText.includes('其中 1 段被召回 3 次'), originalText.slice(0, 400))
  assert.ok(originalText.includes('"color":"#ef4444"'), '折叠原文标题与目录行用被召回的红色：' + originalText.slice(0, 400))
})

test('折叠原文里的调用带段号，并能从段号反查到调用点', () => {
  const { module } = loadClient({ open: true })
  const t = module.__test
  const record = {
    id: 'f4',
    replyTruncated: true,
    items: [
      {
        seq: 128,
        blocks: [
          { kind: 'think', text: '[思考] 先看上一轮说了什么' },
          { kind: 'call', name: 'fold_recall', text: '{"id":"f4","parts":["128"]}' },
        ],
        recallCalls: [{ id: 'f4', parts: 'reply', segments: [128], segmentCount: 1 }],
        recallCallBlocks: [1],
      },
    ],
  }
  const parts = t.foldPartsOf(record)
  // 调用随段带出来，但只挂在发出它的那一块上：同一消息的思考段不重复标。
  assert.deepEqual(parts[0].calls, [])
  assert.equal(parts[1].calls[0].id, 'f4')

  // 段条目拿到的 refs 就是这一段自己的引用：同一份表既渲染「被召回」，也供面板跳转。
  const refs = [{ o: 6, i: 24, t: 5, id: 'f4' }]
  const node = t.FoldOriginal({ record: record, recalledParts: { 1: 1 }, partRefs: { 1: refs } })
  const items = []
  const walk = function (list) {
    for (const child of list) {
      if (!child) continue
      if (Array.isArray(child)) { walk(child); continue }
      if (child.type === t.FoldItem) items.push(child)
      else if (Array.isArray(child.children)) walk(child.children)
    }
  }
  walk(node.children)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0].props.refs, refs)
  // 被召回的是第 1 段（思考段），发起调用的是第 2 段（调用段）：两边各标各的。
  const recalledText = JSON.stringify(t.FoldItem(items[0].props))
  assert.ok(recalledText.includes('被召回 1 次'), recalledText.slice(0, 800))
  assert.equal(recalledText.includes('召回 f4 · 段 #128'), false, '思考段不该重复标调用：' + recalledText.slice(0, 800))
  const callText = JSON.stringify(t.FoldItem(items[1].props))
  assert.ok(callText.includes('召回 f4 · 段 #128'), callText.slice(0, 800))
  assert.equal(callText.includes('被召回 1 次'), false)

  // 被引用的一端：同一次调用的多段并成一条，写明轮次与折叠编号，目标就是调用条目。
  assert.deepEqual(
    t.partRefItems({ 128: [{ o: 6, i: 24, t: 5, id: 'f4' }], 129: [{ o: 6, i: 24, t: 5, id: 'f4' }] }),
    [{ label: '第 5 轮 · 召回 f4 · 段 #128-#129', target: { o: 6, i: 24 } }]
  )
})

test('引用落点精确到调用所在的那一段，并能按段过滤', () => {
  const { module } = loadClient()
  const t = module.__test
  // 同一轮里两处调用取回了同一段：两条落点各带自己的段号，跳转才不会都停在检查点上。
  const table = {
    128: [
      { o: 6, i: 24, t: 5, id: 'f4', part: 20 },
      { o: 6, i: 30, t: 5, id: 'f4' },
    ],
    129: [{ o: 6, i: 24, t: 5, id: 'f4', part: 20 }],
  }
  assert.deepEqual(t.partRefItems(table), [
    { label: '第 5 轮 · 召回 f4 · 段 #128-#129 · 调用在第 20 段', target: { o: 6, i: 24, part: 20 } },
    { label: '第 5 轮 · 召回 f4 · 段 #128', target: { o: 6, i: 30 } },
  ])
  // 从一段反查：只列这一段自己的调用，别把同一份折叠里别的段也叫进来。
  assert.deepEqual(t.partRefItems(table, 129), [
    { label: '第 5 轮 · 召回 f4 · 段 #129 · 调用在第 20 段', target: { o: 6, i: 24, part: 20 } },
  ])
})

test('段上的「被召回」只列这一段自己的引用', () => {
  const { module } = loadClient({ open: true })
  const t = module.__test
  const captured = []
  t.NAV.refs = function (info) { captured.push(info) }
  const partRefs = {
    195: [{ o: 4, i: 17, t: 3, id: 'f3', part: 2 }],
    196: [{ o: 4, i: 17, t: 3, id: 'f3', part: 2 }],
  }
  const node = t.FoldItem({
    index: 195,
    recallCount: 1,
    partRefs: partRefs,
    refs: partRefs[195],
    item: { seq: 1, chars: 10, blocks: [{ kind: 'think', text: '[思考] x' }] },
  })
  const summary = node.children[0]
  const chip = summary.children.find(function (child) { return child && child.props && typeof child.props.onClick === 'function' })
  assert.ok(chip, '收回行里的「被召回」标签应当可点：' + JSON.stringify(summary).slice(0, 600))
  chip.props.onClick({ preventDefault: function () {}, stopPropagation: function () {} })
  assert.equal(captured[0].title, '第 195 段被谁召回过')
  assert.deepEqual(captured[0].items, [
    { label: '第 3 轮 · 召回 f3 · 段 #195 · 调用在第 2 段', target: { o: 4, i: 17, part: 2 } },
  ])
})

test('轮卡片上的召回与被召回能点开引用，并落到调用那一段', async () => {
  const { module } = loadClient()
  const t = module.__test
  const captured = []
  t.NAV.refs = function (info) {
    captured.push(info)
    t.NAV.panelGen = (t.NAV.panelGen || 0) + 1
  }
  const entries = [{
    index: 14,
    isCheckpoint: true,
    foldId: 'f2',
    roleLabel: 'user',
    partRefs: { 128: [{ o: 6, i: 24, t: 5, id: 'f4', part: 20 }] },
    foldRecord: {
      items: [
        { seq: 9, blocks: [{ kind: 'think', text: '[思考] 想' }] },
        {
          seq: 9,
          blocks: [{ kind: 'call', name: 'run_code', text: '{}' }],
          recallCalls: [{ id: 'f4', segments: [128], segmentCount: 1, partNo: 2 }],
          recallCallBlocks: [0],
        },
      ],
    },
  }]
  // 调用落在折叠原文里：列表给的是「检查点 + 第几段」，点一下能直接展开到那一段。
  assert.deepEqual(t.turnCallItems(entries, 3), [
    { label: '折叠摘要 f2 · 召回 f4 · 段 #128 · 调用在第 2 段', target: { o: 3, i: 14, part: 2 } },
  ])
  assert.deepEqual(t.turnRecalledItems(entries), [
    { label: '第 5 轮 · 召回 f4 · 段 #128 · 调用在第 20 段', target: { o: 6, i: 24, part: 20 } },
  ])

  const turn = t.TurnCard({
    group: { kind: 'turn', ordinal: 3, turn: 2, steps: 1, recallCallCount: 1, recalledCount: 1, recalledPartCount: 1 },
    sessionId: 's1',
    stamp: 1,
  })
  const summary = turn.children[0].children[0]
  const chips = summary.children[0].children[1]
  const callChip = chips.find(function (chip) { return String(chip.children[0]).indexOf('召回 1 次') === 0 })
  const recalledChip = chips.find(function (chip) { return String(chip.children[0]).indexOf('被召回 1 次') === 0 })
  assert.ok(callChip && recalledChip, JSON.stringify(chips).slice(0, 600))

  const events = []
  const event = {
    preventDefault: function () { events.push('preventDefault') },
    stopPropagation: function () { events.push('stopPropagation') },
  }
  callChip.props.onClick(event)
  // 标签在 summary 里：不掐掉默认行为，点标签就只会把整轮展开。
  assert.deepEqual(events, ['preventDefault', 'stopPropagation'])
  assert.equal(captured[0].title, '第 2 轮 · 召回调用')
  assert.deepEqual(captured[0].items, [])
  assert.ok(captured[0].note.includes('正在读取'), captured[0].note)

  recalledChip.props.onClick(event)
  await new Promise(function (resolve) { setTimeout(resolve, 0) })
  // 测试环境没有网络：加载失败要说原因，而不是留一个空面板。
  const last = captured[captured.length - 1]
  assert.equal(last.title, '第 2 轮 · 被召回的段')
  assert.ok(last.note.includes('读取这一轮的正文失败'), last.note)
})

test('同一消息的思考段不重复标记召回调用', () => {
  const { module } = loadClient()
  const t = module.__test
  const calls = [{ id: 'f1c', parts: '48', segments: [48], segmentCount: 1 }]
  const blocks = [{ kind: 'think', text: '[思考] 想' }, { kind: 'call', name: 'run_code', text: '{}' }]

  // 有块归属：只挂到第 2 块（调用块）。
  const owned = t.foldPartsOf({ items: [{ seq: 9, blocks: blocks, recallCalls: calls, recallCallBlocks: [1] }] })
  assert.deepEqual(owned.map((part) => part.calls.length), [0, 1])

  // 老数据没有块归属：调用块整条带走，思考段仍然不标。
  const legacy = t.foldPartsOf({ items: [{ seq: 9, blocks: blocks, recallCalls: calls }] })
  assert.deepEqual(legacy.map((part) => part.calls.length), [0, 1])

  // 只有思考块却被挂上了调用记录（旧载荷）：一段也不标，宁可不标也不标错。
  const thinkOnly = t.foldPartsOf({ items: [{ seq: 9, blocks: [blocks[0]], recallCalls: calls }] })
  assert.deepEqual(thinkOnly[0].calls, [])
})

test('引用面板给落点段带正文预览', () => {
  const { module } = loadClient()
  const t = module.__test
  const record = {
    items: [
      { seq: 5, blocks: [{ kind: 'think', text: '[思考] 先读 f4 的目录' }] },
      { seq: 5, blocks: [{ kind: 'call', name: 'read', text: '{}' }] },
    ],
  }
  const entries = [{ index: 3, isCheckpoint: true, foldRecord: record }]
  assert.equal(t.segmentPreviewOf(entries, { o: 1, i: 3, part: 1 }), '先读 f4 的目录')
  // 段号越界、条目对不上都不给预览：面板只显示段号，不猜内容。
  assert.equal(t.segmentPreviewOf(entries, { o: 1, i: 3, part: 9 }), '')
  assert.equal(t.segmentPreviewOf(entries, { o: 1, i: 4, part: 1 }), '')
  assert.equal(t.segmentPreviewOf(entries, { o: 1, i: 3 }), '')

  // 预览去掉段头的 [类型] 前缀，长段只取开头一段。
  const long = t.segmentPreview('[工具结果] ' + '果'.repeat(300))
  assert.equal(long.endsWith('…'), true, long)
  assert.ok(long.length <= 121, '预览长度：' + long.length)
  assert.equal(t.segmentPreview('[工具结果] '), '')

  // 只有「跳到某一段」的条目才有预览键。
  assert.equal(t.panelKeyOf({ target: { o: 2, i: 3, part: 4 } }), '2:3:4')
  assert.equal(t.panelKeyOf({ target: { o: 2, i: 3 } }), '')
  assert.equal(t.panelKeyOf({ target: { o: 6, i: 24 } }), '')
})

test('折叠原文的分段目录收成一行，段列表仍是逐段折叠条目', () => {
  const { module } = loadClient({ open: true })
  const t = module.__test
  const record = {
    id: 'f9',
    turn: 9,
    replyTruncated: true,
    items: Array.from({ length: 10 }, function (_, i) {
      return { seq: 100 + i, blocks: [{ kind: 'think', text: '思'.repeat(400) }] }
    }),
  }
  const node = t.FoldOriginal({ record: record, config: { maxRecallTokens: 1000, recallIndexPreviewTokens: 25, minFoldRatio: 0.5 } })
  const body = node.children[1]
  assert.ok(body, '展开后应拿到原文面板正文')
  // 假 createElement 不会像 React 那样摊平数组子节点，这里自己摊平一层。
  const flat = function (nodes) {
    const out = []
    const walk = function (list) {
      for (const child of list) {
        if (Array.isArray(child)) walk(child)
        else out.push(child)
      }
    }
    walk(nodes)
    return out
  }
  const bodyItems = flat(body.children)
  const dir = bodyItems.find(function (child) { return child && child.type === 'details' })
  assert.ok(dir, '目录应是独立的折叠条目')
  // 收起行除了行数，还要给目录自身的字数与 token：目录是第一遍真正发给模型的东西，
  // 只写「10 行」看不出这一面墙多大；原文合计在标题行，两者别混。
  const dirHead = JSON.stringify(dir.children[0])
  assert.ok(dirHead.includes('分段目录 · 10 行 · '), dirHead)
  assert.ok(/[\d.]+k? 字（≈[\d.]+k? token） · 召回时按这里的段号选/.test(dirHead), dirHead)
  // 目录行只在点开时才挂进树；默认收起的状态由 useLazyOpen 保证（open:false 时不渲染正文）。
  assert.equal(typeof dir.props.onToggle, 'function')
  const segments = bodyItems.filter(function (child) { return child && child.type === t.FoldItem })
  assert.equal(segments.length, 10, '每段仍是自己的折叠条目')
  // 目录行不再直接铺在原文面板第一层：第一层只有目录与段条目。
  assert.equal(bodyItems.length, 11)
})

test('清单过长时进滚动区：展开只多一屏，页面高度不随段数增长', () => {
  const { module } = loadClient({ open: true })
  const t = module.__test
  // 假 createElement 不摊平数组子节点，这里自己摊平一层。
  const flat = function (nodes) {
    const out = []
    const walk = function (list) {
      for (const child of list) {
        if (Array.isArray(child)) walk(child)
        else out.push(child)
      }
    }
    walk(nodes)
    return out
  }
  const many = function (count, chars) {
    return Array.from({ length: count }, function (_, i) {
      return { seq: 1000 + i, blocks: [{ kind: 'think', text: '思'.repeat(chars) }] }
    })
  }
  const isScroller = function (child) {
    return Boolean(child && child.props && child.props.style && child.props.style.overflowY === 'auto')
  }
  const config = { maxRecallTokens: 1000, recallIndexPreviewTokens: 25, minFoldRatio: 0.5 }

  // 长清单：60 段整份进一个限高的滚动框，段数再多页面也只多一屏。
  const long = t.FoldOriginal({ record: { id: 'f9', turn: 9, replyTruncated: true, items: many(60, 40) }, config: config })
  const longBody = flat(long.children[1].children)
  const partBox = longBody.find(isScroller)
  assert.ok(partBox, '长清单应装进滚动区')
  assert.ok(String(partBox.props.style.maxHeight).includes('vh'), '限高按视口算，不写死像素')
  assert.equal(flat(partBox.children).filter(function (child) { return child && child.type === t.FoldItem }).length, 60)

  // 目录行同样限高：60 行的目录点开也只占一屏（短段才会走到目录这一支）。
  const wide = t.FoldOriginal({ record: { id: 'f9', turn: 9, replyTruncated: true, items: many(60, 400) }, config: config })
  const wideBody = flat(wide.children[1].children)
  const dir = wideBody.find(function (child) { return child && child.type === 'details' })
  assert.ok(dir, '目录应是独立的折叠条目')
  // 目录正文那一层就是滚动框本身（点开后才有），不必再往里摊一层。
  assert.ok(isScroller(dir.children[1]), '60 行的目录应装进滚动区')

  // 短清单不套壳：10 段以内仍直接挂在面板第一层。
  const short = t.FoldOriginal({ record: { id: 'f9', turn: 9, replyTruncated: true, items: many(10, 40) }, config: config })
  assert.equal(flat(short.children[1].children).some(isScroller), false)

  // 召回结果里的取回段也是同一套：段多了限高，尾注（切分点、没取回）留在框外。
  const segments = Array.from({ length: 30 }, function (_, i) {
    return { no: i + 1, label: '思考', text: 'x'.repeat(50), cut: null }
  })
  const view = t.RecallResult({
    parsed: {
      kind: 'parts', id: 'f4', turn: 4, picked: 30, total: 30, head: '折叠 f4（第 4 轮）取回 30/30 段：',
      segments: segments, notes: [{ cut: true, text: '（还有 2 段没取回，需要时按段再召回。）' }], lines: [],
    },
  })
  const viewBody = flat(view.children[1].children)
  const segBox = viewBody.find(isScroller)
  assert.ok(segBox, '取回段多时也要限高')
  assert.equal(flat(segBox.children).filter(function (child) { return child && child.type === t.RecallSegment }).length, 30)
  const hasMissingNote = function (child) {
    return Boolean(child && Array.isArray(child.children) && String(child.children[0] || '').includes('没取回'))
  }
  assert.ok(viewBody.some(hasMissingNote), '尾注要在正文里')
  assert.equal(flat(segBox.children).some(hasMissingNote), false, '尾注不能被滚进框内')

  // 召回返回的是分段目录时（正文只有逐行清单），行多了也一样限高。
  const indexLines = Array.from({ length: 60 }, function (_, i) { return '#' + (i + 1) + ' [思考] 40 字：预览' })
  const indexView = t.RecallResult({
    parsed: { kind: 'index', id: 'f4', turn: 4, chars: '2,400', totalParts: 60, head: '', lines: indexLines, segments: [], notes: [] },
  })
  const indexBody = flat(indexView.children[1].children)
  assert.ok(indexBody.some(isScroller), '60 行的召回目录也要限高')
  // 目录形态的收起行同样带目录自身的字数与 token。
  const indexHead = JSON.stringify(indexView.children[0])
  assert.ok(indexHead.includes('分段目录 60 段（原文没有返回） · '), indexHead)
  assert.ok(/[\d.]+k? 字（≈[\d.]+k? token）/.test(indexHead), indexHead)
})

test('检查点里回复没被截断时，客户端段号与召回一样跳过回复段', () => {
  const { module } = loadClient()
  const t = module.__test
  const items = [
    { seq: 1, blocks: [{ kind: 'think', text: '[思考] 想' }] },
    { seq: 2, blocks: [{ kind: 'reply', text: '[回复] 答' }] },
  ]
  assert.deepEqual(t.foldPartsOf({ replyTruncated: false, items: items }).map((part) => part.kind), ['think'])
  assert.deepEqual(t.foldPartsOf({ items: items }).map((part) => part.kind), ['think', 'reply'])
})

test('召回结果按段折叠：取回范围、截断点与没取回的段都标出来', () => {
  const { module } = loadClient()
  const t = module.__test
  const record = {
    id: 'f4',
    turn: 4,
    chars: 4000,
    replyTruncated: true,
    items: [
      { seq: 101, text: '[思考] ' + 'x'.repeat(2000) },
      { seq: 102, text: '[工具结果] ' + 'y'.repeat(2000) },
    ],
  }
  const parts = foldParts(record)
  const text = renderFoldParts(record, parts, { maxChars: 900, total: parts.length })
  const parsed = t.parseRecallResult(text)
  assert.equal(parsed.kind, 'parts')
  assert.equal(parsed.id, 'f4')
  assert.equal(parsed.picked, parts.length)
  assert.equal(parsed.total, parts.length)
  assert.equal(parsed.segments.length, 1, '预算只够放下一段，另一段应标成没取回')
  assert.ok(parsed.segments[0].cut, '这一段超过单次上限，应标截断')
  assert.ok(parsed.segments[0].cut.full > parsed.segments[0].cut.kept)
  assert.ok(parsed.notes.some((note) => note.cut && note.text.includes('没取回')), JSON.stringify(parsed.notes))

  const view = t.RecallResult({ parsed: parsed })
  const viewText = JSON.stringify(view)
  assert.ok(viewText.includes('分段取回'), viewText.slice(0, 600))
  assert.ok(viewText.includes('段被截断'), viewText.slice(0, 600))
  assert.ok(viewText.includes('段没取回'), viewText.slice(0, 600))
  // 收起行要直接写出取回的段号区间，不必展开逐段核对。
  assert.ok(viewText.includes('（#1）'), viewText.slice(0, 600))
  assert.ok(t.recallCutText({ full: 7337, kept: 2462 }).includes('7,337'), '截断点要写清原文与已返回的字数')

  // 整段取回与分段目录也要认出来，各自折成一层。
  const direct = t.parseRecallResult(describeFold(record))
  assert.equal(direct.kind, 'direct')
  assert.equal(direct.segments.length, 2)
  const index = t.parseRecallResult(buildFoldIndex(record, { previewChars: 20, maxChars: 220 }))
  assert.equal(index.kind, 'index')
  assert.equal(index.id, 'f4')
  assert.ok(index.notes.some((note) => note.text.includes('目录已截断')), JSON.stringify(index.notes))

  // 普通工具结果不能被误认成召回结果。
  assert.equal(t.parseRecallResult('折叠不是 f4'), null)
  assert.equal(t.parseRecallResult('【已折叠历史】 第 4 轮'), null)

  // BlockView 认出来后交给 RecallResult 渲染，不再平铺整块正文。
  const block = t.BlockView({ block: { kind: 'result', text: text } })
  const recallChild = block.children.find((child) => child && child.type === t.RecallResult)
  assert.ok(recallChild, '召回结果应交给 RecallResult 渲染')
  const rendered = JSON.stringify(t.RecallResult(recallChild.props))
  assert.ok(rendered.includes('分段取回'), rendered.slice(0, 800))
  assert.equal(rendered.includes(text.slice(0, 120)), false, '正文不应被平铺')
})

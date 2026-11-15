import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const clientFile = join(here, '..', 'client', 'client.js')

// 客户端 bundle 是被浏览器模块加载器接管的 CJS：这里用最小假件把它当普通模块跑起来，
// 只验证注册面（顶栏 View 与插件页配置位），不验证渲染结果。
function loadClient() {
  const source = readFileSync(clientFile, 'utf8')
  let definition
  const fakeWindow = {
    __ModuleLoader__: {
      load(next) { definition = next },
    },
  }
  const react = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type, props: props || {}, children }
    },
    useState(value) { return [value, function () {}] },
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
  const keys = ['system', 'systemHistory', 'user', 'assistant', 'tools', 'inject', 'checkpoint', 'pin']
  const labels = ['系统提示', '旧版系统提示', '用户原话', '思考与回复', '工具调用与结果', '上下文注入', '折叠摘要', '重要消息']
  const bucket = (values) => {
    const out = {}
    keys.forEach((key, index) => { out[key] = values[index] || 0 })
    return out
  }
  const folded = bucket([84381, 328999, 500, 12000, 4000, 1000, 3000, 300])
  const unfolded = bucket([90000, 328999, 500, 900000, 700000, 8000, 0, 300])
  return {
    categories: keys.map((key, index) => ({ key, label: labels[index] })),
    totals: { folded, unfolded, sum: { folded: 434180, unfolded: 2027799 } },
    points: [
      {
        ordinal: 1,
        kind: 'turn',
        turn: 1,
        label: 'T1',
        folded: bucket([84381, 0, 500, 12000, 4000, 1000, 3000, 0]),
        unfolded: bucket([90000, 0, 500, 900000, 700000, 8000, 0, 0]),
        totals: { folded: 110500, unfolded: 1698500 },
        cumulative: { folded: bucket([84381, 0, 500, 12000, 4000, 1000, 3000, 0]), unfolded: bucket([90000, 0, 500, 900000, 700000, 8000, 0, 0]) },
      },
      {
        ordinal: 2,
        kind: 'turn',
        turn: 2,
        label: 'T2',
        folded: bucket([0, 0, 0, 300, 0, 0, 0, 300]),
        unfolded: bucket([0, 0, 0, 300, 0, 0, 0, 300]),
        totals: { folded: 600, unfolded: 600 },
        cumulative: { folded, unfolded },
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
  // 一轮里带一条重要消息：卡片本身与消息行都要能构造出来
  const turn = components.TurnCard({
    group: {
      kind: 'turn',
      turn: 2,
      folded: true,
      foldIds: ['f2'],
      pinLabels: ['结论'],
      entries: [
        { index: 0, role: 'user', sourceKind: 'user', chars: 20, blocks: [{ kind: 'text', text: 'hi' }] },
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
  assert.ok(text.includes('折叠后上下文'))
  assert.ok(text.includes('不折叠上下文'))
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
})

// 收益与成本都不该再拿单价折成人民币：真实请求会被缓存、压缩器和工具定义改写。
test('客户端不再用金额描述折叠收益', () => {
  const source = readFileSync(clientFile, 'utf8')
  assert.equal(source.includes("折叠收益', value: '+' + formatMoney"), false)
  assert.equal(source.includes('moneyNote'), false)
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

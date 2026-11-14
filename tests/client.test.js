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
  assert.equal(definition.id, 'dsh-fold-plugin')
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
  assert.equal(config.key, 'dsh-fold-plugin')
  assert.equal(typeof registered[1].component, 'function')
})

function demoComposition() {
  const keys = ['system', 'user', 'assistant', 'tools', 'inject', 'checkpoint', 'pin']
  const labels = ['系统提示', '用户原话', '思考与回复', '工具调用与结果', '上下文注入', '折叠摘要', '重要消息']
  const bucket = (values) => {
    const out = {}
    keys.forEach((key, index) => { out[key] = values[index] || 0 })
    return out
  }
  const folded = bucket([90000, 500, 12000, 4000, 1000, 3000, 300])
  const unfolded = bucket([90000, 500, 900000, 700000, 8000, 0, 300])
  return {
    categories: keys.map((key, index) => ({ key, label: labels[index] })),
    totals: { folded, unfolded, sum: { folded: 108800, unfolded: 1698800 } },
    points: [
      {
        ordinal: 1,
        kind: 'turn',
        turn: 1,
        label: 'T1',
        folded: bucket([90000, 500, 12000, 4000, 1000, 3000, 0]),
        unfolded: bucket([90000, 500, 900000, 700000, 8000, 0, 0]),
        totals: { folded: 110500, unfolded: 1698500 },
        cumulative: { folded: bucket([90000, 500, 12000, 4000, 1000, 3000, 0]), unfolded: bucket([90000, 500, 900000, 700000, 8000, 0, 0]) },
      },
      {
        ordinal: 2,
        kind: 'turn',
        turn: 2,
        label: 'T2',
        folded: bucket([0, 0, 300, 0, 0, 0, 300]),
        unfolded: bucket([0, 0, 300, 0, 0, 0, 300]),
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

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

test('参数表单只挂在插件页，折叠 tab 不再有设置入口', () => {
  const source = readFileSync(clientFile, 'utf8')
  assert.ok(source.includes("['ledger', '账本']"))
  assert.ok(source.includes("['model', '模型视角']"))
  assert.equal(source.includes("'settings', '设置'"), false)
  assert.ok(source.includes("fetch('/fold-config'"))
})

// 插件入口：盯 session/event，按轮收集 surface 节点，回合结束后把本轮折叠掉。
//
// 三条宿主硬约束决定了这里的形状：
// 1. 折叠只能通过 session.append(..., { surfaceOp: replace }) 落地——请求期改写会让模型看到日志里没有的内容。
// 2. 正式触发点是 agent/turn-stopping（turn/end 之前、不在发布临界区），可以直接写；turn/end 兜底则要延到 setImmediate。
// 3. 一轮可能有多段（steering 用户消息、轮内 fold_pin 都会切开），每段各自替换、各自编号。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from './logger.js'
import { ConfigStore } from './config.js'
import { FoldStore } from './store.js'
import { foldTurn } from './commit.js'
import { registerTools } from './tools.js'
import { registerInspectTool } from './inspect-tool.js'
import { registerStatsRoute } from './web.js'
import { promptSection } from './prompt.js'
import { TurnTracker } from './turn-tracker.js'
import { configFileName, pluginName } from './constants.js'

export const name = pluginName
export const inject = ['tools', 'systemPrompt']

function messageOfError(error) {
  try {
    return error && error.message ? String(error.message) : String(error)
  } catch {
    return 'unknown error'
  }
}

export function sessionKey(session) {
  if (!session) return ''
  return String(session.id || session.sessionId || '')
}

function homeOf(options) {
  if (options && options.homeDir) return options.homeDir
  const env = process.env.DSH_HOME
  if (env) return env
  return join(homedir(), '.dsh')
}

// 入口形状：函数式插件。装配失败只记日志，绝不让宿主启动失败。
export function apply(ctx, pluginConfig) {
  try {
    return assemble(ctx, { pluginConfig: pluginConfig || {} })
  } catch (error) {
    console.error('[' + pluginName + '] 装配失败：' + messageOfError(error))
    return { stop() {} }
  }
}

export function assemble(ctx, options = {}) {
  const homeDir = homeOf(options)
  const log = createLogger(homeDir, options.logFile === null ? { filePath: null } : {})
  const configStore = new ConfigStore({ homeDir, log })
  let config = configStore.load(options.pluginConfig || {})
  const makeStore = options.makeStore || ((sessionId) => new FoldStore({ homeDir, sessionId }))

  // 每个会话一份：载荷文件写入器 + 回合跟踪器。会话多了只淘汰最久没动的。
  const runtimes = new Map()
  const pending = new Set()

  function runtimeOf(session) {
    const id = sessionKey(session)
    if (!id) return null
    let runtime = runtimes.get(id)
    if (!runtime) {
      runtime = { id, session, store: makeStore(id), tracker: new TurnTracker() }
      runtimes.set(id, runtime)
      if (runtimes.size > 64) {
        const oldest = runtimes.keys().next()
        if (oldest && !oldest.done) runtimes.delete(oldest.value)
      }
    }
    runtime.session = session
    return runtime
  }

  function reloadConfig() {
    config = configStore.load(options.pluginConfig || {})
    return config
  }

  function foldAfterTurn(session, runtime, signal) {
    if (pending.has(runtime.id)) return
    pending.add(runtime.id)
    const immediate = setImmediate(() => {
      pending.delete(runtime.id)
      try {
        reloadConfig()
        if (!config.enabled) return
        const result = foldTurn({
          session,
          turn: signal.turn,
          nodes: signal.nodes,
          usage: signal.usage,
          config,
          store: runtime.store,
          log,
        })
        if (result.folded > 0) {
          log.info('第 ' + signal.turn + ' 轮折叠 ' + result.folded + ' 段：' + result.ids.join('、'))
        }
      } catch (error) {
        log.warn('折叠第 ' + signal.turn + ' 轮失败：' + messageOfError(error))
      }
    })
    if (immediate && typeof immediate.unref === 'function') immediate.unref()
  }

  function onSessionEvent(session, event) {
    try {
      const runtime = runtimeOf(session)
      if (!runtime) return
      const signal = runtime.tracker.observe(event)
      if (!signal || signal.kind !== 'end') return
      if (!Array.isArray(signal.nodes) || signal.nodes.length === 0) return
      foldAfterTurn(session, runtime, signal)
    } catch (error) {
      log.warn('处理会话事件失败：' + messageOfError(error))
    }
  }

  // 会话解析：工具运行上下文里优先用 exec.agent.session；退而求其次按 sessionId 去 services 里找。
  function resolveSession(exec) {
    if (!exec || typeof exec !== 'object') return undefined
    if (exec.agent && exec.agent.session) return exec.agent.session
    if (exec.session) return exec.session
    const id = String(exec.sessionId || '')
    if (!id) return undefined
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null
      const agent = agents && typeof agents.get === 'function' ? agents.get(id) : null
      if (agent && agent.session) return agent.session
    } catch {
      // 没有 agent 服务就试 sessions。
    }
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
      return sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
    } catch {
      return undefined
    }
  }

  // 最近一次请求的 provider 回报：统计页/模型视角用它当「实际请求」的 ground truth。
  // 只对当前进程里还活着的会话有效；重启后要等下一轮请求才会有数。
  function actualUsageOf(sessionId) {
    const key = String(sessionId || '').trim()
    if (!key) return null
    const runtime = runtimes.get(key)
    if (!runtime || !runtime.tracker) return null
    return runtime.tracker.latest || null
  }

  // 按 id 找会话：统计页/报告路由拿到的只有 sessionId，没有工具运行上下文。
  // 先查本插件的运行时缓存（会话正活着时一定命中），再问宿主服务。
  function resolveSessionById(id) {
    const key = String(id || '').trim()
    if (!key) return undefined
    const cached = runtimes.get(key)
    if (cached && cached.session) return cached.session
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
      const found = sessions && typeof sessions.get === 'function' ? sessions.get(key) : undefined
      if (found) return found
    } catch {
      // 没有 sessions 服务就试 agents。
    }
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null
      const agent = agents && typeof agents.get === 'function' ? agents.get(key) : null
      if (agent && agent.session) return agent.session
    } catch {
      return undefined
    }
    return undefined
  }

  // 主路径：轮即将关闭（turn/end 还没写）时同步折叠。
  // 这里不在任何 append 的发布临界区里，可以安全地直接写；比在 session/event 里延后更确定。
  function onTurnStopping(payload) {
    try {
      const session = payload && payload.agent ? payload.agent.session : undefined
      const runtime = session ? runtimeOf(session) : null
      if (!runtime) return
      const snapshot = runtime.tracker.snapshot()
      if (!snapshot.nodes.length) return
      reloadConfig()
      if (!config.enabled) return
      foldSync(session, runtime, snapshot)
    } catch (error) {
      log.warn('轮关闭时折叠失败：' + messageOfError(error))
    }
  }

  function foldSync(session, runtime, snapshot) {
    try {
      const result = foldTurn({
        session,
        turn: snapshot.turn,
        nodes: snapshot.nodes,
        usage: snapshot.usage,
        config,
        store: runtime.store,
        log,
      })
      if (result.folded > 0) {
        log.info('第 ' + snapshot.turn + ' 轮折叠 ' + result.folded + ' 段：' + result.ids.join('、'))
      }
    } catch (error) {
      log.warn('折叠第 ' + snapshot.turn + ' 轮失败：' + messageOfError(error))
    }
  }

  const off = typeof ctx.on === 'function' ? ctx.on('session/event', onSessionEvent) : null
  let offStopping = null
  if (typeof ctx.on === 'function') {
    try {
      offStopping = ctx.on('agent/turn-stopping', onTurnStopping)
    } catch (error) {
      // 宿主没有这个钩子（旧版）时只走 turn/end 兜底。
      log.warn('注册 agent/turn-stopping 失败，改用 turn/end 兜底：' + messageOfError(error))
    }
  }

  // 改配置后立刻重建提示段：fold_config 改 systemPromptText/promptOrder 要当场生效，而不是等重启。
  let sectionDispose = null
  function refreshSection() {
    if (sectionDispose) {
      try {
        sectionDispose()
      } catch {
        // 服务已卸载时撤销可能失败，忽略。
      }
      sectionDispose = null
    }
    sectionDispose = registerSection(ctx, log, config)
  }

  const tools = registerTools({
    ctx,
    log,
    resolveSession,
    homeDir,
    configFile: join(homeDir, configFileName),
    getConfig: () => config,
    updateConfig: (patch) => {
      config = configStore.save(patch)
      refreshSection()
      return config
    },
    getStore: (session) => {
      const runtime = runtimeOf(session)
      return runtime ? runtime.store : null
    },
    // 召回/固化时记下当前轮次，统计页才能把它们算到正确的轮上。
    getTurn: (session) => {
      const runtime = session ? runtimeOf(session) : null
      return runtime && typeof runtime.tracker.turn === 'number' ? runtime.tracker.turn : 0
    },
  })

  // 可视化调试工具：读真实派生消息 + 折叠记录，生成单文件 HTML 报告。
  const inspectTool = registerInspectTool({
    ctx,
    log,
    homeDir,
    resolveSession,
    resolveSessionById,
    getConfig: () => config,
    getStore: (session) => {
      const runtime = runtimeOf(session)
      return runtime ? runtime.store : null
    },
  })

  // 顶栏统计页的数据源。webServer 不可用时只是没有那个页面，折叠照旧。
  const statsRoute = registerStatsRoute({
    ctx,
    log,
    makeStore,
    resolveSessionById,
    getActualUsage: actualUsageOf,
    getConfig: () => config,
    // 设置页与 fold_config 共用同一条热更新路径：写文件 + 重建系统提示段。
    updateConfig: (patch) => {
      config = configStore.save(patch)
      refreshSection()
      return config
    },
    configFile: join(homeDir, configFileName),
  })

  refreshSection()

  let stopped = false
  function stop() {
    if (stopped) return
    stopped = true
    try {
      if (typeof off === 'function') off()
    } catch {
      // 会话服务已卸载时撤销可能失败，忽略。
    }
    try {
      if (typeof offStopping === 'function') offStopping()
    } catch {
      // 同上。
    }
    try {
      tools.dispose()
    } catch {
      // 同上。
    }
    try {
      inspectTool.dispose()
    } catch {
      // 同上。
    }
    try {
      if (statsRoute && typeof statsRoute.dispose === 'function') statsRoute.dispose()
    } catch {
      // 同上。
    }
    try {
      if (typeof sectionDispose === 'function') sectionDispose()
    } catch {
      // 同上。
    }
    runtimes.clear()
    pending.clear()
  }

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => stop(), 'dsh-fold-plugin: 卸载时收工具与提示段')
    } catch {
      // 没有 effect 就手动 stop。
    }
  }

  log.info('已启用：按轮折叠（阈值 ' + config.minFoldChars + ' 字，载荷目录 ' + homeDir + '）')

  return {
    name: pluginName,
    stop,
    reloadConfig,
    getConfig: () => ({ ...config }),
  }
}

function registerSection(ctx, log, config) {
  let service = null
  try {
    service = ctx.systemPrompt
    if (!service && typeof ctx.get === 'function') service = ctx.get('systemPrompt')
  } catch (error) {
    log.warn('读取 systemPrompt 服务失败：' + messageOfError(error))
  }
  if (!service || typeof service.section !== 'function') {
    log.warn('systemPrompt 服务不可用（可能是旧版 DSH），跳过折叠说明注入')
    return null
  }
  const section = promptSection(config || {})
  // 显式把文案配成空串 = 不注入提示段。
  if (!section.text || String(section.text).trim().length === 0) return null
  try {
    const dispose = service.section(section)
    return typeof dispose === 'function' ? dispose : null
  } catch (error) {
    const message = messageOfError(error)
    if (message.includes('already registered')) {
      log.info('折叠说明已注册，跳过重复注入')
    } else {
      log.warn('注入折叠说明失败：' + message)
    }
    return null
  }
}

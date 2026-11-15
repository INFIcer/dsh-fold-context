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
import { createPinMessage, foldTurn } from './commit.js'
import { registerTools } from './tools.js'
import { registerStatsRoute } from './web.js'
import { promptSection } from './prompt.js'
import { TurnTracker } from './turn-tracker.js'
import { configFileName, pinPrefix, pluginName, sourceCompactCheckpoint, sourcePin } from './constants.js'
import { CHARS_PER_TOKEN } from './tokens.js'

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
  // maxChars 用 getter：配置可能在运行中被 fold_config 改掉，store 不必重建。
  // 同一个会话的 store 必须复用：HTTP 账本路由每次轮询都 makeStore(sessionId)，
  // 每次新建实例就会把整份 JSONL 重新解析一遍（早先 5 秒一次的轮询正是这么做的）。
  const stores = new Map()
  function cachedStore(sessionId) {
    const key = String(sessionId || '')
    let store = stores.get(key)
    if (store) {
      stores.delete(key)
      stores.set(key, store)
      return store
    }
    store = new FoldStore({ homeDir, sessionId: key, maxChars: () => config.maxStoreTokens * CHARS_PER_TOKEN })
    stores.set(key, store)
    if (stores.size > 64) {
      const oldest = stores.keys().next()
      if (oldest && !oldest.done) stores.delete(oldest.value)
    }
    return store
  }
  const makeStore = options.makeStore || cachedStore

  // 每个会话一份：载荷文件写入器 + 回合跟踪器。会话多了只淘汰最久没动的。
  const runtimes = new Map()
  const pending = new Set()
  const pendingTimers = new Map()

  function runtimeOf(session) {
    const id = sessionKey(session)
    if (!id) return null
    let runtime = runtimes.get(id)
    if (runtime) {
      // 命中也要移到队尾：Map 的插入序淘汰必须按「最久没动」，不是「最早创建」。
      // 早先命中不移动，活跃会话超过 64 个时，最早创建但仍在用的会被淘汰、TurnTracker 状态丢失。
      runtimes.delete(id)
      runtimes.set(id, runtime)
      runtime.session = session
      return runtime
    }
    runtime = { id, session, store: makeStore(id), tracker: new TurnTracker(), pendingPins: [] }
    runtimes.set(id, runtime)
    if (runtimes.size > 64) {
      const oldest = runtimes.keys().next()
      if (oldest && !oldest.done) runtimes.delete(oldest.value)
    }
    // 上一次运行时没投递完的重要消息：从这里接回来，等本轮折叠后再注入。
    restorePendingPins(runtime)
    return runtime
  }

  // 一条消息的纯文本：pin 的「label + 正文」签名要靠它跟 pending 记录对齐。
  function textOfMessage(message) {
    const content = message && Array.isArray(message.content) ? message.content : []
    let out = ''
    for (const block of content) {
      if (block && typeof block.text === 'string') out += block.text
    }
    return out
  }

  // 待补投的 pin：进程退出、运行时被 LRU 淘汰、插件 stop 都会清空内存队列，
  // 只有 store 里那条 pin-pending 记录能证明「这条消息答应过要发」。
  // 消息可能已经注入成功、只是删记录失败：用会话里现成的 pin 文案去重，
  // 否则每次进入这个会话都会把同一句话再发一遍。
  function restorePendingPins(runtime) {
    const store = runtime.store
    const session = runtime.session
    if (!store || typeof store.pendingPins !== 'function') return
    let pending = []
    try {
      pending = store.pendingPins()
    } catch {
      return
    }
    if (pending.length === 0) return
    const present = new Set()
    if (session && typeof session.deriveMessages === 'function') {
      try {
        const messages = session.deriveMessages()
        if (Array.isArray(messages)) {
          const head = pinPrefix + ' '
          for (const message of messages) {
            const source = message && message.source
            if (!source || source.kind !== sourcePin) continue
            const text = textOfMessage(message)
            present.add(text.startsWith(head) ? text.slice(head.length) : text)
          }
        }
      } catch {
        // 派生失败就当「没发过」：宁可重复一条，也不能把答应过的消息吞掉。
      }
    }
    let restored = 0
    for (const record of pending) {
      const label = String(record.id || '')
      const text = String(record.text || '')
      if (present.has(label + '\n' + text)) {
        if (typeof store.resolvePending === 'function') store.resolvePending(record.pid)
        continue
      }
      if (runtime.pendingPins.some((pin) => pin.pid === record.pid)) continue
      const queuedRecord = { kind: 'pin', id: label, text, at: record.at }
      if (typeof record.turn === 'number') queuedRecord.turn = record.turn
      runtime.pendingPins.push({ label, text, pid: record.pid, record: queuedRecord, restored: true })
      restored += 1
    }
    if (restored > 0) log.info('恢复 ' + restored + ' 条未投递的重要消息，等本轮折叠后注入。')
  }

  function reloadConfig() {
    config = configStore.load(options.pluginConfig || {})
    return config
  }

  function foldAfterTurn(session, runtime, signal) {
    if (pending.has(runtime.id)) return
    pending.add(runtime.id)
    // 同样是延迟到定时器里：turn/end 时 append 可能还在发布临界区。
    const timer = setTimeout(() => {
      pendingTimers.delete(runtime.id)
      pending.delete(runtime.id)
      try {
        reloadConfig()
        if (config.enabled) {
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
        }
        flushPins(session, runtime)
      } catch (error) {
        log.warn('折叠第 ' + signal.turn + ' 轮失败：' + messageOfError(error))
        flushPins(session, runtime)
      }
    }, 0)
    pendingTimers.set(runtime.id, timer)
  }

  // 官方压缩（compaction-basic）会把旧消息整段换成一条摘要，被遮蔽区间里的 fold_pin
  // 也一起被卷走。这里刻意不补发：pin 只在「本插件的按轮折叠」这一层常驻，
  // 长会话里重要性会随时间淡化，淡化交给压缩层去做，插件不跟它抢。
  // （官方检查点本身仍按 keeper 处理，见 fold-text.js 的 isKeeper。）

  function onSessionEvent(session, event) {
    try {
      const runtime = runtimeOf(session)
      if (!runtime) return
      // pin 追加 / 官方压缩替换都会改变「模型还看得见哪些 pin」：立刻清掉这份会话的缓存，
      // 否则慢 15 秒的缓存会把刚发布的 pin 误标成「已压缩」。
      const source = event && event.data ? event.data.source : null
      if (event && event.type === 'user/message' && source &&
        (source.kind === sourcePin || source.kind === sourceCompactCheckpoint)) {
        pinPresence.delete(runtime.id)
      }
      const signal = runtime.tracker.observe(event)
      if (!signal || signal.kind !== 'end') return
      // 节点为空也要走一遍：本轮发布的重要消息仍需要在折叠之后注入。
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

  // 重要消息是否还在模型可见的历史里：官方压缩会把被遮蔽区间里的 pin 一起卷走，
  // 账本若继续把它算成常驻占用，就会和「模型实际看到的」对不上。每会话缓存 15 秒，
  // 比 stats 的轮询周期长，避免每次轮询都重算派生消息；pin / 压缩事件会立刻清缓存。
  const pinPresence = new Map()
  function surfacePinsOf(sessionId) {
    const key = String(sessionId || '').trim()
    if (!key) return null
    const now = Date.now()
    const cached = pinPresence.get(key)
    if (cached && now - cached.at < 15000) return cached.labels
    const session = resolveSessionById(key)
    let labels = null
    if (session && typeof session.deriveMessages === 'function') {
      try {
        const messages = session.deriveMessages()
        if (Array.isArray(messages)) {
          labels = new Set()
          for (const message of messages) {
            const source = message && message.source
            if (source && source.kind === sourcePin && typeof source.label === 'string') labels.add(source.label)
          }
        }
      } catch {
        labels = null
      }
    }
    pinPresence.set(key, { at: now, labels })
    return labels
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
      reloadConfig()
      if (config.enabled && snapshot.nodes.length > 0) foldSync(session, runtime, snapshot)
      flushPins(session, runtime)
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

  // 本轮发布的重要消息，推迟到折叠落盘之后再注入：放进检查点之后、模型下一轮仍可见，
  // 同时不会卡在工具调用与结果之间打断分段（见 commit.js publishPin 的注释）。
  function flushPins(session, runtime) {
    if (!runtime || !Array.isArray(runtime.pendingPins) || runtime.pendingPins.length === 0) return
    const queued = runtime.pendingPins.splice(0)
    for (const pin of queued) {
      try {
        session.append('user/message', createPinMessage(pin), { surfaceOp: 'append' })
        // 消息落盘成功后才写账本：先写账本会在中途退出时留下「账本有、历史没有」的假 pin。
        if (pin && pin.record && runtime.store && !runtime.store.append(pin.record)) {
          log.warn('重要消息「' + pin.label + '」已写入会话，但载荷记录失败。')
        }
        // 消息已经进会话，那条「答应过要发」的待投递记录就该删掉。
        // 删失败不影响已经注入的消息：下次进来会靠签名去重跳过它，不会再发一遍。
        if (pin && pin.pid && runtime.store && typeof runtime.store.resolvePending === 'function') {
          if (!runtime.store.resolvePending(pin.pid)) {
            log.warn('重要消息「' + pin.label + '」已注入会话，但待投递记录没删掉，下次进入会话时会按去重跳过。')
          }
        }
      } catch (error) {
        log.warn('发布重要消息失败「' + pin.label + '」：' + messageOfError(error))
      }
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
    enqueuePin: (session, pin) => {
      const runtime = session ? runtimeOf(session) : null
      if (runtime) runtime.pendingPins.push(pin)
    },
  })

  // 顶栏统计页的数据源。webServer 不可用时只是没有那个页面，折叠照旧。
  const statsRoute = registerStatsRoute({
    ctx,
    log,
    makeStore,
    resolveSessionById,
    getActualUsage: actualUsageOf,
    getSurfacePins: surfacePinsOf,
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
      if (statsRoute && typeof statsRoute.dispose === 'function') statsRoute.dispose()
    } catch {
      // 同上。
    }
    try {
      if (typeof sectionDispose === 'function') sectionDispose()
    } catch {
      // 同上。
    }
    for (const timer of pendingTimers.values()) clearTimeout(timer)
    pendingTimers.clear()
    runtimes.clear()
    stores.clear()
    pinPresence.clear()
    pending.clear()
  }

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => stop(), 'dsh-fold-context: 卸载时收工具与提示段')
    } catch {
      // 没有 effect 就手动 stop。
    }
  }

  log.info(
    '已启用：按轮折叠（摘要/原文 < ' + config.minFoldRatio + ' 才折，载荷目录 ' + homeDir + '）',
  )

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

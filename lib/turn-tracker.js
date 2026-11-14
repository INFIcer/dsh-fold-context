// 回合跟踪：把 surface 事件按「轮 / 步」攒成节点列表。
//
// 为什么不直接读 session.surface：surface 只给 seq，折叠后要能召回原文，
// 原文只能从我们收到的事件里取。顺带也解决了「同一轮里 surface 会被上一段折叠改动」的问题——
// 跟踪的是事件流，不受替换影响。

import { addUsage, emptyUsage, promptTokensOf } from './usage.js'

const MAX_NODES = 4000

function asNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export class TurnTracker {
  constructor() {
    this.turn = 0
    this.step = 0
    this.stack = []
    this.nodes = []
    // 本轮 provider 回报的用量，折叠时写进记录；latest 是最近一次请求的原始值，
    // 跨轮保留，供「实际请求」展示（快照只取走本轮累加的那份）。
    this.usage = emptyUsage()
    this.latest = null
  }

  restart(turn) {
    this.flushStep()
    this.turn = turn
    this.step = 0
    this.stack = []
    this.nodes = []
    this.usage = emptyUsage()
  }

  // 一步收尾：把栈里的节点并入本轮列表。栈里始终是「同一连续步骤」的节点。
  flushStep() {
    if (this.stack.length === 0) return
    for (const node of this.stack) this.nodes.push(node)
    this.stack = []
    // 轮内节点数封顶：极端长轮次只保留最近的部分，折叠少折几段好过占着内存不放。
    if (this.nodes.length > MAX_NODES) this.nodes = this.nodes.slice(this.nodes.length - MAX_NODES)
  }

  push(node) {
    this.stack.push(node)
  }

  // 同步取走本轮节点：turn-stopping 在 turn/end 之前触发，就用这个快照。
  snapshot() {
    this.flushStep()
    const nodes = this.nodes
    const turn = this.turn
    const usage = this.usage
    this.nodes = []
    this.stack = []
    this.usage = emptyUsage()
    return { turn, nodes, usage }
  }

  // 一次模型调用的用量：累加到本轮，并留一份最近请求的原始值。
  observeUsage(raw, turn, step) {
    if (!raw || typeof raw !== 'object') return
    addUsage(this.usage, raw)
    this.latest = {
      input: raw.inputTokens,
      cacheRead: raw.cacheReadTokens,
      cacheWrite: raw.cacheWriteTokens,
      output: raw.outputTokens,
      prompt: promptTokensOf(raw),
      turn: typeof turn === 'number' ? turn : this.turn,
      step: typeof step === 'number' ? step : this.step,
      at: Date.now(),
    }
  }

  nodeOf(event, turn, step) {
    return {
      type: event.type,
      seq: event.seq,
      data: event.data,
      turn: asNumber(turn, this.turn),
      step: asNumber(step, this.step),
    }
  }

  // 返回 { kind } 或 { kind:'end', turn, nodes }；与我们无关的事件返回 null。
  observe(event) {
    if (!event || typeof event.type !== 'string') return null
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    switch (event.type) {
      case 'turn/start': {
        const turn = asNumber(data.turn, this.turn + 1)
        this.restart(turn)
        return { kind: 'turn-start', turn }
      }
      case 'step/start': {
        this.flushStep()
        this.step = asNumber(data.step, this.step + 1)
        return { kind: 'step-start', turn: this.turn, step: this.step }
      }
      case 'assistant/message': {
        if (this.stack.length > 0) this.flushStep()
        this.observeUsage(data.usage, data.turn, data.step)
        this.push(this.nodeOf(event, data.turn, data.step))
        return { kind: 'assistant', turn: this.turn }
      }
      case 'tool/result': {
        this.push(this.nodeOf(event, data.turn, data.step))
        return { kind: 'tool', turn: this.turn }
      }
      case 'user/message': {
        // 轮内注入（运行时上下文）与 fold_pin 都以 user/message 进来：
        // 前者跟着这一步一起折叠，后者在 planSegments 里被识别为 keeper。
        this.push(this.nodeOf(event, data.turn, data.step))
        return { kind: 'user', turn: this.turn }
      }
      case 'developer/message': {
        this.push(this.nodeOf(event, data.turn, data.step))
        return { kind: 'developer', turn: this.turn }
      }
      case 'step/end': {
        this.flushStep()
        return { kind: 'step-end', turn: this.turn, step: asNumber(data.step, this.step) }
      }
      case 'turn/end': {
        this.flushStep()
        const turn = asNumber(data.turn, this.turn)
        const nodes = this.nodes
        const usage = this.usage
        this.nodes = []
        this.stack = []
        this.usage = emptyUsage()
        return { kind: 'end', turn, nodes, usage }
      }
      default:
        return null
    }
  }
}

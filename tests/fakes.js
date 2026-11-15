// 测试用的假宿主：只实现插件真正用到的那几个接口。

export class FakeSession {
  constructor(id = 'session-1', header) {
    this.id = id
    // 真宿主的 header 带 origin / parentSession；测试按需构造子代理与 fork 会话。
    if (header) this.header = header
    this.seq = 0
    this.events = []
    this.nodes = []
    this.bySeq = new Map()
  }

  get surface() {
    return { nodes: this.nodes.slice() }
  }

  // 伪造 surface 语义：append 追加节点，replace 校验「区间在当前 surface 里」且
  // 「sourceEventSeqs 覆盖全部被遮蔽节点」，然后原位换成新节点。
  append(type, data, opts) {
    if (type !== 'user/message') throw new Error('fake session only supports user/message, got ' + type)
    const seq = ++this.seq
    const event = { type, seq, data, ...(opts || {}) }
    this.events.push(event)
    this.bySeq.set(seq, { type, seq, data })
    const op = opts && opts.surfaceOp
    if (!op) throw new Error('surface event requires surfaceOp')
    if (op === 'append') {
      this.nodes.push(seq)
      return [event]
    }
    const startIdx = this.nodes.indexOf(op.startSeq)
    const endIdx = this.nodes.indexOf(op.endSeq)
    if (startIdx < 0 || endIdx < startIdx) throw new Error('start seq not found in surface')
    const shadowed = this.nodes.slice(startIdx, endIdx + 1)
    const sources = Array.isArray(opts.sourceEventSeqs) ? opts.sourceEventSeqs : []
    for (const node of shadowed) {
      if (!sources.includes(node)) throw new Error('surface replace: sourceEventSeqs must include every shadowed surface node; missing ' + node)
    }
    this.nodes.splice(startIdx, endIdx - startIdx + 1, seq)
    return [event]
  }

  // 直接铺一段历史：测试折叠效果时用。
  seed(nodes) {
    for (const node of nodes) {
      this.seq = Math.max(this.seq, node.seq)
      this.nodes.push(node.seq)
      this.bySeq.set(node.seq, node)
    }
    return this
  }

  // surface 当前对应的消息列表：真宿主有增量缓存，这里按 nodes 顺序现取。
  deriveMessages() {
    const out = []
    for (const seq of this.nodes) {
      const node = this.bySeq.get(seq)
      if (!node) continue
      const message = node.type === 'user/message' ? node.data : node.data && node.data.message
      if (message) out.push(message)
    }
    return out
  }
}

export function makeCtx() {
  const listeners = []
  const registrations = []
  const sections = []
  return {
    listeners,
    registrations,
    sections,
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {
        const index = listeners.findIndex((item) => item.handler === handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    tools: {
      // 第二个参数是真宿主的「按步激活条件」：测试要用它验证工具在某些会话里不可见。
      register(definition, options) {
        const entry = options && typeof options.when === 'function'
          ? { ...definition, when: options.when }
          : definition
        registrations.push(entry)
        return () => {
          const index = registrations.indexOf(entry)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        // 真宿主卸载 section 后会从模型上下文里消失；假宿主也要能摘掉，否则「关掉总开关」测不出来。
        return () => {
          const index = sections.indexOf(definition)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    emit(event, ...payload) {
      for (const listener of listeners.slice()) {
        if (listener.event === event) listener.handler(...payload)
      }
    },
  }
}

export function userNode(seq, text, kind = 'user', form) {
  return {
    type: 'user/message',
    seq,
    data: {
      id: 'm' + seq,
      role: 'user',
      source: form === undefined ? { kind } : { kind, form },
      content: [{ type: 'text', text }],
    },
  }
}

export function developerNode(seq, text, kind = 'tool-registry') {
  return {
    type: 'developer/message',
    seq,
    data: {
      message: {
        id: 'm' + seq,
        role: 'developer',
        source: { kind },
        content: [{ type: 'text', text }],
      },
    },
  }
}

export function assistantNode(seq, { reasoning = '', text = '', calls = [] } = {}) {
  const content = []
  if (reasoning) content.push({ type: 'reasoning', text: reasoning })
  if (text) content.push({ type: 'text', text })
  for (const call of calls) {
    content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args || {}) })
  }
  return {
    type: 'assistant/message',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'a' + seq,
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content,
      },
    },
  }
}

export function toolNode(seq, callId, text) {
  return {
    type: 'tool/result',
    seq,
    data: {
      message: {
        id: 't' + seq,
        role: 'tool',
        toolCallId: callId,
        isError: false,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text }],
      },
    },
  }
}

export function eventOf(type, data, seq) {
  return { type, data, seq }
}

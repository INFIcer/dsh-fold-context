// fold_inspect 工具：把当前会话的折叠效果写成一份本地 HTML 报告。
//
// 报告文件名与 fold-store 的会话文件名同源（safeFileName），同一会话重复调用覆盖同一份文件。
// 工具本身 fail-open：拿不到会话、deriveMessages 抛错、写盘失败都返回 { ok:false, text }，不向上抛。

import { buildHtmlReport, buildReportModel, buildTextReport, collectRecords, writeReport } from './inspect.js'

export const inspectToolName = 'fold_inspect'

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    text: { type: 'string', description: '给模型看的摘要正文' },
    path: { type: 'string', description: '生成的 HTML 报告绝对路径' },
  },
}

function messageOfError(error) {
  try {
    return error && error.message ? String(error.message) : String(error)
  } catch {
    return 'unknown error'
  }
}

function sessionKeyOf(session) {
  if (!session) return ''
  return String(session.id || session.sessionId || '')
}

// 派生消息是「模型视角」的唯一可信来源；老宿主没有这个接口时退回 messages，再没有就返回空。
export function derivedMessagesOf(session) {
  if (!session) return []
  if (typeof session.deriveMessages === 'function') {
    const list = session.deriveMessages()
    return Array.isArray(list) ? list : []
  }
  if (Array.isArray(session.messages)) return session.messages
  if (typeof session.messages === 'function') {
    const list = session.messages()
    return Array.isArray(list) ? list : []
  }
  return []
}

export function registerInspectTool({ ctx, resolveSession, resolveSessionById, getStore, getConfig, homeDir, log } = {}) {
  const sessionOf = typeof resolveSession === 'function' ? resolveSession : () => undefined
  const storeOf = typeof getStore === 'function' ? getStore : () => null
  const configOf = typeof getConfig === 'function' ? getConfig : () => ({})
  const service = ctx && ctx.tools
  if (!service || typeof service.register !== 'function') {
    log && log.warn('ctx.tools 不可用，跳过 ' + inspectToolName + ' 注册（可视化报告不可用）')
    return { dispose() {} }
  }

  // 指定 sessionId 时先查会话服务，再查 agent；都查不到就只认当前会话。
  function sessionById(id) {
    if (typeof resolveSessionById === 'function') {
      try {
        const found = resolveSessionById(id)
        if (found) return found
      } catch {
        // 解析器失败时退回本模块自己的查找。
      }
    }
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
      if (sessions && typeof sessions.get === 'function') {
        const found = sessions.get(id)
        if (found) return found
      }
    } catch {
      // 没有 sessions 服务就试 agents。
    }
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null
      if (agents && typeof agents.get === 'function') {
        const agent = agents.get(id)
        if (agent && agent.session) return agent.session
      }
    } catch {
      return undefined
    }
    return undefined
  }

  function inspect(args, exec) {
    const wanted = String((args && args.sessionId) || '').trim()
    let session = null
    if (wanted) {
      session = sessionById(wanted) || null
      if (!session) {
        const current = sessionOf(exec)
        if (current && sessionKeyOf(current) === wanted) session = current
      }
      if (!session) return { ok: false, text: '找不到会话 ' + wanted + '：只能检查当前进程里还活着的会话。' }
    } else {
      session = sessionOf(exec) || null
      if (!session) return { ok: false, text: '找不到当前会话，无法生成报告。' }
    }

    const store = storeOf(session)
    if (!store) return { ok: false, text: '这个会话没有折叠记录（插件装配失败或还没落过盘），无法生成报告。' }

    const derivedMessages = derivedMessagesOf(session)
    if (derivedMessages.length === 0) {
      return { ok: false, text: '拿不到这个会话的派生消息（deriveMessages 不可用或历史为空），无法对比两个视角。' }
    }

    const records = collectRecords(store)
    const model = buildReportModel({
      sessionId: sessionKeyOf(session),
      derivedMessages,
      folds: records.folds,
      pins: records.pins,
      recalls: records.recalls,
      config: configOf(),
    })
    const path = writeReport(homeDir, { sessionId: model.sessionId, html: buildHtmlReport(model) })
    // 留出报告路径的长度，摘要本身限 1600 字，工具返回整体不超过 2000 字。
    const text = buildTextReport(model, { maxChars: 1600 })
    return { ok: true, text: text + '\n\n报告文件：' + path, path }
  }

  let dispose = null
  try {
    dispose = service.register({
      name: inspectToolName,
      description:
        '生成一份本地 HTML 报告，对比「折叠后模型真正看到的历史」与「不折叠时的历史」：字符与 token 估算、' +
        '按轮节省率、每条折叠段的召回次数与固化状态、重要消息与事件时间线。报告写在 fold-debug 目录，不联网。' +
        '不传 sessionId 就检查当前会话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: {
            type: 'string',
            description: '要检查的会话 id；省略=当前会话。',
          },
        },
      },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      execute: async (args, exec) => {
        try {
          return inspect(args || {}, exec)
        } catch (error) {
          const message = messageOfError(error)
          log && log.warn(inspectToolName + ' 失败：' + message)
          return { ok: false, text: '生成报告失败：' + message }
        }
      },
    })
  } catch (error) {
    log && log.warn('注册 ' + inspectToolName + ' 失败：' + messageOfError(error))
  }

  return {
    dispose() {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // 撤销失败不影响卸载。
      }
    },
  }
}

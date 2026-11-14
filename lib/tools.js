// 两个工具：fold_recall（取回被折叠的原文）与 fold_pin（发布永不折叠的重要消息）。
// 参数 schema 只用宿主支持的 JSON Schema 子集，别加 $ref / oneOf 之类。

import { pinToolName, recallToolName } from './constants.js'
import { publishPin } from './commit.js'

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    text: { type: 'string', description: '给模型看的正文' },
  },
}

export function describeFold(record) {
  const items = Array.isArray(record.items) ? record.items : []
  const lines = ['折叠 ' + record.id + '（第 ' + record.turn + ' 轮，原文约 ' + (record.chars || 0) + ' 字）']
  for (const item of items) {
    lines.push('--- #' + item.seq + ' ---')
    lines.push(String(item.text || ''))
  }
  return lines.join('\n')
}

// 召回次数是客观信号：被反复拉回来的东西，就该被固化。
export function recallReminder(count, limit) {
  if (count <= limit) return ''
  return '提示：这条折叠已经被召回 ' + count + ' 次。里面的结论如果之后还会用到，用 ' + pinToolName + ' 发布成重要消息，而不是反复召回。'
}

export function registerTools({ ctx, getStore, getConfig, resolveSession, log }) {
  const sessionOf = typeof resolveSession === 'function' ? resolveSession : () => undefined
  const disposers = []
  const service = ctx && ctx.tools
  if (!service || typeof service.register !== 'function') {
    log && log.warn('ctx.tools 不可用，跳过工具注册（召回与发布将不可用）')
    return { dispose() {} }
  }

  function recall(args, exec) {
    const session = sessionOf(exec)
    if (!session) return { ok: false, text: '找不到当前会话，无法召回。' }
    const runtime = getStore(session)
    const id = String((args && args.id) || '').trim()
    if (!id) return { ok: false, text: '缺少 id：用折叠摘要里写的编号，例如 f7。' }
    const store = getStore(session)
    if (!store) return { ok: false, text: '这个会话没有折叠记录，无可召回。' }
    const record = store.findFold(id)
    if (!record) {
      return {
        ok: false,
        text: '没有编号为 ' + id + ' 的折叠记录。摘要里写过的编号才有效；fork 出来的会话也读不到父会话的载荷。',
      }
    }
    const config = getConfig()
    const count = store.recallCount(id) + 1
    store.appendRecall(id)
    let body = describeFold(record)
    if (body.length > config.maxRecallChars) {
      body = body.slice(0, config.maxRecallChars) + '…（已截断，超出部分不再返回）'
    }
    const reminder = recallReminder(count, config.recallReminderAfter)
    return { ok: true, text: reminder ? body + '\n\n' + reminder : body }
  }

  function pin(args, exec) {
    const session = sessionOf(exec)
    if (!session) return { ok: false, text: '找不到当前会话，无法发布。' }
    const store = getStore(session)
    const result = publishPin({
      session,
      label: args && args.label,
      text: args && args.text,
      config: getConfig(),
      store,
      log,
    })
    if (!result.ok) return { ok: false, text: result.reason }
    return {
      ok: true,
      text: '已发布重要消息「' + result.label + '」（' + result.chars + ' 字），这条不会再被折叠。',
    }
  }

  const definitions = [
    {
      name: recallToolName,
      description:
        '召回一条被折叠的历史：返回那一轮的思考、工具调用与回复原文。id 用折叠摘要里写的编号（例如 f7）。' +
        '返回值末尾会告诉你这条已经被召回了几次——次数多说明这段信息会反复用到，应该用 ' +
        pinToolName + ' 把它固化。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: '折叠编号，形如 f7 或 f12b；只能取自【已折叠历史】摘要的第一行。',
          },
        },
        required: ['id'],
      },
      execute: recall,
    },
    {
      name: pinToolName,
      description:
        '发布一条永不折叠的重要消息：适合会被反复复用的结论、约束、路径、数字。' +
        '只写结论，不要抄原文；每个会话有配额，只放真正会用到的东西。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: {
            type: 'string',
            description: '一句话标题，例如「部署脚本位置」「接口字段约定」，不超过 60 字。',
          },
          text: {
            type: 'string',
            description: '要永久保留的正文：结论、约束、路径、数字。默认上限 4000 字。',
          },
        },
        required: ['label', 'text'],
      },
      execute: pin,
    },
  ]

  for (const definition of definitions) {
    try {
      const dispose = service.register({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: {
          schema: RESULT_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
        },
        execute: async (args, exec) => {
          try {
            return definition.execute(args || {}, exec)
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            log && log.warn('工具 ' + definition.name + ' 失败：' + message)
            return { ok: false, text: '工具执行失败：' + message }
          }
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      log && log.warn('注册工具 ' + definition.name + ' 失败：' + message)
    }
  }

  return {
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 撤销失败不影响卸载。
        }
      }
    },
  }
}

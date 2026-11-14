// 三个工具：fold_recall（取回被折叠的原文）、fold_pin（发布永不折叠的重要消息）、
// fold_config（运行时查看与修改配置）。
// 参数 schema 只用宿主支持的 JSON Schema 子集，别加 $ref / oneOf 之类。

import { join } from 'node:path'
import { configFileName, configToolName, pinToolName, recallToolName } from './constants.js'
import { defaultConfig, configFields, defaultRecallReminderText, normalizeConfig, validateConfigPatch, writeConfigFile } from './config.js'
import { fillPlaceholders } from './template.js'
import { publishPin } from './commit.js'
import { estimateTokens } from './tokens.js'
import {
  buildFoldIndex,
  describeFold,
  foldParts,
  normalizePartSelectors,
  renderFoldParts,
  selectFoldParts,
} from './recall.js'

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    text: { type: 'string', description: '给模型看的正文' },
  },
}

// 召回次数是客观信号：被反复拉回来的东西，就该被固化。
// 文案可配置，空串表示不提醒；占位符用单花括号，和系统提示段的双花括号区分开。
export function recallReminder(count, limit, template = defaultRecallReminderText) {
  if (count <= limit) return ''
  if (typeof template !== 'string' || template.length === 0) return ''
  return fillPlaceholders(template, { count: String(count), tool: pinToolName }, '{', '}')
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function rangeOf(field) {
  if (field.kind === 'boolean') return 'true / false'
  if (field.kind === 'string') return '不超过 ' + field.maxChars + ' 字'
  return field.min + '~' + field.max
}

function showValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

// get 的输出要能直接照着改：每项都带当前值、范围与默认值。
function describeConfig(config, filePath) {
  const lines = ['当前生效配置（' + configToolName + '）：']
  lines.push('配置文件：' + (filePath || '不可用（宿主未传 homeDir 或 configFile）'))
  for (const field of configFields()) {
    lines.push(
      '- ' + field.key + ' = ' + showValue(config[field.key]) +
      '（' + rangeOf(field) + '，默认 ' + showValue(field.default) + '）' + field.description
    )
  }
  lines.push('用 ' + configToolName + ' 的 set 修改会立即生效并写入文件；reset 恢复全部默认值。')
  return lines.join('\n')
}

// patch 的属性表从 configFields 生成，字段白名单只维护一处。
function patchProperties() {
  const properties = {}
  for (const field of configFields()) {
    const type = field.kind === 'boolean' ? 'boolean' : (field.kind === 'string' ? 'string' : (field.kind === 'integer' ? 'integer' : 'number'))
    properties[field.key] = {
      type,
      description: field.description + '（范围 ' + rangeOf(field) + '，默认 ' + showValue(field.default) + '）',
    }
  }
  return properties
}

export function registerTools({ ctx, getStore, getConfig, resolveSession, getTurn, log, updateConfig, homeDir, configFile }) {
  const sessionOf = typeof resolveSession === 'function' ? resolveSession : () => undefined
  const turnOf = typeof getTurn === 'function' ? getTurn : () => 0
  const disposers = []
  const service = ctx && ctx.tools
  if (!service || typeof service.register !== 'function') {
    log && log.warn('ctx.tools 不可用，跳过工具注册（召回与发布将不可用）')
    return { dispose() {} }
  }

  function configPath() {
    if (typeof configFile === 'string' && configFile.length > 0) return configFile
    if (typeof homeDir === 'string' && homeDir.length > 0) return join(homeDir, configFileName)
    return ''
  }

  function currentConfig() {
    const config = typeof getConfig === 'function' ? getConfig() : null
    return config && typeof config === 'object' ? config : defaultConfig()
  }

  // 把新配置交给宿主热更新；宿主没接线时只落盘，返回说明用的后缀。
  function applyConfig(next) {
    if (typeof updateConfig !== 'function') {
      return '已写入配置文件，但当前会话未接线热更新，重启后生效。'
    }
    try {
      updateConfig(next)
      return '已立即生效。'
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      log && log.warn('fold_config 热更新失败：' + message)
      return '已写入配置文件，但热更新失败（' + message + '），重启后生效。'
    }
  }

  function configTool(args) {
    const action = String((args && args.action) || '').trim()
    if (action === 'get') {
      const config = currentConfig()
      const path = configPath()
      return { ok: true, text: describeConfig(config, path), config, filePath: path, fields: configFields() }
    }
    if (action === 'set') {
      const result = validateConfigPatch(args && args.patch)
      if (!result.ok) {
        return { ok: false, text: '配置未生效，请逐项修正：\n- ' + result.errors.join('\n- ') }
      }
      const path = configPath()
      if (!path) {
        return { ok: false, text: '找不到配置文件位置：宿主没有传 homeDir 或 configFile，无法写入。' }
      }
      const next = normalizeConfig(result.patch, currentConfig(), (message) => log && log.warn(message))
      if (!writeConfigFile(path, next)) {
        return { ok: false, text: '配置未生效：写文件失败（' + path + '）。' }
      }
      const suffix = applyConfig(result.patch)
      return { ok: true, text: '配置已更新：' + Object.keys(result.patch).join('、') + '。' + suffix + '\n\n' + describeConfig(next, path), config: next }
    }
    if (action === 'reset') {
      const next = defaultConfig()
      const path = configPath()
      if (path) {
        if (!writeConfigFile(path, next)) {
          return { ok: false, text: '重置失败：写文件失败（' + path + '）。' }
        }
      } else if (typeof updateConfig !== 'function') {
        return { ok: false, text: '无法重置：没有配置文件路径，宿主也没有接线热更新。' }
      }
      const suffix = applyConfig(next)
      return { ok: true, text: '已恢复默认配置。' + suffix + '\n\n' + describeConfig(next, path), config: next }
    }
    return { ok: false, text: 'action 只能是 get、set 或 reset。' }
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
    const config = currentConfig()
    const directLimit = numberOr(config.recallDirectChars, 8000)
    const totalLimit = numberOr(config.maxRecallChars, 24000)
    const previewChars = numberOr(config.recallIndexPreviewChars, 100)
    const selectors = normalizePartSelectors(args && args.parts)
    let body
    let mode
    if (!selectors) {
      const full = describeFold(record)
      if (full.length <= directLimit) {
        body = full
        mode = 'direct'
      } else {
        // 原文太长：先给目录，模型按段号二级召回，避免一次把几十万字塞回上下文。
        body =
          buildFoldIndex(record, { previewChars, maxChars: totalLimit }) +
          '\n\n（这是分段目录，原文没有整段返回；目录本身也占上下文，只取真正需要的段。）'
        mode = 'index'
      }
    } else {
      const allParts = foldParts(record)
      const selection = selectFoldParts(allParts, selectors)
      if (selection.picked.length === 0) {
        return {
          ok: false,
          text:
            '没有匹配的段：' + (selection.unknown.join('、') || selectors.join('、')) +
            '。这条折叠共 ' + allParts.length + ' 段，可用段号 1-' + allParts.length +
            '，或类型 think / reply / tools / all。',
        }
      }
      body = renderFoldParts(record, selection.picked, { maxChars: totalLimit, total: allParts.length })
      if (selection.unknown.length > 0) {
        body += '\n\n（这些选择没匹配上：' + selection.unknown.join('、') + '）'
      }
      mode = 'parts'
    }
    // 目录查询不算「内容召回」：固化提醒只数真正把原文读回来的次数。
    const count = store.recallCount(id) + 1
    const reminder =
      mode === 'index' ? '' : recallReminder(count, config.recallReminderAfter, config.recallReminderText)
    const reply = reminder ? body + '\n\n' + reminder : body
    // 记下这一轮与返回正文的大小：顶栏统计要把召回算成这一轮的负收益。
    store.appendRecall(id, {
      turn: turnOf(session),
      chars: reply.length,
      tokens: estimateTokens([reply]),
      mode,
    })
    return { ok: true, text: reply, mode }
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
      turn: turnOf(session),
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
        '召回一条被折叠的历史。原文短（不超过 recallDirectChars）时直接返回全文；原文长时先返回分段目录' +
        '（每段带段号、类型、字数与开头），再用 parts 多选要取回的段，避免一次把很长的思考与工具输出全塞回来。' +
        'id 用折叠摘要里写的编号（例如 f7）。返回值末尾会告诉你这条已经被召回了几次——次数多说明这段信息' +
        '会反复用到，应该用 ' + pinToolName + ' 把它固化。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: '折叠编号，形如 f7 或 f12b；只能取自【已折叠历史】摘要的第一行。',
          },
          parts: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选，二级召回多选：段号 ["1","4-6"]，或类型 ["think"]（思考）、["tools"]（调用与工具结果）、' +
              '["reply"]（回复）、["all"]（全部）。先不传看目录，再按需选段。',
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
    {
      name: configToolName,
      description:
        '查看或修改折叠配置：action=get 返回当前生效配置与每项范围；action=set 用 patch 对象改指定项；' +
        'action=reset 恢复全部默认值。set 与 reset 会写入配置文件并尽量立即生效。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            description: '操作：get（查看）、set（修改）、reset（恢复默认）。',
          },
          patch: {
            type: 'object',
            description: 'action=set 时的配置补丁，只写要改的项，例如 {"noteRatio": 0.2}。',
            additionalProperties: true,
            properties: patchProperties(),
          },
        },
        required: ['action'],
      },
      execute: configTool,
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

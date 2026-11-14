// 三个工具：fold_recall（取回被折叠的原文）、fold_pin（发布永不折叠的重要消息）、
// fold_config（运行时查看与修改配置）。
// 参数 schema 只用宿主支持的 JSON Schema 子集，别加 $ref / oneOf 之类。

import { join } from 'node:path'
import { configFileName, configToolName, pinToolName, recallToolName } from './constants.js'
import { defaultConfig, configFields, defaultRecallReminderText, mergeConfigFile, normalizeConfig, validateConfigPatch } from './config.js'
import { fillPlaceholders } from './template.js'
import { publishPin } from './commit.js'
import { CHARS_PER_TOKEN, estimateTokens } from './tokens.js'
import {
  buildFoldIndex,
  describeFold,
  foldParts,
  kindChoices,
  matchFoldPartNumbers,
  normalizePartSelectors,
  normalizeQuery,
  renderFoldParts,
  renderSearchResults,
  searchFolds,
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
  lines.push('用 ' + configToolName + ' 的 set 修改会立即生效并写入文件层（只记显式改过的键）；reset 把全部字段显式写成默认值，因此会覆盖 profile 里的同名配置。')
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

export function registerTools({ ctx, getStore, getConfig, resolveSession, getTurn, log, updateConfig, homeDir, configFile, enqueuePin }) {
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

  function configTool(args) {
    const action = String((args && args.action) || '').trim()
    if (action === 'get') {
      const config = currentConfig()
      const path = configPath()
      return { ok: true, text: describeConfig(config, path), config, filePath: path, fields: configFields() }
    }
    if (action === 'set' || action === 'reset') {
      const path = configPath()
      let checked = null
      if (action === 'set') {
        checked = validateConfigPatch(args && args.patch)
        if (!checked.ok) {
          return { ok: false, text: '配置未生效，请逐项修正：\n- ' + checked.errors.join('\n- ') }
        }
      }
      const patch = action === 'reset' ? defaultConfig() : checked.patch
      let next = null
      if (typeof updateConfig === 'function') {
        // 宿主接线：ConfigStore.save 会写文件层（只记显式改过的键）并重建系统提示段。
        // 写文件失败会抛出来，这里明确回报「未生效」，不假装成功。
        try {
          next = updateConfig(patch)
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          return { ok: false, text: '配置未生效：' + message }
        }
      } else if (path) {
        const written = mergeConfigFile(path, patch)
        if (!written) return { ok: false, text: '配置未生效：写文件失败（' + path + '）。' }
        next = normalizeConfig(patch, currentConfig())
      } else {
        return { ok: false, text: '无法修改：没有配置文件路径，宿主也没有接线热更新。' }
      }
      const head = action === 'reset'
        ? '已恢复默认配置（显式写入，覆盖 profile 里的同名值）。'
        : '配置已更新：' + Object.keys(checked.patch).join('、') + '。'
      return { ok: true, text: head + '\n\n' + describeConfig(next, path), config: next }
    }
    return { ok: false, text: 'action 只能是 get、set 或 reset。' }
  }

  function recall(args, exec) {
    const session = sessionOf(exec)
    if (!session) return { ok: false, text: '找不到当前会话，无法召回。' }
    const store = getStore(session)
    if (!store) return { ok: false, text: '这个会话没有折叠记录，无可召回。' }
    const config = currentConfig()
    const id = String((args && args.id) || '').trim()
    const query = typeof (args && args.query) === 'string' ? args.query.trim() : ''
    const tokens = normalizeQuery(query)
    const totalLimit = numberOr(config.maxRecallTokens, 6000) * CHARS_PER_TOKEN

    // 只给关键词：全会话检索，只回编号与段号，不回原文。
    if (!id) {
      if (tokens.length === 0) {
        return {
          ok: false,
          text:
            '缺少 id 或 query：知道编号就传 id（摘要第一行写的 f7 之类）；' +
            '只记得文件名、函数名或报错片段时传 query 检索，例如 query:"lib/web.js"。',
        }
      }
      const found = searchFolds(store.readAll(), query, {
        previewChars: numberOr(config.searchPreviewTokens, 15) * CHARS_PER_TOKEN,
      })
      const body = renderSearchResults(query, found, {
        toolName: recallToolName,
        maxFolds: numberOr(config.maxSearchFolds, 8),
        maxChars: totalLimit,
      })
      // 检索不返回原文，按目录查询记：不计入召回次数，只记它自己占的那点上下文。
      store.appendRecall('', {
        turn: turnOf(session),
        chars: body.length,
        tokens: estimateTokens([body]),
        mode: 'search',
      })
      return { ok: true, text: body, mode: 'search' }
    }

    const record = store.findFold(id)
    if (!record) {
      const pruned = typeof store.isPruned === 'function' && store.isPruned(id)
      return {
        ok: false,
        text: pruned
          ? '折叠 ' + id + ' 的载荷已因存储上限被清理（fold-store 只保留最近的折叠）。摘要里的编号仍然有效，但原文取不回来了。'
          : '没有编号为 ' + id + ' 的折叠记录。摘要里写过的编号才有效；fork 出来的会话也读不到父会话的载荷。',
      }
    }
    const directLimit = numberOr(config.recallDirectTokens, 2000) * CHARS_PER_TOKEN
    const previewChars = numberOr(config.recallIndexPreviewTokens, 25) * CHARS_PER_TOKEN
    const allParts = foldParts(record)
    const selectors = normalizePartSelectors(args && args.parts)
    // 编号 + 关键词：把这条折叠先按关键词筛一遍，再走原来的目录/选段逻辑。
    const matched = tokens.length > 0 ? matchFoldPartNumbers(record, tokens) : null
    if (matched && matched.length === 0) {
      return {
        ok: false,
        text:
          '折叠 ' + id + ' 里没有命中「' + query + '」的段（这条折叠共 ' + allParts.length + ' 段）。' +
          '可以先只传 id 看分段目录，或换更短的关键词。',
      }
    }
    const allowed = matched ? new Set(matched) : null
    let body
    let mode
    if (selectors) {
      const selection = selectFoldParts(allParts, selectors)
      let picked = selection.picked
      if (allowed) picked = picked.filter((part) => allowed.has(part.no))
      if (picked.length === 0) {
        if (allowed) {
          return {
            ok: false,
            text:
              '选的段里没有命中「' + query + '」的部分。这条折叠命中的段号：' + matched.join('、') + '。',
          }
        }
        return {
          ok: false,
          text:
            '没有匹配的段：' + (selection.unknown.join('、') || selectors.join('、')) +
            '。这条折叠共 ' + allParts.length + ' 段，可用段号 1-' + allParts.length +
            '，或这些类型：' + kindChoices(allParts) + '。',
        }
      }
      body = renderFoldParts(record, picked, { maxChars: totalLimit, total: allParts.length })
      if (selection.unknown.length > 0) {
        body += '\n\n（这些选择没匹配上：' + selection.unknown.join('、') + '）'
      }
      mode = 'parts'
    } else if (allowed) {
      const picked = allParts.filter((part) => allowed.has(part.no))
      body = renderFoldParts(record, picked, { maxChars: totalLimit, total: allParts.length })
      mode = 'parts'
    } else {
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
      // 推迟到本轮折叠之后注入：轮内（可能是工具调用与结果之间）直接插入会打断分段。
      onPublish: typeof enqueuePin === 'function'
        ? (pin) => enqueuePin(session, pin)
        : undefined,
    })
    if (!result.ok) return { ok: false, text: result.reason }
    const total = typeof result.pins === 'number'
      ? '本会话共 ' + result.pins + ' 条 / ' + result.totalChars + ' 字。'
      : ''
    return {
      ok: true,
      text: '已发布重要消息「' + result.label + '」（' + result.chars + ' 字）。' + total + '这条不会再被折叠。' +
        (result.note ? '\n' + result.note : ''),
    }
  }

  const definitions = [
    {
      name: recallToolName,
      description:
        '召回被折叠的原文，两种用法。知道编号就传 id（折叠摘要第一行写的 f7 之类）：原文短（不超过 recallDirectTokens）' +
        '直接返回全文，原文长先返回分段目录（每段带段号、类型、字数与开头），再用 parts 多选要取回的段。' +
        '只记得文件名、函数名或报错片段时传 query：检索所有折叠，只返回折叠编号、段号与命中片段，再用 id + parts 取原文。' +
        '检索不算一次召回。返回值末尾会告诉你这条已经被召回了几次——次数多说明会反复用到，应该用 ' + pinToolName + ' 固化。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: '折叠编号，形如 f7 或 f12b；只能取自【已折叠历史】摘要的第一行。与 query 二选一，也可同时给（先筛段）。',
          },
          query: {
            type: 'string',
            description:
              '关键词检索：文件名、路径、函数名、报错片段都行，多个词用空格分隔、需同时命中。' +
              '不传 id 时检索全部折叠，只回编号与段号；传 id 时只在该折叠里筛段。',
          },
          parts: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选，二级召回多选：段号 ["1","4-6"]，或类型 ["think"]（思考）、["tools"]（调用与工具结果）、' +
              '["reply"]（回复）、["all"]（全部）。先不传看目录，再按需选段。',
          },
        },
      },
      execute: recall,
    },
    {
      name: pinToolName,
      description:
        '发布一条永不折叠的重要消息：跨轮会复用的结论、约束、路径、接口、数字，都值得单独记一条。' +
        '随时可用，不设条数与长度配额，由你判断值不值得记；一条只说一件事、几行字最好。' +
        '不用为了省字而不敢记：多记几条短消息比之后反复召回划算。',
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
            description: '要永久保留的正文：结论、约束、路径、数字。不设长度上限，按需要写。',
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
            description: 'action=set 时的配置补丁，只写要改的项，例如 {"maxNoteTokens": 400}。',
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

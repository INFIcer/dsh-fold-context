// 配置：默认值在这里，运行时值来自 profile 里 insert 行的 config 与 $DSH_HOME/fold-config.json。
// 优先级：默认值 < profile config < 配置文件——手工改文件能立刻覆盖 profile 里的值。
// 所有字段都做钳制：越界配置只降级，不让插件加载失败。折叠是优化，不是必需能力。
//
// FIELDS 是字段白名单的唯一出处：默认值、类型、范围、说明都从这里来。
// 两条校验路径刻意不同：加载时「越界即钳制」保证老文件永远能读；fold_config 改配置时
// 「逐项拒绝」保证模型不会误以为一次非法修改已经生效。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configFileName, pluginName, promptSectionOrder } from './constants.js'
import { defaultSystemPromptText } from './prompt.js'

// 固化提醒的默认文案：{count} 是召回次数，{tool} 是固化工具名。
export const defaultRecallReminderText = '提示：这条折叠已经被召回 {count} 次。里面的结论如果之后还会用到，用 {tool} 发布成重要消息，而不是反复召回。'

const FIELDS = [
  {
    key: 'enabled',
    kind: 'boolean',
    default: true,
    description: '总开关，关掉后只保留工具与提示词，不再自动折叠',
  },
  {
    key: 'minFoldChars',
    kind: 'integer',
    min: 200,
    max: 200000,
    default: 1200,
    description: '一轮里思考、回复与工具输出的总字符低于它就不折',
  },
  {
    key: 'maxNoteChars',
    kind: 'integer',
    min: 80,
    max: 4000,
    default: 320,
    description: '检查点摘要的硬上限；实际上限还受 noteRatio 控制',
  },
  {
    key: 'noteRatio',
    kind: 'ratio',
    min: 0.02,
    max: 0.5,
    default: 0.1,
    description: '摘要按原文比例计算，取 max(80, round(原文 * noteRatio)) 后再受 maxNoteChars 截断',
  },
  {
    key: 'recallReminderAfter',
    kind: 'integer',
    min: 1,
    max: 50,
    default: 3,
    description: '同一条折叠被召回超过这个次数后附固化提醒',
  },
  {
    key: 'recallReminderText',
    kind: 'string',
    maxChars: 2000,
    default: defaultRecallReminderText,
    description: '固化提醒文案，支持 {count} 与 {tool} 占位；空串表示不提醒',
  },
  {
    key: 'maxRecallChars',
    kind: 'integer',
    min: 1000,
    max: 200000,
    default: 24000,
    description: '单次召回返回的原文上限（也用作分段目录的字数上限）',
  },
  {
    key: 'recallDirectChars',
    kind: 'integer',
    min: 1000,
    max: 200000,
    default: 8000,
    description: '召回原文不超过这个字数时整段返回，超过则先返回分段目录',
  },
  {
    key: 'recallIndexPreviewChars',
    kind: 'integer',
    min: 20,
    max: 500,
    default: 100,
    description: '分段目录里每段预览的字数',
  },
  {
    key: 'maxPinTextChars',
    kind: 'integer',
    min: 200,
    max: 20000,
    default: 4000,
    description: '单条重要消息的正文上限',
  },
  {
    key: 'maxPins',
    kind: 'integer',
    min: 1,
    max: 200,
    default: 12,
    description: '单个会话的重要消息条数上限',
  },
  {
    key: 'pinBudgetChars',
    kind: 'integer',
    min: 500,
    max: 200000,
    default: 12000,
    description: '全部重要消息的字符预算',
  },
  {
    key: 'systemPromptText',
    kind: 'string',
    maxChars: 20000,
    default: defaultSystemPromptText(),
    description: '系统提示段文案，支持 {{recallTool}}、{{pinTool}}、{{ratio}}、{{configTool}} 占位；空串表示不注入',
  },
  {
    key: 'promptOrder',
    kind: 'integer',
    min: -1000,
    max: 10000,
    default: promptSectionOrder,
    description: '系统提示段的排序值，越小越靠前',
  },
  {
    key: 'foldToolOutputs',
    kind: 'boolean',
    default: true,
    description: 'false 时工具输出不进摘要、也不进召回载荷',
  },
  {
    key: 'maxFoldsPerTurn',
    kind: 'integer',
    min: 1,
    max: 32,
    default: 8,
    description: '一轮最多折成几段，超出的片段保留原文',
  },
]

const FIELD_MAP = new Map(FIELDS.map((field) => [field.key, field]))

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// 字段清单供 fold_config 的 get 与参数 schema 复用；返回副本，调用方改不动内部表。
export function configFields() {
  return FIELDS.map((field) => ({ ...field }))
}

export function defaultConfig() {
  const config = {}
  for (const field of FIELDS) config[field.key] = field.default
  return config
}

export function normalizeConfig(patch, base = defaultConfig(), onWarn) {
  const next = { ...base }
  if (!isPlainObject(patch)) return next
  if (typeof onWarn === 'function') {
    for (const key of Object.keys(patch)) {
      if (!FIELD_MAP.has(key)) onWarn('未知配置项 ' + key + '，已忽略')
    }
  }
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field.key)) continue
    const value = patch[field.key]
    if (field.kind === 'boolean') {
      if (typeof value === 'boolean') next[field.key] = value
      continue
    }
    if (field.kind === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      next[field.key] = Math.min(field.max, Math.max(field.min, Math.floor(value)))
      continue
    }
    if (field.kind === 'ratio') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const clamped = Math.min(field.max, Math.max(field.min, value))
      // 保留四位小数：配置要落盘给人看，避免浮点尾巴。
      next[field.key] = Math.round(clamped * 10000) / 10000
      continue
    }
    if (field.kind === 'string') {
      if (typeof value !== 'string') continue
      next[field.key] = value.slice(0, field.maxChars)
    }
  }
  return next
}

// 摘要预算：先按原文比例算，再压在硬上限之下。80 是下限，保证编号与召回入口总写得进去。
export function noteBudget(totalChars, config) {
  const settings = config || {}
  const ratio = typeof settings.noteRatio === 'number' && Number.isFinite(settings.noteRatio) ? settings.noteRatio : 0.1
  const cap = typeof settings.maxNoteChars === 'number' && Number.isFinite(settings.maxNoteChars) ? settings.maxNoteChars : 320
  return Math.min(cap, Math.max(80, Math.round(totalChars * ratio)))
}

// fold_config 用的严格校验：类型不对或越界都返回原因，不做静默钳制。
export function validateConfigPatch(patch) {
  if (!isPlainObject(patch)) {
    return { ok: false, errors: ['patch 必须是对象，形如 {"noteRatio": 0.2}。'], patch: {} }
  }
  const keys = Object.keys(patch)
  if (keys.length === 0) {
    return { ok: false, errors: ['patch 里没有任何配置项。'], patch: {} }
  }
  const errors = []
  const clean = {}
  for (const key of keys) {
    const field = FIELD_MAP.get(key)
    if (!field) {
      errors.push('未知配置项 ' + key + '；可用：' + FIELDS.map((item) => item.key).join('、'))
      continue
    }
    const value = patch[key]
    if (field.kind === 'boolean') {
      if (typeof value !== 'boolean') errors.push(key + ' 必须是 true 或 false')
      else clean[key] = value
      continue
    }
    if (field.kind === 'integer' || field.kind === 'ratio') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(key + ' 必须是数字')
      } else if (field.kind === 'integer' && !Number.isInteger(value)) {
        errors.push(key + ' 必须是整数')
      } else if (value < field.min || value > field.max) {
        errors.push(key + ' 必须在 ' + field.min + '~' + field.max + ' 之间（收到 ' + value + '）')
      } else {
        clean[key] = value
      }
      continue
    }
    if (field.kind === 'string') {
      if (typeof value !== 'string') errors.push(key + ' 必须是字符串')
      else if (value.length > field.maxChars) errors.push(key + ' 不能超过 ' + field.maxChars + ' 字')
      else clean[key] = value
    }
  }
  return { ok: errors.length === 0, errors, patch: clean }
}

// 配置落盘：整份覆盖写，和 ConfigStore.save 的行为一致。
export function writeConfigFile(filePath, config) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

export class ConfigStore {
  constructor({ homeDir, log }) {
    this.filePath = join(homeDir, configFileName)
    this.log = log || null
    this.current = defaultConfig()
  }

  // 宿主没传 logger 时退回控制台：配置写错至少能被人看见，而不是静默失效。
  warn(message) {
    const line = '配置：' + message
    if (this.log && typeof this.log.warn === 'function') this.log.warn(line)
    else console.warn('[' + pluginName + '] ' + line)
  }

  // 返回生效配置的副本，调用方拿到的是快照，改它不影响下一次读取。
  load(pluginConfig = {}) {
    let fromFile = {}
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (isPlainObject(raw)) fromFile = raw
    } catch {
      // 首次运行没有文件，或文件被写坏：都退回上一层配置。
    }
    const patch = { ...(isPlainObject(pluginConfig) ? pluginConfig : {}), ...fromFile }
    this.current = normalizeConfig(patch, defaultConfig(), (message) => this.warn(message))
    return this.get()
  }

  get() {
    return { ...this.current }
  }

  save(patch) {
    this.current = normalizeConfig(patch, this.current, (message) => this.warn(message))
    writeConfigFile(this.filePath, this.current)
    return this.get()
  }
}

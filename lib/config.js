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
import { defaultHitRate } from './pricing.js'
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
    description: '检查点里回复预览的长度上限（固定字数，不按原文比例）；思考与工具只留计数',
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
    key: 'searchPreviewChars',
    kind: 'integer',
    min: 20,
    max: 300,
    default: 60,
    description: '关键词检索结果里每段命中片段保留的字数',
  },
  {
    key: 'maxSearchFolds',
    kind: 'integer',
    min: 1,
    max: 50,
    default: 8,
    description: '关键词检索一次最多列几条折叠（更早的只给数量提示）',
  },
  {
    key: 'maxPinTextChars',
    kind: 'integer',
    min: 0,
    max: 200000,
    default: 0,
    description: '单条重要消息的正文上限，0 表示不截断（默认）；设成正数只截断、不拒绝发布',
  },
  {
    key: 'maxPins',
    kind: 'integer',
    min: 0,
    max: 100000,
    default: 0,
    description: '重要消息条数的软上限，0 表示不限制（默认）；超了照常发布，只在返回里提示',
  },
  {
    key: 'pinBudgetChars',
    kind: 'integer',
    min: 0,
    max: 10000000,
    default: 0,
    description: '全部重要消息的字符软预算，0 表示不限制（默认）；超了照常发布，只在返回里提示',
  },
  {
    key: 'systemPromptText',
    kind: 'string',
    maxChars: 20000,
    default: defaultSystemPromptText(),
    description: '系统提示段文案，支持 {{recallTool}}、{{pinTool}}、{{configTool}} 占位；空串表示不注入',
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
  {
    key: 'maxStoreChars',
    kind: 'integer',
    min: 0,
    max: 100000000,
    default: 8000000,
    description: '每个会话的 fold-store 载荷上限（字符），0 表示不限制；超了从最旧的折叠开始清理',
  },
  {
    key: 'cacheHitRate',
    kind: 'ratio',
    min: 0,
    max: 1,
    default: defaultHitRate,
    description: '前缀缓存的真实命中率（默认 0.97，DeepSeek 实测约 97%）；有 provider 回报时成本模型会自动改用实测值',
  },
  {
    key: 'priceCacheHitInput',
    kind: 'price',
    min: 0,
    max: 1000,
    default: 0.02,
    description: '缓存命中输入的单价，元 / 百万 token；默认 0.02（DeepSeek 空闲时段官方价）',
  },
  {
    key: 'priceInput',
    kind: 'price',
    min: 0,
    max: 1000,
    default: 1,
    description: '缓存未命中输入的单价，元 / 百万 token；默认 1（DeepSeek 空闲时段官方价，高峰时段是它的两倍）',
  },
  {
    key: 'priceOutput',
    kind: 'price',
    min: 0,
    max: 1000,
    default: 4,
    description: '输出的单价，元 / 百万 token；默认 4（DeepSeek 空闲时段官方价）',
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
    if (field.kind === 'ratio' || field.kind === 'price') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const clamped = Math.min(field.max, Math.max(field.min, value))
      // 比例保留四位、单价保留六位：配置要落盘给人看，避免浮点尾巴。
      const scale = field.kind === 'price' ? 1000000 : 10000
      next[field.key] = Math.round(clamped * scale) / scale
      continue
    }
    if (field.kind === 'string') {
      if (typeof value !== 'string') continue
      next[field.key] = value.slice(0, field.maxChars)
    }
  }
  return next
}

// 检查点长度：固定上限，只约束回复预览。不按原文比例——原文长短不该改变编号、计数与文件行。
export function noteChars(config) {
  const settings = config || {}
  return typeof settings.maxNoteChars === 'number' && Number.isFinite(settings.maxNoteChars) ? settings.maxNoteChars : 320
}

// fold_config 用的严格校验：类型不对或越界都返回原因，不做静默钳制。
export function validateConfigPatch(patch) {
  if (!isPlainObject(patch)) {
    return { ok: false, errors: ['patch 必须是对象，形如 {"maxNoteChars": 400}。'], patch: {} }
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
    if (field.kind === 'integer' || field.kind === 'ratio' || field.kind === 'price') {
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

// 文件层只保存「显式改过」的键（含把某键显式设成默认值，用来压过 profile）。
// 不写成整份快照：升级默认值（单价、提示词、配额）才能穿透到已经保存过的会话。
export function writeConfigFile(filePath, patch) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const body = isPlainObject(patch) ? patch : {}
    writeFileSync(filePath, JSON.stringify(body, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

// 没有热更新接线时（旧宿主 / 直接调用）用的兜底：把 patch 合并进已有文件层，
// 只写白名单键、只覆盖 patch 里出现的键。
export function mergeConfigFile(filePath, patch) {
  let existing = {}
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    if (isPlainObject(raw)) existing = raw
  } catch {
    // 没有文件或文件坏了：从空的文件层开始。
  }
  const clean = normalizeConfig(patch, {})
  const next = { ...existing }
  for (const field of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(clean, field.key)) next[field.key] = clean[field.key]
  }
  return writeConfigFile(filePath, next) ? next : null
}

export class ConfigStore {
  constructor({ homeDir, log }) {
    this.filePath = join(homeDir, configFileName)
    this.log = log || null
    this.current = defaultConfig()
    // 三层：默认值 < profile config < 文件层。filePatch 只放显式改过的键，
    // 早先把「合并后的 current」整份写回文件，profile 的值会被冻结进文件、之后再改 profile 永远不生效。
    this.pluginConfig = {}
    this.filePatch = {}
  }

  // 宿主没传 logger 时退回控制台：配置写错至少能被人看见，而不是静默失效。
  warn(message) {
    const line = '配置：' + message
    if (this.log && typeof this.log.warn === 'function') this.log.warn(line)
    else console.warn('[' + pluginName + '] ' + line)
  }

  // 文件层只保留白名单键；未知键在应用时由 normalizeConfig 统一 warn，避免重复。
  fileLayer(raw) {
    if (!isPlainObject(raw)) return {}
    const out = {}
    for (const field of FIELDS) {
      if (Object.prototype.hasOwnProperty.call(raw, field.key)) out[field.key] = raw[field.key]
    }
    return out
  }

  applyLayers() {
    return normalizeConfig(
      { ...this.pluginConfig, ...this.filePatch },
      defaultConfig(),
      (message) => this.warn(message),
    )
  }

  // 返回生效配置的副本，调用方拿到的是快照，改它不影响下一次读取。
  load(pluginConfig = {}) {
    this.pluginConfig = isPlainObject(pluginConfig) ? { ...pluginConfig } : {}
    let fromFile = {}
    try {
      fromFile = this.fileLayer(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch {
      // 首次运行没有文件，或文件被写坏：都退回上一层配置。
    }
    this.filePatch = fromFile
    this.current = this.applyLayers()
    return this.get()
  }

  get() {
    return { ...this.current }
  }

  // 写文件失败必须让调用方知道：内存生效、磁盘没生效，重启后会变回去。
  persist(patch) {
    if (!writeConfigFile(this.filePath, patch)) {
      this.warn('写配置文件失败：' + this.filePath)
      throw new Error('写配置文件失败：' + this.filePath)
    }
  }

  save(patch) {
    // normalizeConfig(patch, {}) 只返回 patch 里出现的键（并做钳制），
    // 这样文件层只记「这次显式改了什么」，profile 里没碰过的键继续跟着 profile 走。
    const clean = normalizeConfig(patch, {}, (message) => this.warn(message))
    const next = { ...this.filePatch, ...clean }
    this.persist(next)
    this.filePatch = next
    this.current = this.applyLayers()
    return this.get()
  }

  // reset 写的是「所有字段都显式等于默认值」：只有这样才能压过 profile 里的旧值。
  // 想回到 profile 的配置，就删掉 fold-config.json（或手工改成 {}）再重启。
  reset() {
    const defaults = defaultConfig()
    this.persist(defaults)
    this.filePatch = { ...defaults }
    this.current = { ...defaults }
    return this.get()
  }
}

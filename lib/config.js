// 配置：默认值在这里，运行时值来自 profile 里 insert 行的 config 与 $DSH_HOME/fold-config.json。
// 优先级：默认值 < profile config < 配置文件——手工改文件能立刻覆盖 profile 里的值。
// 所有字段都做钳制：越界配置只降级，不让插件加载失败。折叠是优化，不是必需能力。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configFileName } from './constants.js'

export function defaultConfig() {
  return {
    // 总开关：关掉后只注册工具与提示词，不再自动折叠。
    enabled: true,
    // 一轮里「思考 + 回复 + 工具输出」的总字符低于它就整轮不折——短回合折了反而更贵。
    minFoldChars: 1200,
    // 折叠摘要自身的字符上限。
    maxNoteChars: 320,
    // 同一条折叠被召回超过这个次数后，召回结果里附一句「该固化了」。
    recallReminderAfter: 3,
    // 单次召回返回的原文上限，防模型一次把整个上下文拉回来。
    maxRecallChars: 24000,
    // 单条重要消息的正文上限。
    maxPinTextChars: 4000,
    // 单个会话允许的重要消息条数与正文总预算。
    maxPins: 12,
    pinBudgetChars: 12000,
  }
}

// [字段, 最小值, 最大值]：范围写在这里，normalize 只认这张表。
const NUMERIC = [
  ['minFoldChars', 200, 200000],
  ['maxNoteChars', 80, 2000],
  ['recallReminderAfter', 1, 50],
  ['maxRecallChars', 1000, 200000],
  ['maxPinTextChars', 200, 20000],
  ['maxPins', 1, 200],
  ['pinBudgetChars', 500, 200000],
]

export function normalizeConfig(patch, base = defaultConfig()) {
  const next = { ...base }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return next
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  for (const [key, low, high] of NUMERIC) {
    const value = patch[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    next[key] = Math.min(high, Math.max(low, Math.floor(value)))
  }
  return next
}

export class ConfigStore {
  constructor({ homeDir }) {
    this.filePath = join(homeDir, configFileName)
    this.current = defaultConfig()
  }

  // 返回生效配置的副本，调用方拿到的是快照，改它不影响下一次读取。
  load(pluginConfig = {}) {
    let fromFile = {}
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) fromFile = raw
    } catch {
      // 首次运行没有文件，或文件被写坏：都退回上一层配置。
    }
    this.current = normalizeConfig({ ...normalizeConfig(pluginConfig), ...fromFile })
    return this.get()
  }

  get() {
    return { ...this.current }
  }

  save(patch) {
    this.current = normalizeConfig(patch, this.current)
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.current, null, 2) + '\n', 'utf8')
    } catch {
      // 写不进去就只影响下次启动；内存里的值已经生效。
    }
    return this.get()
  }
}

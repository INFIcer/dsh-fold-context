// 日志：控制台一行，落盘一行。任何一步失败都不往外抛——日志坏掉不能拖垮折叠。

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logFileName, pluginName } from './constants.js'

// filePath 传 null 表示只写控制台（测试里用）。
export function createLogger(homeDir, options = {}) {
  const filePath = options.filePath === undefined ? join(homeDir, logFileName) : options.filePath
  const prefix = '[' + pluginName + ']'

  function write(line) {
    try {
      process.stderr.write(line + '\n')
    } catch {
      // 控制台不可用就只落盘。
    }
    if (!filePath) return
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      appendFileSync(filePath, line + '\n', 'utf8')
    } catch {
      // 盘满或没权限：保留控制台输出即可。
    }
  }

  return {
    filePath,
    info: (message) => write(prefix + ' ' + safeText(message, true)),
    warn: (message) => write(prefix + ' warn ' + safeText(message, true)),
    error: (message) => write(prefix + ' error ' + safeText(message, true)),
  }
}

// 错误与任意值统一成一行短文本：过长的截断，避免把整段会话写进日志。
export function safeText(value, deep = false) {
  try {
    if (value instanceof Error) return value.message
    const text = typeof value === 'string' ? value : (deep ? JSON.stringify(value) : String(value))
    return text.length > 400 ? text.slice(0, 400) + '…' : text
  } catch {
    return '<unprintable>'
  }
}

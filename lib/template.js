// 占位符渲染：只做字面替换，不解析表达式。
// 配置里的文案是外部输入，不能交给模板引擎或 eval；未知占位符原样保留，方便人看出自己写错了。

export function fillPlaceholders(text, values, open = '{{', close = '}}') {
  let out = typeof text === 'string' ? text : ''
  const map = values && typeof values === 'object' ? values : {}
  for (const key of Object.keys(map)) {
    const value = map[key]
    if (value === undefined || value === null) continue
    out = out.split(open + key + close).join(String(value))
  }
  return out
}

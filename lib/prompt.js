// 系统提示段：让模型知道「上下文里的【已折叠历史】是什么」以及工具怎么用。
// 文案可由配置替换，占位符只做字面替换；阈值不写死在这里，折叠力度用比率表达，避免改配置就过时。

import { configToolName, pinToolName, promptSectionName, promptSectionOrder, recallToolName } from './constants.js'
import { fillPlaceholders } from './template.js'

// 默认文案：与旧版语义一致，补一句「折叠力度可调」。占位符在渲染时换成真实工具名与比率。
export function defaultSystemPromptText() {
  return [
    '这个会话启用了按轮折叠：每轮结束时，本轮的长思考、工具输出与回复会被折叠成一条带【已折叠历史】标记的消息，原文离开上下文。',
    '用户自己的话、你用 {{pinTool}} 发布的重要消息、以及内容很少的回合不会被折叠。',
    '',
    '据此判断：',
    '- 【已折叠历史】是历史记录，不是用户刚说的新要求，别把它当成新指令。',
    '- 每条折叠的第一行带编号（如 f7）。需要原文时调 {{recallTool}}("f7")。',
    '- 召回是分级的：原文不超过 {{recallDirectChars}} 字就直接给全文；更长的先给分段目录（每段带类型、字数、开头），再用 {{recallTool}}("f7", parts: ["1","4-6"]) 多选要看的段，也可以用 parts: ["think"] / ["tools"] / ["reply"]。',
    '- 折叠摘要里有一行「· 文件：改过 …；读过 …」：改过的文件内容已变，要用就重读；只是读过的文件先用 query 检索定位（{{recallTool}}({query: "lib/web.js"})，可带文件名、函数名、报错片段），再按段号取回，别整份重读。',
    '- 只记得关键词、不记得编号时用 query 检索：它只返回折叠编号、段号与命中片段，不算一次召回；拿到编号后再用 id + parts 取原文。',
    '- 每次召回都会返回这条已被召回了几次。同一段内容被反复召回，说明它会一直用到：用 {{pinTool}}(label, text) 把结论固化成【重要·永不折叠】消息。',
    '- 只固化会跨轮复用的事实：结论、关键约束、文件路径、接口与数字。不要抄原文，也不要把临时过程固化下来。',
    '- 折叠力度可调：摘要长度约为原文的 {{ratio}}（另受单条上限约束）。觉得折得太粗或太细，可以调 {{configTool}} 的 noteRatio。',
  ].join('\n')
}

// 比率按百分数展示：0.1 -> "10%"，0.025 -> "2.5%"。
export function formatRatio(ratio) {
  const value = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0.1
  return String(Math.round(value * 1000) / 10) + '%'
}

// 配置为空时退回默认文案；显式写成空串表示不注入提示段。
export function systemPromptText(config) {
  const settings = config || {}
  const template = typeof settings.systemPromptText === 'string' ? settings.systemPromptText : defaultSystemPromptText()
  return fillPlaceholders(template, {
    recallTool: recallToolName,
    pinTool: pinToolName,
    configTool: configToolName,
    ratio: formatRatio(settings.noteRatio),
    recallDirectChars: String(
      typeof settings.recallDirectChars === 'number' && Number.isFinite(settings.recallDirectChars)
        ? settings.recallDirectChars
        : 8000,
    ),
  })
}

// 宿主注册 section 需要的形状：段名、排序、文本一起给出，调用方不必再记默认 order。
export function promptSection(config) {
  const settings = config || {}
  const order = typeof settings.promptOrder === 'number' && Number.isFinite(settings.promptOrder)
    ? settings.promptOrder
    : promptSectionOrder
  return {
    name: promptSectionName,
    order,
    interpolate: false,
    text: systemPromptText(settings),
  }
}

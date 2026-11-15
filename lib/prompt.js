// 系统提示段：让模型知道「上下文里的【已折叠历史】是什么」以及工具怎么用。
// 文案可由配置替换，占位符只做字面替换；阈值不写死在这里，折叠力度用固定上限表达，避免改配置就过时。

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
    '- 召回是分级的：原文不超过 {{recallDirectTokens}} token 估算就直接给全文；更长的先给分段目录（每段带类型、字数、开头；长 markdown 回复按标题切段），再用 {{recallTool}}("f7", parts: ["1","4-6"]) 多选要看的段，也可以用 parts: ["think"] / ["tools"] / ["reply"]。',
    '- 折叠摘要里有一行「· 文件：改过 …；读过 …」：改过的文件内容已变，要用就重读；只是读过的文件先用 query 检索定位（{{recallTool}}({query: "lib/web.js"})，可带文件名、函数名、报错片段），再按段号取回，别整份重读。',
    '- 只记得关键词、不记得编号时用 query 检索：它只返回折叠编号、段号与命中片段，不算一次召回；拿到编号后再用 id + parts 取原文。',
    '- 每次召回都会返回这条已被召回了几次。次数多说明它会一直用到，用 {{pinTool}}(label, text) 固化成【重要·永不折叠】消息。',
    '- 不必等被反复召回才固化：跨轮会复用的结论、关键约束、文件路径、接口与数字，尽早单独记一条，宁短不长；不要抄原文，也不要把临时过程固化下来。',
    '- 重要消息每轮都在上下文里：一条只说一件事、几行字最好；但不用为了省字而不敢记——多记几条短消息，比之后反复召回划算。',
    '- 检查点里回复预览的长度上限是 {{configTool}} 的 maxNoteTokens：回复不超过上限时原样保留；超过时 markdown 回复按标题摘要（标题全部列出，不受上限约束），其它回复留开头和结尾；思考与工具只留计数。觉得摘要太粗或太细，就调这个上限。',
  ].join('\n')
}

// 配置为空时退回默认文案；显式写成空串表示不注入提示段。
export function systemPromptText(config) {
  const settings = config || {}
  const template = typeof settings.systemPromptText === 'string' ? settings.systemPromptText : defaultSystemPromptText()
  return fillPlaceholders(template, {
    recallTool: recallToolName,
    pinTool: pinToolName,
    configTool: configToolName,
    recallDirectTokens: String(
      typeof settings.recallDirectTokens === 'number' && Number.isFinite(settings.recallDirectTokens)
        ? settings.recallDirectTokens
        : 500,
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

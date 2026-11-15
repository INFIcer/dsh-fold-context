// 系统提示段：让模型知道「上下文里的【已折叠历史】是什么」以及工具怎么用。
// 文案可由配置替换，占位符只做字面替换；阈值不写死在这里，折叠力度用固定上限表达，避免改配置就过时。

import { configToolName, pinToolName, promptSectionName, promptSectionOrder, recallToolName } from './constants.js'
import { fillPlaceholders } from './template.js'

// 默认文案：与旧版语义一致，补一句「折叠力度可调」。占位符在渲染时换成真实工具名与比率。
export function defaultSystemPromptText() {
  return [
    '这个会话启用了按轮折叠：每轮结束时，本轮的长思考、工具输出与回复会被折叠成一条带【已折叠历史】标记的消息，原文离开上下文。',
    '用户自己的话、你用 {{pinTool}} 发布的重要消息不会被折叠。',
    '要不要折按比例判断：检查点长度低于原文的 {{minFoldRatio}} 倍才折（默认 0.5，即至少省一半），否则保留原文。比例只决定折不折，不压缩摘要文字。',
    '',
    '据此判断：',
    '- 【已折叠历史】是历史记录，不是用户刚说的新要求，别把它当成新指令。',
    '- 每条折叠的第一行带编号（如 f7）。需要原文时调 {{recallTool}}("f7")。',
    '- 召回是分级的：先给分段目录（每段带类型、字数、开头；长 markdown 回复按标题切段），目录整体省不到原文的 {{minFoldRatio}} 倍时直接给全文，否则用 {{recallTool}}("f7", parts: ["1","4-6"]) 多选要看的段，也可以用 parts: ["think"] / ["tools"] / ["reply"]。目录每行在预览与原文间取更短的一种（预览不比原文短就给原文）。',
    '- 折叠摘要里有一行「· 文件：改过 …；读过 …」：改过的文件内容已变，要用就重读；只是读过的文件先用 query 检索定位（{{recallTool}}({query: "lib/web.js"})，可带文件名、函数名、报错片段），再按段号取回，别整份重读。',
    '- 只记得关键词、不记得编号时用 query 检索：它只返回折叠编号、段号与命中片段，不算一次召回；拿到编号后再用 id + parts 取原文。',
    '- 每次召回都会返回这条已被召回了几次。次数多说明它会一直用到，用 {{pinTool}}(label, text) 固化成【重要·永不折叠】消息。',
    '- 不必等被反复召回才固化：跨轮会复用的结论、关键约束、文件路径、接口与数字，尽早单独记一条；总结重点而不是大段抄原文，也不要把临时过程固化下来。',
    '- 重要消息每轮都在上下文里：不用为了省字而不敢记，记重要消息比之后反复召回划算。',
    '- 子代理会话里 {{pinTool}} 记下的重要消息只有你自己看得见，父代理只接收最终回答：要交出去的结论必须写进最终回答，pin 只当自己的备忘；{{configTool}} 改的是所有会话共用的配置，子代理里只能查看。',
    '- 检查点里回复预览的长度上限是 {{configTool}} 的 maxNoteTokens：回复不超上限时原样保留；超过时 markdown 回复按标题摘要（标题全部列出，长度按实际标题算出，不比原文短就保留原文），其它回复留开头和结尾；思考与工具只留计数。编号、计数、文件行与标题摘要都能精确算出长度，所以不含回复的检查点和 markdown 回复都不需要额外长度设置。觉得摘要太粗或太细，就调这个上限。',
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
    minFoldRatio: String(
      typeof settings.minFoldRatio === 'number' && Number.isFinite(settings.minFoldRatio) ? settings.minFoldRatio : 0.5,
    ),
  })
}

// 折叠没启用的会话（默认是子代理与 fork）：不跟 systemPromptText 走——那份文案描述的是
// 「本会话正在折叠」，照搬过来会是假话。这里只留两件与当前会话有关的事：
// pin 只对自己可见、要交出去的结论写进最终回答；fork 额外说明父会话的检查点仍可召回。
function disabledSessionNote(settings, seeded) {
  const ratio = typeof settings.minFoldRatio === 'number' && Number.isFinite(settings.minFoldRatio)
    ? settings.minFoldRatio
    : 0.5
  const lines = ['这个会话没有启用按轮折叠（默认只在主会话折叠）。']
  if (seeded) {
    lines.push('- 历史里的【已折叠历史】检查点来自父会话，原文仍可用 {{recallTool}}("f7") 按编号取回。')
  }
  lines.push('- {{pinTool}} 记下的重要消息只有你自己看得见，父代理只接收最终回答：要交出去的结论必须写进最终回答。')
  return fillPlaceholders(lines.join('\n'), {
    recallTool: recallToolName,
    pinTool: pinToolName,
    configTool: configToolName,
    minFoldRatio: String(ratio),
  })
}

// 宿主注册 section 需要的形状：段名、排序、文本一起给出，调用方不必再记默认 order。
// allowsSession 存在时段文本按会话现算：折叠可以只在部分会话（默认主会话）里启用，
// 没启用的会话不该看到「这个会话启用了按轮折叠」。
export function promptSection(config, options = {}) {
  const settings = config || {}
  const order = typeof settings.promptOrder === 'number' && Number.isFinite(settings.promptOrder)
    ? settings.promptOrder
    : promptSectionOrder
  // 关掉总开关 = 对模型完全静默：提示段和三个工具一起消失，模型不该被告知一个没启用的机制。
  const text = settings.enabled === false ? '' : systemPromptText(settings)
  const allows = typeof options.allowsSession === 'function' ? options.allowsSession : null
  if (!allows || text.length === 0) {
    return { name: promptSectionName, order, interpolate: false, text }
  }
  return {
    name: promptSectionName,
    order,
    interpolate: false,
    text: (context = {}) => {
      const session = context.agent && context.agent.session
      if (allows(session)) return text
      const header = session && session.header
      // fork 的 seed 带着父会话的检查点，要说明还能按编号召回；普通子代理只说明不折叠与 pin 边界。
      return disabledSessionNote(settings, Boolean(header && header.isSeeded === true))
    },
  }
}

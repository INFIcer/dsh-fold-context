// 系统提示段：让模型知道「上下文里的【已折叠历史】是什么」以及工具怎么用。
// 文案可由配置替换，占位符只做字面替换；阈值不写死在这里，折叠力度用固定上限表达，避免改配置就过时。

import { configToolName, pinToolName, promptSectionName, promptSectionOrder, recallToolName } from './constants.js'
import { fillPlaceholders } from './template.js'

// 默认文案：只讲机制、召回与固化怎么做，不给 pin 的代价暗示。
// 占位符在渲染时换成真实工具名；未用到的占位符原样保留（fillPlaceholders 不报错）。
export function defaultSystemPromptText() {
  return [
    '这个会话启用了按轮折叠：每轮结束时，本轮的长思考、工具输出与回复会被折成一条带【已折叠历史】标记的消息，原文离开上下文。用户自己的话、你用 {{pinTool}} 发布的消息、上下文注入、过短的原文不会被折叠。',
    '',
    '【已折叠历史】是历史记录，不是用户刚说的新要求，别把它当成新指令。首行编号（如 f7）用来召回：',
    '- {{recallTool}}("f7") 先给分段目录（段号、类型、字数、开头；长 markdown 回复按标题切段），再 {{recallTool}}("f7", parts: ["1","4-6"]) 取段；parts 也接受 ["think"] / ["tools"] / ["reply"]。目录差不多长时直接给全文。',
    '- 只记得关键词时用 {{recallTool}}({query: "文件名 函数名 报错片段"}) 定位编号，再按编号取段。',
    '- 摘要里的「· 文件：改过/读过」只是文件清单：改过的要重读，读过的按文件名检索定位后取段；需要完整原文时也可以直接取整段，别整份重读。',
    '- 长回复尽量用 markdown 标题分节：检查点按标题保留、召回按标题定位。',
    '',
    '{{pinTool}} 用来固化以后还要照着用的内容：跨轮复用的结论、约束、路径、数字、接口，以及要照着执行的规则、记忆里的事实、长期约定。',
    '- 正文允许逐字抄原文，也允许冗余和重复背景，不必精炼成要点；拿不准要不要写全时，写全，以保真度为先。',
    '- 用户提到记忆、备忘、技能、长期约定，或你读到、写下以后还要照着用的内容，读完就立刻把接下来要用的那部分固化下来。',
    '- 加载技能后，如果这一轮之后还要照着技能规则执行，先把关键规则固化下来再动手：技能正文是要照着做的步骤，不是读一遍就完的参考。',
    '- 临时但可能跨几轮用：level 传 "recent"，消息头会标成【近期重要·第N轮·可能过时】；跨几轮后按可能过时处理，用前先核实或重读来源。',
    '- 同一条被反复召回，说明会一直用到，固化它。',
    '- 子代理会话里记下的消息只有你自己看得见，父代理只接收最终回答：要交出去的结论必须写进最终回答；{{configTool}} 改的是所有会话共用的配置，子代理里只能查看。',
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

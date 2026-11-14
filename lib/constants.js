// 常量集中管理：插件名、系统提示段、会话日志里的 source 标记、落盘文件名。
// 这些字符串是模型与旧会话都依赖的契约，改名等于让已折叠的历史失去含义。

export const pluginName = 'dsh-fold-context'

// 系统提示段：段名是宿主判重的唯一依据，order 决定它排在部署 persona 之后、工具说明之前。
export const promptSectionName = 'fold-compression'
export const promptSectionOrder = 300

// user/message 的 source.kind：会话日志据此区分「折叠摘要」与「模型发布的重要消息」。
export const sourceCheckpoint = 'fold-checkpoint'
export const sourcePin = 'fold-pin'
// 调度器投递的用户指令：它不是摘要，是这一轮的起点，折叠它就是吞掉用户的要求。
export const sourceSchedule = 'schedule'
// 官方压缩（compaction-basic）落下的检查点：它是一次整体摘要，本身不该再被折叠，
// 否则模型视角里连「哪一段被压过」都看不见了。
export const sourceCompactCheckpoint = 'compact-checkpoint'

// 摘要与重要消息的固定前缀：模型靠它认出「这段不是用户说的话」。
export const checkpointPrefix = '【已折叠历史】'
export const pinPrefix = '【重要·永不折叠】'

// 落盘位置（都相对 DSH_HOME）。
export const storeDirName = 'fold-store'
export const configFileName = 'fold-config.json'
export const logFileName = 'dsh-fold-context.log'

// 可视化调试报告目录（相对 DSH_HOME）：离线脚本每次覆盖同一份 HTML。
export const reportDirName = 'fold-debug'

// 工具名是模型要记住的契约：召回时摘要里写的编号要和它配套。
export const recallToolName = 'fold_recall'
export const pinToolName = 'fold_pin'
// 运行时读写配置的工具名；提示词里的「调 noteRatio」指的就是它。
export const configToolName = 'fold_config'

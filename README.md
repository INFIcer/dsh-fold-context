# dsh-fold-plugin

按轮折叠 DSH 会话历史：每轮结束时把本轮的思考、工具输出与长回复折成一条检查点消息，原文可凭编号召回，重要消息永不折叠。

它不接管压缩引擎，只降低每轮历史进入上下文的速度。

## 行为

1. 轮结束（`agent/turn-stopping`）时，把本轮从第一条 `assistant/message` 到最后一个节点的区间整体替换成一条 `user/message` 检查点消息。
2. 不折：用户原话、`fold_pin` 重要消息、上一次的检查点本身；单轮内容少于 `minFoldChars` 也不折。
3. 检查点正文写清折叠了几步、几次工具调用、工具名、回复的开头与结尾，并给出 `fold_recall("f7")` 这类编号。
4. 模型可调 `fold_recall` 取回原文（会累计召回次数，超过 `recallReminderAfter` 时要求模型用 `fold_pin` 固化结论）。
5. `fold_pin` 追加一条 `【重要·永不折叠】` 消息，永不被折叠。
6. 系统提示词追加一段 `fold-compression`，说明机制与三个工具（`fold_recall`、`fold_pin`、`fold_config`）的用法。
7. 模型可以用 `fold_config` 在会话中查看、修改或重置配置，不用重启。

## 安装

profile 的 `package.json` 里加 link 依赖并把包名加进 `dsh.profile.bundles`：

```json
"dependencies": { "dsh-fold-plugin": "link:E:/dsh-fold-plugin" },
"dsh": { "profile": { "bundles": ["...", "dsh-fold-plugin"] } }
```

重启 DSH 生效。包内 `cordis.patch.yml` 负责把插件插进插件表。

## 配置

配置按「默认值 < profile 里的 `config` < `$DSH_HOME/fold-config.json`」合并，文件里的值最后生效。加载时越界值自动钳制、未知键忽略并写一条 warn，所以写错配置不会让插件起不来。

| 字段 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `enabled` | `true` | 布尔 | 总开关，关掉只留工具与提示词 |
| `minFoldChars` | `1200` | 200~200000 | 一轮里思考+工具输出+回复的字符数低于此值不折 |
| `maxNoteChars` | `320` | 80~4000 | 检查点摘要的硬上限 |
| `noteRatio` | `0.1` | 0.02~0.5 | 摘要按原文比例计算：`min(maxNoteChars, max(80, round(原文 * noteRatio)))` |
| `recallReminderAfter` | `3` | 1~50 | 同一段召回超过几次就提醒固化 |
| `recallReminderText` | 内置文案 | ≤2000 字 | 固化提醒，支持 `{count}` 与 `{tool}`；空串表示不提醒 |
| `maxRecallChars` | `24000` | 1000~200000 | 单次召回返回的字符上限 |
| `maxPinTextChars` | `4000` | 200~20000 | 单条重要消息的正文上限 |
| `maxPins` | `12` | 1~200 | 重要消息条数上限 |
| `pinBudgetChars` | `12000` | 500~200000 | 全部重要消息的字符预算 |
| `systemPromptText` | 内置文案 | ≤20000 字 | 系统提示段，支持 `{{recallTool}}`、`{{pinTool}}`、`{{configTool}}`、`{{ratio}}`；空串表示不注入 |
| `promptOrder` | `300` | -1000~10000 | 系统提示段的排序值，越小越靠前 |
| `foldToolOutputs` | `true` | 布尔 | `false` 时工具输出既不进摘要、也不进召回载荷，也不计入 `minFoldChars` 的体量 |
| `maxFoldsPerTurn` | `8` | 1~32 | 一轮最多折成几段，超出的片段保留原文 |

`recallReminderText` 的占位用单花括号，`systemPromptText` 的占位用双花括号，两者互不影响。

运行时用 `fold_config` 改配置：

- `fold_config({ action: "get" })`：返回当前生效配置、配置文件路径与每项取值范围。
- `fold_config({ action: "set", patch: { noteRatio: 0.2 } })`：只接受上表白名单键，逐项校验；通过后写文件并立即生效。非法键或越界值整批拒绝，不会出现「改了一半」。
- `fold_config({ action: "reset" })`：恢复全部默认值并写文件。

手工改 `fold-config.json` 也可以，但要重启 DSH 才生效；想让改动立刻起作用，用 `fold_config`。

## 数据落在哪

- 会话日志：检查点与重要消息都是普通 `user/message`，`source.kind` 分别是 `fold-checkpoint`、`fold-pin`。恢复/分叉照原样重放，不依赖插件在线。
- `$DSH_HOME/fold-store/<会话>.jsonl`：折叠原文、召回次数、重要消息快照。召回靠它，删掉就只能看到检查点的摘要行。
- `$DSH_HOME/dsh-fold-plugin.log`：运行日志。

## 可视化调试

`fold_inspect` 把「模型真正看到的历史」与「不折叠时的历史」并排写成一份本地 HTML，用来核对折叠到底省了多少、哪几段被召回或固化：

- 概览：折叠后/不折叠的字符与两档 token 估算、节省率、折叠段数、召回总次数、重要消息条数与占用字符。
- 按轮对比与折叠段明细：每一步的折叠前/后字符、节省、被召回次数、是否已固化。
- 事件时间线与逐条消息列表：按 `fold` / `recall` / `pin` 记录的 `at` 排序；两个视角各自可折叠。
- 报告写在 `$DSH_HOME/fold-debug/<会话>.html`，同一会话重复生成会覆盖，零外部资源，不联网。

不传 `sessionId` 就检查当前会话；找不到会话或原文载荷缺失时返回明确原因，不抛错。

## 已知限制

- 召回文本按会话存在 `$DSH_HOME/fold-store/`：分叉出来的新会话读不到父会话的载荷，召回会返回「找不到」。
- 每次替换都会让请求前缀变化，billion-context 下一次请求会全量重发一次；这是折叠的固有成本。
- 只折叠插件在线期间观察到的轮次：插件装上之前的历史保持原样。

## 测试

```
npm test              # node --test，跑 tests/ 下全部 *.test.js
node tests/units.test.js
node tests/host.test.js
node tests/inspect.test.js
```
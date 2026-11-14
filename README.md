# dsh-fold-plugin

按轮折叠 DSH 会话历史：每轮结束时把本轮的思考、工具输出与长回复折成一条检查点消息，原文可凭编号召回，重要消息永不折叠。

它不接管压缩引擎，只降低每轮历史进入上下文的速度。

## 行为

1. 轮结束（`agent/turn-stopping`）时，把本轮从第一条 `assistant/message` 到最后一个节点的区间整体替换成一条 `user/message` 检查点消息。
2. 不折：用户原话、`fold_pin` 重要消息、上一次的检查点本身；单轮内容少于 `minFoldChars` 也不折。
3. 检查点正文写清折叠了几步、几次工具调用、工具名、回复的开头与结尾，并给出 `fold_recall("f7")` 这类编号。
4. 模型可调 `fold_recall` 取回原文（会累计召回次数，超过 `recallReminderAfter` 时要求模型用 `fold_pin` 固化结论）。
5. `fold_pin` 追加一条 `【重要·永不折叠】` 消息，永不被折叠。
6. 系统提示词追加一段 `fold-compression`，说明机制与两个工具的用法。

## 安装

profile 的 `package.json` 里加 link 依赖并把包名加进 `dsh.profile.bundles`：

```json
"dependencies": { "dsh-fold-plugin": "link:E:/dsh-fold-plugin" },
"dsh": { "profile": { "bundles": ["...", "dsh-fold-plugin"] } }
```

重启 DSH 生效。包内 `cordis.patch.yml` 负责把插件插进插件表。

## 配置

`$DSH_HOME/fold-config.json`（缺字段用默认值，越界值自动钳制）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，关掉只留工具与提示词 |
| `minFoldChars` | `1200` | 思考+工具输出+回复的字符数低于此值不折 |
| `maxNoteChars` | `320` | 检查点消息长度上限 |
| `recallReminderAfter` | `3` | 同一段召回超过几次就提醒固化 |
| `maxRecallChars` | `24000` | 单次召回返回的字符上限 |
| `maxPinTextChars` | `4000` | 单条重要消息的正文上限 |
| `maxPins` | `12` | 重要消息条数上限 |
| `pinBudgetChars` | `12000` | 全部重要消息的字符预算 |

## 数据落在哪

- 会话日志：检查点与重要消息都是普通 `user/message`，`source.kind` 分别是 `fold-checkpoint`、`fold-pin`。恢复/分叉照原样重放，不依赖插件在线。
- `$DSH_HOME/fold-store/<会话>.jsonl`：折叠原文、召回次数、重要消息快照。召回靠它，删掉就只能看到检查点的摘要行。
- `$DSH_HOME/dsh-fold-plugin.log`：运行日志。

## 已知限制

- 召回文本按会话存在 `$DSH_HOME/fold-store/`：分叉出来的新会话读不到父会话的载荷，召回会返回「找不到」。
- 每次替换都会让请求前缀变化，billion-context 下一次请求会全量重发一次；这是折叠的固有成本。
- 只折叠插件在线期间观察到的轮次：插件装上之前的历史保持原样。

## 测试

```
node tests/units.test.js
node tests/host.test.js
```
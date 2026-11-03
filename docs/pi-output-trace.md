# Pi 原生模型输出过程

聊天正文继续显示 Markdown；每次模型请求增加可展开的 **Trace**。点击后查看 turn、模型返回的可见 thinking、工具参数、最近一次进度、最终结果、错误及 SDK 提供的耗时。工具支持同名并行及按 `parentToolCallId` 嵌套展示，均按调用编号关联。

## 官方依据

已阅读 [Pi 最新文档](https://pi.dev/docs/latest)，并核对本项目固定的 Pi 1.4.0 安装包文档、公开导出和类型：

- [How Pi works](https://pi.dev/docs/latest/how-pi-works)：Agent 循环与工具执行。
- [SDK](https://pi.dev/docs/latest/sdk)：订阅 `AgentSession` 事件。
- [JSON output](https://pi.dev/docs/latest/json)：内容块增量、完成快照及生命周期。
- [Message types](https://pi.dev/docs/latest/message-types)：text、thinking、toolCall、toolResult 与 usage。
- [Skills](https://pi.dev/docs/latest/skills)：渐进加载、原生 read 与 `/skill:name` 展开。

Pi 没有单独的 trace 对象或“skill 执行成功”事件。本功能是这些原生事件的桌面展示，不增加模型请求，不替换 SDK 的执行、资源发现或持久化。

## 事件与显示规则

| 原生内容 | 桌面行为 |
| --- | --- |
| `agent_start` / `agent_end` | 记录本次底层运行开始、结束；`willRetry` 时继续等待，不提前宣布请求结束 |
| `agent_settled` | 标记“已收尾”或“已停止”；表示没有后续自动处理，不代表业务成功 |
| `turn_start` / `turn_end` | 实时 turn 编号与状态；一个 turn 是一次助手响应及其产生的工具执行 |
| text / thinking 增量 | 按 `contentIndex` 关联，按帧合并页面更新；块结束值替换增量，`message_end.message` 替换整个响应 |
| thinking | 仅展示供应商实际返回的可见文本；没有则不补写。redacted 内容隐藏，签名不传页面 |
| toolCall 增量 | 区分参数生成和实际执行；完成参数替换 JSON 片段 |
| `tool_execution_start/update/end` | 按 `toolCallId` 更新参数、最近一次进度和最终结果；保留父调用关系及实际耗时 |
| retry / compaction | 单独记录生命周期，不混入模型正文；自动处理仍由 SDK 决定 |

部分工具的进度更新是累积快照，另一些是独立片段。本页面只展示最近一次进度，不擅自拼接未知工具的协议；最终结果覆盖进度。长工具参数和结果仅在页面预览截断为 12000 字符，Pi 历史与模型上下文不受影响。thinking 与工具内容使用 `textContent`，助手正文沿用现有 Markdown 清理与复制原文链路。

工具没有结束事件时显示“结果未确认”。发送结束却没有收到 `agent_settled` 时明确提示，不凭发送返回猜测成功。停止后仍接收工具结束和 settled 收尾。监听只发送到发起请求的页面，按请求会话过滤；官方扩展替换会话时保留原请求归属，结束/异常均解除订阅。旧草稿操作入口保持兼容。

## Skill 的证据边界

- **显式展开**：本次输入为 `/skill:name`，且实际 user 消息经 SDK 公开 `parseSkillBlock` 解析后，与当前 loader 的技能名和路径一致。只说明指令已展开，不说明技能任务成功。
- **读取技能文件**：原生 `read` 参数归一为绝对路径后，与当前 loader 登记的技能文件匹配。工具结果显示读取完成或失败，不把名字中含 `SKILL.md` 的普通文件误认为已加载技能。别名、`~` 或不同链接路径未匹配时保留普通 read，不猜测技能身份。
- **技能展开记录**：历史中由官方解析器识别的技能块。以记录展示，不重新执行技能或验证当前文件。只读历史预览不加载资源，因此自然语言触发的历史 read 可能仅显示为普通工具。

读取技能的参考文件、运行其脚本仍按真实工具展示。没有独立的技能成功、技能执行耗时或宿主关键词路由。

## 历史与验证

沿用 Pi 的消息历史，不另存一份 trace 日志。重新打开和只读预览恢复 thinking、toolCall、toolResult、模型、usage、stopReason、已记录耗时及 `nestedCalls` 摘要。历史标为“历史恢复 / 响应记录”，不虚构实时 turn 事件、重试顺序或缺失计时。嵌套摘要不含结果正文；`complete: false` 明确标记不完整。

自动检查（临时配置、工作目录和历史，不读取真实认证/会话，不请求付费模型）：

```sh
node --test tests/unit/output-events.test.js tests/unit/pi-output-runtime.test.js tests/unit/session-preview.test.js tests/unit/message-adapter.test.js tests/unit/agent-ipc.test.js tests/unit/chat-service.test.js tests/unit/window-close-preload.test.js tests/unit/session-info.test.js
node_modules/.bin/electron tests/ui/output-trace.check.cjs
```

上述 37 项单元/集成检查及完整页面检查通过。真实 SDK 检查只替换公开 Agent 的模型流函数，实际使用 Pi 1.4.0 会话、原生 read、技能展开与历史保存，覆盖两 turn 和订阅释放；另模拟会话替换以核对原请求归属和新订阅清理。页面检查覆盖增量终值覆盖、同名工具乱序结束、嵌套、自动重试、停止、缺失结束、历史恢复、重复发送、Markdown 复制、安全文本及 1120/680 宽度；脚本输出临时截图位置。既有 `context-usage-page.check.cjs` 的 19 项检查也通过，覆盖旧文本通道兼容、上下文用量、切换、停止、整理与窄窗。

扩大运行 `session-service.test.js` 时，“缺少模型配置必须报错”的旧断言失败；隔离的修改前提交 `bd3623b` 同样失败（实际先报缺少工作目录），不将它记录为本功能通过，也未改动该无关断言。本轮没有进行真实供应商推理验收。

手动验收：重启应用，在有工具需求的对话中展开 Trace；使用支持 thinking 的模型核对思考内容，发送 `/skill:qa-requirement-review` 核对显式展开，再用自然语言触发技能并观察 read 标记；检查停止和重开后的历史。模型不返回 thinking 或未读取技能时，页面应如实保持缺省。

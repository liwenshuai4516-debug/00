# 任务清单：todo_write 与任务栏

模型在多步工作中维护一份可见的任务列表：每次调用 `todo_write` 整表替换，页面在输入框上方显示当前清单和进度。清单只代表当前这次用户请求：每次新请求开始（`agent_start`）或切换会话时先清空，重新打开会话只恢复最后一段请求内的清单。清单不写入会话之外的存储。

![任务栏（离线演示数据）](images/todo-dock.png)

图中为离线渲染的演示数据，不是真实模型输出。

## 工具

`src/main/tools/todo-write.mjs` 通过公开的 `defineTool` 定义，随 `createAgentSession({ customTools })` 追加注册：

- 参数为 `{ todos: [{ content, status }] }`，`status` 只接受 `pending`、`in_progress`、`completed`。
- 每次提交完整列表，空数组表示清空。
- 内容为空或重复时返回明确错误，不写入清单。
- 成功结果是各状态计数文本，`details.todos` 保存去除首尾空白后的清单，供页面读取。
- `customTools` 只追加，不替换 Pi 原生工具；`tools`、`excludeTools` 与 `defaultTools` 的既有语义不变。

## 进度更新时机

任务栏只渲染模型实际提交的 `todo_write` 完整列表，不会根据工具调用、文件变化或时间自动把某一项标为完成。若模型只在开始时提交一次、全部结束后再提交一次，页面就只能看到“开始”和“全部完成”两个快照；这不是页面合并了中间状态。

工具提示词和测试 Agent 提示词要求：每完成一步或进入下一项前立即调用 `todo_write`，先完成当前项再推进下一项，不要等全部内容执行完才一次性提交。模型未调用时，页面不会伪造进度。

## 数据链路

| 环节 | 行为 |
| --- | --- |
| 主进程投影 | `output-event-adapter` 只从 `todo_write` 结果 `details.todos` 取 `content` 与 `status`，不把 `details` 或 `structuredContent` 整体送到页面；其他工具（含扩展）的同名字段被忽略 |
| 实时 | `agent_start` 清空上一轮清单；`todo_write` 的 `tool_execution_end` 携带 `todos`，页面收到后更新任务栏 |
| 历史 | 工具结果消息保存 `details`；重新打开会话时按最后一段用户消息切分，取该段最后一条有效清单 |
| 页面 | `createTodoDock` 渲染在输入框上方；切换会话先清空旧内容，再用历史重建；有清单才显示，默认折叠；进度按状态汇总，零计数不显示 |

任务栏与消息流共用同一次会话读取，不新增 IPC 通道，也不额外请求模型。清空、失败调用、其他工具的结果和没有 `todos` 的工具结果不改变当前清单。

## 交互

- 点击标题行展开或收起；展开状态按会话记忆，切走再回来保持原样，未展开过的会话默认折叠。
- 记忆只在页面内存中保留，关闭应用后恢复默认折叠。
- 每次新请求开始时上一轮清单先隐藏；本轮模型再次调用 `todo_write` 后重新出现，轮次结束不会自动清空。
- 历史恢复按用户消息切分；Pi 历史不区分 steering 插话，同一请求中的补充消息会被当成新一段，清单以补充消息之后的写入为准。
- 状态点区分待处理、进行中、已完成；面板列出任务顺序与进度，不提供就地编辑，修改仍由模型通过下一次 `todo_write` 完成。
- 清单较长时列表内部滚动，不挤占输入框。

## 验证

```sh
node --test tests/unit/todo-write.test.js tests/unit/todo-projection.test.js
node_modules/.bin/electron tests/ui/output-trace.check.cjs
```

- 单元检查覆盖计数、空列表、空内容/重复拒绝、参数 schema、历史按当前请求取最后一条与来源限制。
- 页面检查覆盖：非 `todo_write` 结果不更新；`agent_start` 清空；历史按用户消息切分；切换会话不保留上一会话清单；实时流程没有 `todo_write` 时任务栏隐藏；默认折叠与展开后的 `aria-expanded`；展开状态按会话记忆。

## 真实模型验收（2026-11-04）

下表针对调整前的跨轮清单行为。按当前请求清空、历史按用户消息切分和来源限制已通过下列离线检查；真实模型的轮次行为尚未复验，不能据下表宣称本轮语义已验收。

使用者明确授权使用已有模型与认证，仅临时隔离工作目录、会话与资源目录（临时 agent 目录只符号链接既有 `auth.json`、`models.json`，不复制凭据）。使用 `deepseek/deepseek-flash` 发送一次三步任务请求，不涉及用户历史或真实项目目录。

| 观察项 | 结果 |
| --- | --- |
| 工具注册 | `todo_write` 出现在模型可用工具中，无需 `tools` 白名单 |
| 调用次数 | 4 次，均为整表替换 |
| 状态推进 | `in_progress,pending,pending` → `completed,in_progress,pending` → `completed,completed,in_progress` → 全部 `completed` |
| 最终清单 | 读取 a.txt；在 b.txt 末尾追加一行“完成”；用 read 确认 b.txt 内容 |
| 实际文件 | b.txt 内容为“待办 / 完成”，与总结一致 |
| 历史投影 | 从记录的工具结果重建出同一清单，与实时投影一致 |
| 耗时 | 约 7.1 秒，包含 read/bash 工具往返 |

该次验收只覆盖一个请求与一种任务类型，不证明所有场景都会触发清单，也不代表供应商侧计费结果。


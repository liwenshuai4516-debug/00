# 通用设置：权限控制

## 为什么需要应用层门禁

Pi 官方没有类似 DSH 的沙箱 + 审批器。按 [Pi 扩展文档](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)，应用只能在官方 `tool_call` 事件里拦截模型发起的工具调用；项目信任只解决“项目内的扩展/技能/配置是否加载”，不控制运行时工具。

DSH 的模型是 `read-only`、`workspace-write`、`full-access`（以及实验 Auto）预设加 `approval` seam。本应用没有 Pi 侧沙箱，因此不伪装成 workspace-write；改为三个可解释的应用层模式：

| 模式 | 行为 |
| --- | --- |
| 每次确认（默认） | 读取/搜索/项目检查直接执行；写入、命令、登录、录制等工具每次弹窗确认 |
| 只读 | 阻止写入、命令、登录、录制等工具；读取、搜索和项目检查仍可用 |
| 完全权限 | 所有工具直接执行，不再确认；系统提示词同时声明用户已授权本任务的工具和写操作，模型不再按“未授权”只做只读；设置页显示高风险提示 |

## 实现

- `src/main/services/permission-service.js`：保存在 `app.getPath("userData")/permission-settings.json`，默认 `ask`，写入 `0600` 原子临时文件；损坏文件回到安全默认但不自动覆盖。
- `src/main/resources/permission-gate.mjs`：官方 `tool_call` 扩展。读取类工具（`read`、`read_workspace_*`、`list_workspace_directory`、`search_workspace_text`、`get_current_time`、`todo_write`、`qa_ui_project`、`web_search`、`web_fetch` 等）直接执行；带 `readOnlyHint` 的 MCP 工具也直接执行；`browser_snapshot`、`browser_verify_*`、`browser_network_*`、`generator_read_log` 等观察类录制工具按只读处理；其他工具按模式确认或阻止。确认使用 Pi 官方 `ctx.ui.confirm`，没有 UI 时失败关闭。
- 同一扩展在 `before_agent_start` 写入 `app-permission` 系统提示词段，按当前模式告诉模型：完全权限视为已授权本次任务，不要逐项询问或只做只读；每次确认直接调用工具、由应用弹窗确认；只读不要尝试写操作。模式保存后在下一轮提示词立即生效。
- `src/main/resources/pi-resources.mjs`：为每个会话登记 `desktop-permission-gate` 扩展。
- `src/main/ipc/agent-ipc.js`、`src/preload/preload.js`：`agent:read-permission-settings` / `agent:save-permission-settings`，保存走共用空闲互斥。
- `src/renderer/components/settings/permission-settings.js`：设置页「通用 → 权限控制」三选一，保存后立即对当前和新会话的工具调用生效。
- 设置页新增「通用」分类；模型、主题、归档、提示词、技能与扩展包分类保持不变。

## 边界

- 这是**工具调用门禁，不是操作系统沙箱**。工具、扩展和子进程仍使用应用进程的系统权限；`bash` 能做的事不会因为“只读”而变成文件系统只读。
- 只读模式会阻止所有未声明为只读的工具；未知工具按“可能写入”处理。
- 完全权限会跳过所有确认，包括命令和文件写入；只在明确信任当前任务时使用。系统提示词会把它声明为本次任务的授权，但不会绕过项目信任、操作系统权限或用户在提示词里明确排除的范围。
- 确认只对本次工具调用有效，不形成永久授权；权限模式本身是应用级设置，改变后当前会话的后续调用也立即使用新模式，系统提示词在下一轮更新。已有会话若未加载权限扩展，需要新开会话或重启客户端。
- `todo_write` 仅更新界面任务列表，不视为文件写入；`qa_ui_project` 只读取项目配置和目录，不返回凭据。

## 验证

```bash
node --test tests/unit/permission-service.test.js tests/unit/permission-gate.test.js
node_modules/.bin/electron tests/ui/permission-settings.check.cjs
node_modules/.bin/electron tests/ui/theme-settings.check.cjs
```

- 权限服务：3 项（默认值、持久化、未知/损坏输入）。
- 权限门禁：6 项（读工具直通、写工具确认、只读阻止、完全权限放行、MCP 观察/点击分类、无 UI/拒绝失败关闭、系统提示词按模式更新）。
- 权限设置页面：5 项（三种模式、只读保存、完全权限风险提示、忙碌禁用）。
- 主题设置 43 项复跑通过，确认新增「通用」分类没有破坏现有设置页导航。

![通用设置：权限控制](images/permission-settings.png)

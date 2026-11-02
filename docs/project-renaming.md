# 项目重命名

在普通对话视图的项目分组标题旁点击“重命名”，输入名称后保存；取消或 Escape 关闭表单。只有已登记项目提供入口，未登记的历史目录继续显示目录名。名称沿用存储层规则：去除首尾空白后为 1～40 个字符。

只修改项目登记名称，保留编号、目录、排序、历史会话、模型、聊天输入及文件草稿；目录暂时失效也可重命名。归档视图读取相同项目元信息。重命名不会打开项目或请求模型。

保存期间禁止重复提交，遵循现有操作互斥和关闭握手。失败保留填写内容；返回丢失先只读核对实际名称，读取也失败时提供“核对保存结果”，不自动重发。已确认保存后列表读取失败仍展示新名称，并提供项目列表重读入口。表单关闭后按项目编号找回焦点。

## 实现位置

- `src/main/services/project-service.js`：复用已有 `projectStore.rename()`。
- `src/main/ipc/agent-ipc.js`、`src/preload/preload.js`：固定 `agent:rename-project` 通道，仅转发编号与名称，共用 `runIdleOperation()`。
- `src/renderer/components/session-list.js`：项目分组独立操作按钮。
- `src/renderer/components/project-panel.js`：表单、保存、只读核对和列表更新。
- `src/renderer/renderer.js`、`index.html`、`styles/project-panel.css`：接线、原生对话框及主题样式。

## 验证

```bash
node --test tests/unit/project-rename.test.js tests/unit/project-rename-ipc.test.js \
  tests/unit/project-service.test.js tests/unit/project-open.test.js \
  tests/unit/project-store.test.js tests/unit/session-list.test.js tests/unit/agent-ipc.test.js

node_modules/.bin/electron tests/ui/project-rename.check.cjs
node_modules/.bin/electron tests/ui/sidebar-layout.check.cjs
node_modules/.bin/electron tests/ui/session-archive-page.check.cjs
node_modules/.bin/electron tests/ui/window-close-page.check.cjs
```

专项使用真实项目存储、服务、IPC、预加载和页面，聊天与模型为模拟；覆盖保存/取消、校验、失败重试、返回丢失、读取失败、空项目、存储重建/页面重载、输入与文件草稿保留、生成期间禁用、键盘/输入法事件保护、关闭等待保存和宽窄布局。仅操作临时配置及测试文件，阻止页面网络，不读取真实 `.env`、配置、会话或验收文件，不请求模型。

自动检查不等于使用者真实重启验收。可在已有项目中修改名称，确认聊天与输入保留，再重启应用核对名称，无须发送消息。

2026-11-02：仅包含最新提交与本次功能的副本通过 36 项单元测试，以及重命名 16 项、侧栏 35 项、归档 16 项、关闭 14 项页面检查；已查看 375 宽度表单截图。其他工作区改动保留，未纳入该提交的验证结论。

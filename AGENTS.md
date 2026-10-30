# 仓库指南

## 沟通与学习方式

- 后续交流和项目文档默认使用中文；标识符、命令及必要的技术术语保留原文。
- 项目由使用者亲手构建。提供开发建议时，给出可对照编写的完整代码、关键中文注释、修改位置和验证步骤；除非明确要求，否则不要代写应用代码。
- 实施前说明关键假设和取舍；需求存在无法合理判断的歧义时先澄清。每一步保持范围明确，避免添加未请求的功能。

## 项目结构与架构

- `src/main/main.js`：单实例锁与重复启动时的窗口恢复；先获取锁，再加载业务模块。
- `src/main/bootstrap.js`：配置加载、服务组装、IPC 注册与窗口创建。
- `src/main/lifecycle/`：窗口生命周期与聊天停止逻辑。
- `src/main/pi-agent.mjs`：Pi 会话创建、模型配置和工具定义。
- `src/main/services/`、`src/main/storage/`：会话、聊天、修改草稿的业务逻辑与持久化。
- `src/main/tools/`、`src/main/workspace/`：工作目录工具与路径、文件读取约束。
- `src/preload/preload.js`：向页面暴露有限的主进程接口。
- `src/renderer/`：页面结构及交互逻辑；`components/` 放交互组件，`styles/` 放样式，局部 `package.json` 将渲染进程的 `.js` 声明为 ES Module。
- `sessions/`：开发阶段保存在项目内的本地会话数据；`pi-check.mjs` 用于独立验证模型连接。
- `package.json` 和 `package-lock.json` 管理依赖与命令；不要手动编辑 `node_modules/`。

保持主进程、预加载脚本和渲染进程的职责分离。随着功能增加，按实际职责拆分模块，不为一次性逻辑引入额外抽象。目录或文件移动时同步调整入口、导入和资源路径，并验证已有会话仍可读取。

## 开发与验证

- `npm ci`：按锁文件安装依赖。
- `npm start`：启动 Electron 应用。
- `npm test`：使用 Node.js 内置测试工具运行 `tests/unit/*.test.js`。
- 单元测试文件使用 `*.test.js` 命名；测试会话逻辑时使用模拟创建函数，不依赖真实模型或本地会话数据。
- Pi 初始化集成检查使用临时目录创建真实 SDK 会话，但不请求模型；不要为验证而使用用户的会话或调用付费模型。
- 默认只运行本次修改涉及的测试文件，不例行运行全量 `npm test`。给出建议时可在临时副本验证候选代码，未经明确要求不要修改项目应用代码或补写测试。
- 当前尚未配置覆盖率目标或打包命令。

每次变更先明确可验证的目标，再执行与影响范围相称的检查。手动验证涉及的聊天、流式回复、停止生成、会话切换或工具调用流程；修复缺陷时先复现，再验证修复。引入自动化测试或构建工具后，在此记录实际命令和约定。

## Pi SDK 版本与升级约定

- 当前 Pi SDK 固定为 `1.4.0`，官方包已由 `@mariozechner/pi-coding-agent` 迁移到 `@earendil-works/pi-coding-agent`。`package.json` 使用 npm 别名 `"@mariozechner/pi-coding-agent": "npm:@earendil-works/pi-coding-agent@1.4.0"`，因此源码保留原导入路径；不要误认为仍运行旧版 SDK。
- Node.js 最低要求为 `22.19.0`；同时更新 `package.json` 与 `package-lock.json`，使用 `npm ci` 复现依赖。
- `src/main/pi-agent.mjs` 和 `pi-check.mjs` 使用 `await ModelRuntime.create()`、`getModel()`，通过 `createAgentSession({ modelRuntime, ... })` 创建会话。旧的 `AuthStorage` 和 `authStorage` / `modelRegistry` 会话选项已移除，不再沿用旧教程中的初始化代码。
- Pi 1.4 的 `SessionManager.list(cwd, sessionDir)` 会按工作目录筛选。侧栏与只读历史预览使用 `SessionManager.listAll(sessionDir)` 保留全部历史；自动恢复仍按当前工作目录与应用绑定校验，不认领其他目录的会话。
- 升级验证覆盖真实 SDK 初始化、自定义供应商地址、工具权限、会话信息、历史预览、工作目录恢复和文件工具，不请求真实模型。2026-10-30 在已提交代码加本次升级的临时副本中运行 13 个相关测试文件，72 项全部通过；这不代表工作区其他未提交功能已验证。工作区验证时曾因既有 `session-service.js` 未导出 `getSessionInfo` / `previewSession` 而失败，后续继续开发时须核对实际导出。
- Electron `45.1.0` 内置 Node `24.22.1` 的独立会话初始化检查也通过，使用临时配置与会话目录，未请求模型；尚未进行真实模型聊天和完整界面手动验证。

## 工程化与代码风格

以可维护、可运行的 Agent 客户端为目标，小步演进，每一步保持现有功能可验证。优先沿用现有依赖和风格，避免无关重构、推测性功能和配置。功能增长时再按职责组织会话管理、工具、配置和测试；工具能力及其权限应明确，工具调用和错误应可观察。

JavaScript 使用两空格缩进、双引号、分号及描述性的驼峰命名；主进程使用 CommonJS，Pi 模块使用 ES Module。HTML 使用两空格缩进；编辑现有代码时保持相邻风格。关键代码使用简洁的中文注释，解释不直观的意图。当前没有配置格式化或 lint 工具。

## 前端页面与交互约束

- 前端设计与实现可以使用 Element Plus 组件库，组件样式与交互需遵循下述页面约定。
- 后续前端页面设计以 Codex 桌面客户端的样式、布局和交互组织为参考：会话侧栏、主聊天区、底部输入区，以及按需展开的工具和草稿审阅区。具体视觉细节以用户提供的参考图和明确要求为准。
- 使用克制的中性色、轻量边框、清晰的文字层级和统一间距；用 CSS 变量集中管理颜色、尺寸和圆角。样式放在 `src/renderer/styles/`，独立交互组件放在 `src/renderer/components/`。
- 输入区保持在主聊天区底部，消息区独立滚动；流式回复跟随最新内容，用户上翻时保留阅读位置，并提供返回最新消息的入口。
- 窄窗口允许侧栏和审阅区折叠或调整排布，保证聊天与输入操作可用。按钮具有明确状态，保留键盘操作、可见焦点、输入法保护及纯文本安全展示。
- 按可运行的小步骤调整界面；每步给出准确修改位置、完整代码和中文注释，并验证涉及的发送、停止、会话切换和草稿操作。
- 输入草稿按会话隔离，仅保留在当前页面内存中；不要将其描述为重启后可恢复。工具开始和结束事件按 `toolCallId` 关联，避免同名工具交错时串联结果。
- 修改草稿的保存、放弃和会话切换共用主进程互斥入口；放弃草稿只移除待保存记录，不修改工作文件。

## 应用名称与图标

- 页面窗口标题在 `src/renderer/index.html` 的 `<title>` 中，侧栏和聊天区标题也在该文件中；它们与 macOS Dock 名称分别配置。
- 当前尚未实现自定义应用名称和图标。开发阶段如需设置应用内部名称，在主进程入口使用 `app.setName()`；macOS Dock 图标可在 `bootstrap.js` 的 `app.whenReady()` 中使用 `app.dock.setIcon()` 设置。
- `npm start` 运行的是 Electron 开发应用，设置内部名称不保证改变 Dock 悬浮名称。正式应用名称和 macOS `.icns` 图标需要在引入打包工具后配置，不要直接修改 `node_modules/` 内的 Electron 应用包。

## 配置与安全

密钥放在本地 `.env`，不要写入源码或对话；会话文件可能包含私密内容。不要提交 `.env`、`sessions/` 或 `node_modules/`，初始化 Git 前应配置 `.gitignore`。保留上下文隔离及受限预加载接口，不向页面暴露完整 Electron 或 Node.js 能力。修改供应商地址时注意密钥会发往该地址。

当前项目内的会话目录和 `.env` 是开发阶段方案。实现打包或发布时，应重新检查安装目录的可写性、数据迁移及密钥存储，不能假定打包后的应用目录可写。

## 提交与合并请求

提交信息应简洁地概述变更。合并请求应说明目的、验证结果和相关问题；界面变更附截图。不要提交密钥、会话数据或其他本地生成文件。

远端 `origin` 使用 `git@github.com:liwenshuai4516-debug/00.git`，通过本机已有的 SSH 授权推送。后续每次完成并验证代码或项目文件更新后，自动将本次相关变更提交并推送到 `origin` 的当前分支，无需再次询问是否提交或推送。提交前检查变更及忽略规则，保留并避免混入无关的用户改动；不得强制推送。仅给出建议、未修改文件时不创建提交。若验证、提交或推送失败，应说明原因和未完成的步骤，不得掩盖失败。

## 开发进度与跨窗口交接（2026-10-30）

新窗口先阅读本节，再检查实际源码与 Git 状态；区分已经实现、已经验证和仅给出建议的内容。继续采用使用者亲手编写代码的方式，每步提供准确的文件路径、定位片段、替换边界、完整代码、关键中文注释和针对性验证命令。

### 当前阶段

- 使用 Electron、原生 DOM/ES Module 渲染层和 Pi Agent SDK；当前 SDK 为 `@earendil-works/pi-coding-agent` `1.4.0`，通过上述 npm 别名保留原导入路径。允许使用 Element Plus 不代表已经引入 Vue 或需要迁移现有前端。
- 已有聊天、流式回复、停止、历史会话、工具展示、已有文件修改草稿的审阅/保存/放弃和持久化。工作区中还有手动上下文整理、对话导出等手写改动，不能当作已经全部验证或提交。
- 当前正在补齐“新建文件草稿”链路，尚未向模型开放完整的新建文件能力。
- `src/main/workspace/resolve-new-file-path.mjs` 已实现新文件路径检查：父目录必须存在，拒绝覆盖、隐藏/排除路径、目录外路径和已有符号链接；解析本身不写文件。
- `src/main/tools/propose-create.mjs` 已实现 `propose_workspace_create`，返回 `create-proposal`，正文存于 `content`，允许空文件，限制为 UTF-8 32 KiB，拒绝空字节；工具只生成草稿。
- `src/main/services/proposal-store.js` 已支持新建与修改草稿共同登记、按会话隔离、恢复和放弃。误输入的 `ƒ;` 已删除。
- `src/main/services/proposal-review-service.js` 已加入新建草稿分支：审阅时重新检查目标路径，返回草稿，不创建文件。

### 最近验证与缺口

本次交接在实际工作区执行以下相关测试，30 项通过：

```bash
node --test \
  tests/unit/new-file-path.test.js \
  tests/unit/propose-create.test.js \
  tests/unit/proposal-store.test.js \
  tests/unit/proposal-persistence.test.js \
  tests/unit/proposal-discard.test.js
```

现有 `tests/unit/proposal-review-service.test.js` 的 4 项修改草稿审阅测试也通过。**交接时 `tests/unit/proposal-create-review.test.js` 为零行空文件**，不能因为测试命令成功就认为新增审阅用例已经通过；此前教程中的 10 项结果来自临时副本。

### 下一步顺序

1. 先指导使用者补齐 `tests/unit/proposal-create-review.test.js`：验证中文与空内容不写文件、目标被文件/目录/失效链接占用、隐藏与目录外路径、父目录链接改指目录外、已保存/保存未确认/未知类型。与已有审阅测试一起运行，完整教程预期共 10 项。
2. 接入保存前明确整理重复定义：`proposal-apply-service.js` 第一个 `apply()` 之后混入了另一份旧的 `applyDefaultEdit`、`createProposalApplyService` 和导出；`session-service.js` 中 `recordWorkspaceEdit()` 连续定义两次。先核对实际代码再给准确删除范围，保留现有持久化状态和失败警告语义，不盲目整文件覆盖。
3. 实现新文件保存模块，再接入保存服务。保存前必须复核路径，最终创建/发布必须拒绝覆盖已存在目标，不能照搬修改文件时可覆盖目标的 `rename`。沿用保存前登记进行中状态、保存失败恢复状态、文件已保存后的附加错误返回警告等语义，并验证失败和竞争情况。
4. 扩展会话保存事实记录，明确记录“新建”及实际内容，不能误记成 `oldText/newText` 替换；同步检查历史消息适配和相关测试。
5. 保存链路验证后，再统一接入 `tools/index.mjs`、`pi-agent.mjs` 的工具结果提取、`chat-service.js` 的草稿登记、系统提示词和 `renderer/components/proposal-panel.js` 的新建内容审阅。当前这些入口仍主要识别 `propose_workspace_edit` / `edit-proposal`，页面仍按原文与新文片段展示。

### 本次提交范围

本次交接只更新并提交 `AGENTS.md`。工作区内既有的应用代码、测试及 `agent-save-example.txt` 等未提交文件保留原状，不执行 `git add .`；新窗口必须检查本地改动，不要误认为文档推送也包含全部源码。不要读取或提交 `.env`、真实会话和其他私密内容。

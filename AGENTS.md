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
- Electron `45.1.0` 内置 Node `24.22.1` 的独立会话初始化检查也通过，使用临时配置与会话目录，未请求模型。后续真实聊天与新建文件草稿的用户手动验收见交接记录，不代表其他未提交功能已验收。

## 工程化与代码风格

以可维护、可运行的 Agent 客户端为目标，小步演进，每一步保持现有功能可验证。优先沿用现有依赖和风格，避免无关重构、推测性功能和配置。功能增长时再按职责组织会话管理、工具、配置和测试；工具能力及其权限应明确，工具调用和错误应可观察。

JavaScript 使用两空格缩进、双引号、分号及描述性的驼峰命名；主进程使用 CommonJS，Pi 模块使用 ES Module。HTML 使用两空格缩进；编辑现有代码时保持相邻风格。关键代码使用简洁的中文注释，解释不直观的意图。当前没有配置格式化或 lint 工具。

## 前端页面与交互约束

- 前端设计与实现可以使用 Element Plus 组件库，组件样式与交互需遵循下述页面约定。
- 后续前端页面设计以 Codex 桌面客户端的样式、布局和交互组织为参考：会话侧栏、主聊天区、底部输入区，以及按需展开的工具和草稿审阅区。具体视觉细节以用户提供的参考图和明确要求为准。
- 后续所有涉及界面的建议、功能入口和样式调整，均以 2026-11-01 确定的新深色 UI 为迭代基线：`src/renderer/index.html`、`src/renderer/styles/codex-theme.css` 和 `src/renderer/components/page-shell.js`。先核对这些文件及现有业务组件的实际内容，再给准确修改位置和完整代码；沿用深灰侧栏、居中消息区、底部圆角输入框及右下方模型选择布局，不再基于旧版浅色页面给出替换方案。
- 继续由使用者亲手修改应用代码；除非明确要求，只提供可对照编写的代码和验证步骤。页面改造限定在渲染层并复用现有 `window.agent` 接口，不顺带修改后端业务、IPC 或预加载逻辑。
- 使用克制的中性色、轻量边框、清晰的文字层级和统一间距；用 CSS 变量集中管理颜色、尺寸和圆角。样式放在 `src/renderer/styles/`，独立交互组件放在 `src/renderer/components/`。
- 输入区保持在主聊天区底部，消息区独立滚动；流式回复跟随最新内容，用户上翻时保留阅读位置，并提供返回最新消息的入口。
- 窄窗口允许侧栏和审阅区折叠或调整排布，保证聊天与输入操作可用。按钮具有明确状态，保留键盘操作、可见焦点、输入法保护及纯文本安全展示。
- 按可运行的小步骤调整界面；每步给出准确修改位置、完整代码和中文注释，并验证涉及的发送、停止、会话切换和草稿操作。
- 输入草稿按会话隔离；页面现已接入自动保存、版本发送及未确认发送的二次确认解除，验证边界见下方交接。空会话重建及正常关闭补保存尚未完成，不称为完整重启恢复。工具开始和结束事件按 `toolCallId` 关联，避免同名工具交错时串联结果。
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

## 开发进度与跨窗口交接（2026-11-01）

新窗口先阅读本节，再检查实际源码与 Git 状态；区分已经实现、已经验证和仅给出建议的内容。继续采用使用者亲手编写代码的方式，每步提供准确的文件路径、定位片段、替换边界、完整代码、关键中文注释和针对性验证命令。

### 当前阶段

- 使用 Electron、原生 DOM/ES Module 渲染层和 Pi Agent SDK；当前 SDK 为 `@earendil-works/pi-coding-agent` `1.4.0`，通过 npm 别名保留原导入路径。允许使用 Element Plus 不代表已经引入 Vue 或需要迁移现有前端。
- 新建文件草稿的工具、登记、审阅、保存、事实记录、历史展示和前端审阅现已接通。此前文档中的“未注册工具”“审阅测试为空”“保存服务重复定义”等待办已经过时，不要重复实施。
- `resolve-new-file-path.mjs` 检查父目录、目标占用、隐藏/排除路径及工作目录边界；`propose_workspace_create` 只生成 `create-proposal`，完整正文保存在 `content`，允许空文件，限制 UTF-8 32 KiB，拒绝空字节。
- `apply-workspace-create.mjs` 在已有父目录内写临时文件并同步，使用 `link` 发布目标，拒绝覆盖；保存前复核路径，清理失败但文件已保存时返回警告。
- 保存链路保留进行中状态、失败恢复状态与附加警告语义；新建事实使用 `workspace-create-applied` 和实际内容，修改事实继续使用 `workspace-edit-applied`。
- `tools/index.mjs` 注册新建工具，系统提示词区分新建与修改及草稿与保存；Pi 事件按工具名称和草稿类型成对提取，聊天服务登记两种草稿并保留 `toolCallId`。
- 前端新建草稿展示完整内容，空字符串显示“（空文件，0 字节）”，空格与换行原样保留；使用 `textContent` 展示，两种草稿共用保存和放弃入口。审阅区标题为“文件草稿”。
- 上下文整理与对话导出的服务、IPC、预加载接口和页面按钮已接通，已完成代码核对、自动测试及使用者手动验收，提交为 `a59a137`。
- 发送失败恢复输入曾在 `bc6178d` 提交并单独验证；当时输入仅保存在页面内存。当前已升级为按会话自动保存、版本消费和异常只读核对：仅明确未消费且没有后来编辑时恢复原文；结果未确认时单独保留快照，不自动回填或重发，正常回复和主动停止不恢复旧输入。
- 使用者已完成未确认发送解除的页面二次确认、组件同步与8项专项测试。实际两个脚本语法检查和7个相关测试文件61项全部通过；实际页面及精确提交副本各通过23项Electron模拟检查。此前的“前端尚未编写”记录已过时，详情见本节最新核对记录。

### 未完项清单与优先级（2026-11-01 最新核对）

以下按建议实施顺序排列；以本清单及最新核对记录为准，不把后文历史步骤中的“尚未接入”当作当前待办。

| 顺序 | 未完项 | 当前基础与完成标准 |
| --- | --- | --- |
| 1 | 未发送空会话的登记、找回与重建 | 输入存储和页面已接通，但SDK空会话没有历史文件。仍需持久化原编号、真实目录、来源和模型，提供同目录“未发送”入口；有真实历史优先走原恢复链路，历史丢失不能冒充空会话。验证重启找回、目录/模型失效时保留输入、不串会话。 |
| 2 | 正常关闭前补保存 | 当前pagehide只释放组件，窗口closed只停止生成，尚无关闭握手。需要关闭前等待待写输入、失败保留窗口并可重试，兼容生成与退出；强制结束只保证已确认落盘内容。1、2完成前不称完整重启恢复。 |
| 3 | 会话置顶与可撤销归档 | 存储已有pinnedAt/archivedAt字段，业务接口和页面尚未接通。补置顶排序、归档视图、撤销/恢复、当前会话归档的安全切换；同步过滤启动及项目恢复，不删除或移动原历史，不丢输入和文件草稿，不改变最近消息活动规则。 |
| 4 | 上下文用量常驻入口 | 已有getSessionInfo().contextUsage及菜单内信息展示。复用同一次读取，补输入区常驻按钮、详情与整理入口、统一刷新和会话/模型迟到响应保护；未知不显示零，不新增模型请求。 |
| 5 | 项目重命名的服务、IPC、预加载和页面 | 存储rename及4项专项测试已完成，相关23项曾通过；其余链路暂缓。只改展示名称，保留编号、目录、会话及输入。 |

- **待核验的其他工作区改动**：model-settings相关服务、存储、页面、样式和测试，以及其他视觉/排版/业务差异仍未纳入本轮验收或提交。不能仅凭存在文件就标记完成，也不要撤销或混入当前功能提交。
- **真实验收边界**：使用者反馈已完成本轮步骤，未逐项说明真实界面结果。助手的61项测试和23项页面模拟不请求模型、不读真实配置/会话，不能当作真实重启与系统窗口验收；功能收尾时记录用户反馈，勿为制造异常而要求破坏配置或发起付费失败请求。
- **已完成且不重复实施**：模型选择和会话模型记忆、工作目录选择、Markdown与高亮、项目添加/打开、文件草稿行级差异与真实行号、输入自动保存/版本发送/消费核对、未确认原文展示与显式解除。具体历史验证边界保留在下文。

### 验证记录与边界

以下按开发过程保留阶段记录；其中“页面尚未接入”“下一步”等描述只代表当时状态，当前待办以以上清单和最后的实际核对为准。

- 此前后端提交 `7078e4b` 与 `e5feb64` 已覆盖新建路径、保存及草稿链路；后端提交副本曾运行 15 个相关测试文件，81 项通过。
- 本轮在仅包含已提交代码与本次新建工具注册、提示词和前端改动的临时副本中运行下列测试，28 项全部通过。副本不包含工作区其他未提交功能，也不读取本地 `.env` 或真实会话，不请求模型。

```bash
node --test \
  tests/unit/propose-create.test.js \
  tests/unit/tool-events.test.js \
  tests/unit/read-lines.test.js \
  tests/unit/proposal-create-apply.test.js
```

- 使用者反馈已完成真实界面手动验收：中文文件生成草稿后确认保存、重启查看保存记录、空文件保存、放弃草稿后重启不恢复，以及审阅后目标被外部占用时保存失败且不覆盖外部内容。这是使用者反馈，助手没有读取真实会话或验收文件。
- `deepseek/deepseek-v4-flash` 初始化报错已定位为 Pi 本地目录未登记旧别名；SDK 1.4.0 内置 ID 为 `deepseek-flash`。已指导使用者修改本地 `PI_MODEL` 并彻底重启，之后使用者继续完成验收；不读取或提交 `.env`。
- 上下文整理、对话导出在实际工作区的 5 个相关测试文件中曾有 27 项通过。收尾时在仅包含已提交代码与本次整理、导出改动的临时副本中运行下列 7 个文件，40 项通过；测试使用模拟会话和临时文件，不读取真实会话或请求模型。

```bash
node --test \
  tests/unit/context-compaction.test.js \
  tests/unit/conversation-export.test.js \
  tests/unit/message-adapter.test.js \
  tests/unit/session-preview.test.js \
  tests/unit/session-service.test.js \
  tests/unit/agent-ipc.test.js \
  tests/unit/window-lifecycle.test.js
```

- 已核对 SDK 的 `compact()` 在异步准备后建立取消控制器并发送 `compaction_start`，现有服务订阅事件以补发准备期间的取消。导出保存的是当前上下文展示文本，可能包含摘要和截断工具结果，不能称为完整原始历史备份。
- 使用者反馈已完成上下文整理和导出的界面验收：整理与导出前后保留输入和未保存文件草稿，导出取消与成功、整理后摘要导出，以及取消整理后的操作恢复。助手未读取真实会话或用户导出文件；自动测试不替代这项使用者反馈。

- 输入恢复的 `node --test tests/unit/composer-drafts.test.js` 共 5 项通过。另在临时副本运行实际 Electron 渲染页面，通过 9 项模拟接口检查：失败恢复原文、失败保留新输入、失败保留空白、成功不恢复、成功保留新输入、成功后列表失败、停止不恢复、停止后列表失败、部分回复后失败恢复。同时检查按钮恢复与三类事件监听清理；测试未读取真实会话或请求模型。此项是模拟界面验证，尚未记录使用者真实请求失败时的手动验收。

- 使用者已恢复 `tests/unit/chat-service.test.js` 与 `tests/unit/proposal-store.test.js` 中被删除的两段原有测试。已核对两文件与 HEAD 一致，在实际工作区运行这两个文件，10 项通过；这项收尾已经完成，不要再次要求恢复。
- 使用者已选择开发“界面查看和切换模型”，并已亲手完成模型列表服务、只读 IPC 与预加载接口：`listModels()` 返回 `{ provider, modelId, models: [{ id, name }] }`，通道为 `agent:list-models`，页面通过 `window.agent.listModels()` 读取。实际工作区的 `model-list.test.js`、`session-info.test.js` 与 `agent-ipc.test.js` 共 15 项通过。页面选择器现已接入；模型切换服务、恢复与页面验证进度见下文。
- 模型目录使用 Pi 1.4 的 `session.modelRuntime.getModels(provider)`，复用当前会话，不额外创建运行时。目录登记不等于账号有权限调用；不把完整 SDK 模型对象、凭据或供应商地址返回页面。只读列表不接受页面指定供应商或会话，生成期间允许读取；已验证预加载接口只调用固定通道且不转发额外参数。验证不请求模型。

- 使用者已明确要求“每个会话记住自己的模型选择”。不能按只在当前打开期间有效来实现。此前 `createPiAgent()` 总是向 `createAgentSession()` 显式传入 `.env` 模型，覆盖了 SDK 的历史选择恢复；仅调用 `setModel()` 不足以满足重新打开或重启后的恢复需求，现已修正，见下文。
- 使用者已亲手完成 `switchModel(modelId)`、受 `runIdleOperation` 保护的 `agent:switch-model` IPC、预加载接口及 6 项切换测试。实际工作区的切换、列表、会话信息与 IPC 共 21 项测试通过。切换限定当前供应商，使用 `{ persist: false }`，不改写全局默认，SDK 仍追加会话模型选择记录。
- SDK 切换失败可能发生在部分状态已更新之后，不得假设错误总表示已回滚；后续页面错误处理须重新读取实际模型。
- 模型恢复缺口曾在临时真实 SDK 会话复现：切换到 Pro 后重新打开仍返回默认 Flash。使用者现已亲手修改实际 `pi-agent.mjs`：从 `sessionManager.getBranch()` 的最后一个 `model_change` 读取选择，无明确记录时兼容 `buildSessionContext().model`，无历史选择时使用 `.env` 默认；当前供应商不匹配或模型未登记时明确报错，并保留 `createAgentSession({ model, ... })` 显式传值。
- 2026-11-01 已核对实际源码及使用者新建的 `model-restore.test.js`，运行该文件加 `pi-agent-init.test.js`、`model-switch.test.js`、`model-list.test.js`、`session-info.test.js` 和 `agent-ipc.test.js`，24 项全部通过，覆盖显式打开、自动恢复、新会话默认、分支选择和拒绝无效记录后原文件不变。独立进程使用临时配置与会话、占位凭据并禁用网络，不请求模型。SDK 尚未发送消息的空会话不会落盘，不能宣称空会话只切换模型后重启也能恢复。
- 使用者已亲手接入页面选择器：新建 `components/model-selector.js` 和 `styles/model-selector.css`，在 `index.html` 添加原生选择框，在 `renderer.js` 接入初始化、打开历史、新建后的刷新及统一忙碌状态。选择后立即切换；成功或失败后重新读取实际选择并刷新会话信息，读取失败提供重试。编写时曾在发送处理已有的 `finally` 内重复插入 `} finally {`，使用者已删除，两个渲染脚本的语法检查均通过。
- 2026-11-01 使用实际工作区渲染页面的临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-model-selector-actual-eihurx4b` 通过 10 项 Electron 模拟检查：初始化与纯文本展示、成功、更新前失败、更新后失败、相同选择、历史切换与输入恢复、新会话、目录失败重试、生成期间禁用、三档窗口布局。测试只使用模拟接口，未读取真实会话或请求模型，不代表真实界面验收。
- 页面选择器已在 `224fdf7` 提交并推送。使用者随后反馈已完成真实界面验收：已有消息的两个会话各自记住模型、切换保留输入与文件草稿、彻底重启后恢复模型、新会话使用默认模型、生成及停止后的控件状态。此项是使用者反馈，助手未读取真实会话；模型选择功能本轮已收尾，不重复要求验收。
- 使用者已明确选择下一项“界面选择工作目录”。已说明设计假设：重启记住所选目录，切换目录时新建对话，旧会话保留原工作目录绑定。当前 Pi 会话、草稿审阅和保存分别读取启动目录，后续必须统一，不能只改变 `process.env` 或只切换 Pi 的目录。
- 使用者已亲手新建 `src/main/storage/workspace-settings.js` 和 `tests/unit/workspace-settings.test.js`，已核对实际代码并运行 5 项测试，全部通过。模块暴露 `createWorkspaceSettings(settingsPath, defaultWorkspaceDir)`，提供 `load()` / `save(workspaceDir)`；只有配置不存在才回退默认，校验绝对路径及真实文件夹，通过同目录临时文件加 `rename` 保存 `{ workspaceDir }`。覆盖默认回退不落盘、符号链接规范化与恢复、无效路径不改配置、损坏或失效配置拒绝回退、发布失败清理临时文件。测试只操作临时目录，不读取本地配置或会话、不请求模型。模块尚未接入启动及会话链路，不代表页面已经可以选择目录。
- 使用者已亲手为 `createPiAgent()` 增加第四个参数 `workspaceDir = process.env.AGENT_WORKSPACE_DIR`，将它交给 `createWorkspaceSession()`，旧调用仍兼容。新建的 `pi-workspace.test.js` 曾为空文件，现已补齐并核对。实际工作区运行该测试加初始化、模型恢复和目录配置共 9 项，全部通过。新测试使用独立进程、临时目录、占位凭据并禁用网络，核对显式目录、符号链接真实路径、会话绑定、真实读取工具的目录及无效显式路径拒绝回退；不读取真实会话或请求模型。
- 使用者已亲手完成会话服务目录来源改动：为 `createSessionService()` 增加第三个参数 `readWorkspaceDir`，默认读取启动配置；新增内部 `createSession()` 先读取目录，再传给 Pi 的第四个参数。初始化、新建、打开历史三个入口统一调用该函数，保持初始化 Promise 共享与失败重试、准备成功后才替换原会话的行为。已核对实际代码及 `session-workspace.test.js`，在实际工作区运行会话目录、会话服务、会话信息、Pi 初始化、Pi 目录、模型恢复及目录配置 7 个文件，27 项全部通过。此步尚未修改启动、审阅、保存或页面，不代表持久化目录已经接通应用。
- 使用者已亲手完成启动与文件服务接线：`bootstrap.js` 创建 `userData/workspace.json` 配置，将 `workspaceSettings.load` 交给会话服务，审阅与保存传入读取实际会话 `sessionManager.getCwd()` 的函数。两项服务保留固定目录调用方式，每次操作解析目录函数；保存先读取目录再登记进行中状态。`proposal-workspace.test.js` 的文件名拼写和保存服务的重复赋值已修正并核对，实际工作区运行该文件及审阅、保存、新建审阅、新建保存、草稿持久化、会话目录、目录配置共 8 个文件，41 项全部通过，三个改动脚本语法检查通过。另在模拟 Electron 与临时配置中验证实际启动代码，确认保存目录优先及文件操作跟随实际会话目录。未读取真实配置或会话、未请求模型；尚无页面选择目录入口。
- 使用者已亲手完成目录切换服务：`createSessionService()` 增加第四个参数 `saveWorkspaceDir`，`bootstrap.js` 注入 `workspaceSettings.save`，新增 `switchWorkspace(workspaceDir)`。先用指定目录创建新会话，保存 Pi 实际绑定的真实目录后才替换并释放旧会话；保存失败释放新会话并保留旧会话。初始化失败或尚未初始化时可绕过失效的旧目录配置恢复；重复选择同一目录也新建对话。编写时多出独立的 `ï;`，曾导致创建服务时报 `ReferenceError`，现已删除并核对。实际工作区运行 `workspace-switch.test.js`、会话目录、会话服务、会话信息、模型切换、目录配置和文件服务目录共 7 个文件，39 项全部通过，两个改动脚本语法检查通过。尚未接入系统选择窗口、IPC 或页面。
- 使用者已亲手完成系统文件夹选择及接口：新增 `workspace-selection-service.js`，调用注入的选择窗口，只将系统返回的目录交给 `switchWorkspace()`；取消不切换，不依赖先加载旧会话。`bootstrap.js` 组装绑定发起窗口的 `showOpenDialog()`，窗口已关闭或选择期间关闭时按取消处理；`agent:select-workspace` 从打开窗口到切换结束共用 `runIdleOperation()`；预加载提供无参数 `selectWorkspace()`，不转发页面路径。已核对实际源码和 `workspace-selection.test.js`，实际工作区运行该测试加目录切换、IPC、模型切换和导出共 5 个文件，29 项全部通过，4 个改动脚本语法检查通过。另在临时副本中使用实际启动与预加载代码，模拟验证服务注入、父窗口绑定、关闭取消和固定通道不转发路径，未读取真实配置或会话、不启动真实业务、不请求模型。尚未接入实际页面入口。
- 使用者已亲手完成工作目录页面接线：`index.html` 右上角菜单新增“选择工作目录并新建对话…”按钮，`renderer.js` 将按钮加入全页面忙碌状态并调用无参数 `selectWorkspace()`。取消和切换失败保留原消息、输入、模型和文件草稿；成功后先绑定新会话编号、清空旧展示与选中项，再刷新会话信息、默认模型和列表。切换后的刷新失败明确提示已经切换，不恢复旧输入。已核对实际代码，语法检查通过；实际渲染层临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-workspace-page-actual-78i_vpj0` 通过 10 项 Electron 模拟检查，覆盖取消/失败/成功、防重复、输入等待期间编辑、原目录与原对话的输入和草稿恢复、目录名纯文本展示、生成和保存期间禁用、旧目录失效后选择恢复及三档窗口无横向溢出和焦点可达。测试仅使用模拟接口，未读取真实会话、调用模型或保存工作文件。使用者反馈完成上轮步骤，未另外描述真实验收细节；助手的模拟检查不替代真实系统选择窗口与重启验证。
- 使用者已明确选择“回复支持 Markdown 与代码高亮”，现已亲手完成第一步：固定安装 `marked@18.0.11`、`dompurify@3.4.17`、`@highlightjs/cdn-assets@11.12.0`，并新建 `components/markdown-renderer.js`。已核对实际源码、`package.json` 和锁文件，Pi 1.4.0 别名保持不变；版本列表、语法检查和 Node 模块导入均通过。渲染器从本地依赖加载，原始 HTML 转义，链接显示文字及地址，图片显示说明；Marked 解析后由 DOMPurify 白名单清理，仅对声明且支持的代码语言高亮，未知语言保留原文。使用实际模块和实际本地依赖在临时 Electron 页面通过 10 项检查，覆盖正文格式、六种代码语言、代码原文、未知或未指定语言、HTML/事件属性/危险链接/图片样例、未闭合围栏及空文本和重复替换。未读取真实会话或请求模型。依赖与模块已在 `5ec1649` 提交并推送，后续实际消息接入见下条。
- 使用者已亲手完成实际消息接入：`message-view.js` 用 WeakMap 保存 Agent 原文，新增 `updateAssistantMessage()` 渲染并在异常时回退纯文本，复制始终取最新原文；其他角色继续纯文本。`renderer.js` 按动画帧合并流式更新，工具前后回复节点分别保留，finally 取消待执行帧并补齐末段。`index.html` 引用本地 GitHub Dark 高亮主题和新增 `styles/markdown.css`，代码块与宽表格内部滚动并可键盘聚焦；`pre > code { overflow: visible; }` 避免双层滚动。
- 已核对实际源码，两个渲染脚本语法检查通过。实际渲染层临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-markdown-ui-actual-njvps_x4` 通过 13 项 Electron 模拟检查，覆盖历史与切换、流式原文复制、交错工具、停止与失败的部分回复、成功后的列表失败、未执行动画帧也补齐末段、复制失败恢复、上翻位置、监听清理及三档窗口的代码块与宽表格布局。只使用模拟接口、测试字符串和临时页面，不请求模型、不读取真实会话、不写真实剪贴板。使用者反馈“做完了”，未逐项描述真实聊天验收；不能把模拟检查称为真实模型请求验收。实际文件有两条粘贴残留注释（重复文字及“所有内容均作为纯文本展示”），不影响功能，可后续由使用者修正文案。


- 使用者已亲手完成项目分组所需的列表元信息：`listSessions()` 在原 `{ id, title }` 上增加 `workspaceDir: session.cwd` 和 `updatedAt: session.modified.getTime()`。目录只用于展示归组，不绕过打开会话时的绑定检查；缺少目录的旧记录保留空字符串。新建 `session-list.test.js` 使用临时历史和禁止创建 Agent 的模拟函数，覆盖跨目录、同名文件夹、最近活动排序、标题兼容、最小返回字段、缺目录历史、文件不变及空列表。实际工作区脚本语法检查通过，运行该测试加会话服务、历史预览和 IPC 共 4 个文件，22 项全部通过，不读取真实会话或请求模型。列表元信息已在 `404ac88` 提交并推送，实际页面分组进度见下条。
- 使用者已亲手完成实际侧栏分组：`session-list.js` 以完整路径分组，组内和组间按最近活动排序，原生 details/summary 折叠，显示目录名、完整路径与数量；搜索仅匹配标题并展开命中组，清除搜索恢复原折叠选择。折叠状态只在页面内存中，分组不触发工作目录切换。`session-list.css` 已追加主题变量样式和窄窗口截断，HTML 标题改为“项目与对话”，renderer 和 page-shell 接口未改。实际脚本语法检查通过。
- 实际渲染代码的临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-session-group-actual-_2qhjwbh` 通过 8 项分组与交互模拟检查（分组排序、折叠刷新、搜索、忙碌、纯文本安全、Enter/Space 和焦点、三档布局、会话输入隔离及停止恢复），以及 13 项既有消息回归检查。只用模拟接口与临时页面，不请求模型、读取真实会话或写真实剪贴板。使用者反馈“做完了”，未逐项描述真实界面验收。窄窗口切换会话后可手动收起侧栏返回聊天；现有 page-shell 点击委托会在业务已设置 busy 后检查 disabled，自动关闭行为尚未修复。本轮只收尾分组，不重复指导实现。
- 使用者已亲手完成 `src/main/storage/project-store.js` 与 `tests/unit/project-store.test.js`，实际源码已核对。`createProjectStore(storagePath)` 提供 `list()` / `add(workspaceDir)`，保存 `{ projects: [{ id, name, workspaceDir }] }`。添加时校验真实文件夹，符号链接归一、同目录去重、编号稳定，名称默认目录名；列表读取保留目录暂时失效的项目。损坏或重复记录明确拒绝，写入使用同目录临时文件和 rename。添加操作后续须由 IPC 互斥入口串行调用，不额外引入队列。实际语法检查与项目存储、目录设置共 10 项测试通过，仅操作临时目录，不读取真实项目或会话，不请求模型；存储模块已在 `bcd203e` 提交并推送，启动接线进度见下条。
- 使用者已亲手完成系统窗口添加项目的服务与接线：新建 `project-service.js`，提供 `listProjects()` / `addProject(sender)`，只登记系统选中的目录，不切换当前工作目录或创建会话。`bootstrap.js` 将原父窗口绑定与关闭检查提取为 `chooseWorkspaceDirectory()`，供目录切换与添加项目共用，项目存储使用 `userData/projects.json`。IPC 新增只读 `agent:list-projects` 与受 `runIdleOperation` 保护的 `agent:add-project`，预加载新增无参数 `listProjects()` / `addProject()`，不转发页面路径。
- 编写时误替换掉原有 `agent:select-workspace` 注册，导致目录选择与项目互斥共 5 项测试失败。使用者已补回，实际源码核对及 4 个脚本语法检查通过；运行项目服务、项目存储、目录选择、目录设置、IPC 共 5 文件 28 项测试全部通过。另在包含实际后端代码的临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-project-page-shmx8l3b` 中用模拟 Electron 验证启动组装、真实项目存储写入临时 userData、父窗口绑定和关闭取消；不读取 .env、真实项目或会话、不请求模型。尚未接入实际页面。
- 使用者已亲手完成项目面板：新增 `components/project-panel.js` 与 `styles/project-panel.css`，HTML 在侧栏加入“已添加项目”、添加按钮、状态和只读重试入口，renderer 接入独立初始化及统一忙碌状态。添加仅登记目录，不切换对话；取消、失败和登记后清单读取失败有独立提示，读取失败保留原清单。当前项目清单仍为静态名称和路径，尚无打开入口。
- 2026-11-01 核对实际源码，渲染脚本语法检查通过；实际渲染代码临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-project-page-actual-u73_fszn` 运行 10 项项目面板检查和 13 项消息回归，全部通过。覆盖取消、错误、重复添加、登记后列表失败、模型初始化失败时独立读取、生成和保存禁用、输入与文件草稿保留、三档布局、键盘和焦点。只用模拟接口，不读取 .env、真实项目或会话、不请求模型、不写真实剪贴板。使用者反馈“做完了”，尚未逐项描述真实系统窗口及重启验收。另以仅包含暂存代码的临时副本运行同样 23 项检查，全部通过，确认本轮提交不依赖其他未提交改动。
- 使用者已明确选择：打开项目时恢复“最近有消息活动的对话”，不是记住最后查看的对话。下一步先手写会话服务 `openWorkspace(workspaceDir)`：其他目录通过 `createAgent(sessionDir, true, undefined, realDir)` 复用已有绑定恢复；重复打开当前真实目录保留当前会话，包括未落盘空对话；历史和目录配置准备成功后才替换旧会话。原 `switchWorkspace()` 继续明确新建，不改变其行为。
- 使用者已亲手完成实际 `openWorkspace()` 与 `workspace-open.test.js`，源码和导出已核对。2026-11-01 在实际工作区运行该测试加目录切换、目录恢复、会话目录接线、会话服务共 5 文件，33 项全部通过，语法检查通过。新增 9 项模拟 Agent 并使用临时目录，既有恢复测试使用临时 SDK 会话，不请求模型或读取真实会话。此步尚未接入项目服务、IPC 或页面。
- 使用者已亲手完成按编号打开项目的服务、启动、IPC、预加载与完整 `project-open.test.js`。`createProjectService()` 第三个参数注入同一 `sessionService`，`openProject(projectId)` 按主进程登记查目录，再调用 `openWorkspace()`；`agent:open-project` 共用互斥入口，预加载仅转发编号，忽略额外路径参数。2026-11-01 核对实际代码并运行项目打开、项目添加、项目存储、目录打开、目录切换、目录恢复、目录选择和 IPC 共 8 文件，52 项全部通过；4 个改动脚本语法检查通过。实际后端临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-project-open-actual-ig4png7i` 使用真实临时项目存储和模拟会话服务，验证启动注入、编号解析、未知编号拒绝与窗口关闭取消。不读取 .env、真实项目或会话、不请求模型。实际页面尚无打开按钮。
- 使用者已亲手完成实际项目打开页面：`project-panel.js` 第四参数 `onOpenProject` 接原生整行按钮与统一忙碌；renderer 主进程确认成功后绑定会话输入、恢复历史和选中项，独立刷新文件草稿、历史列表、会话信息和模型。局部刷新失败明确提示项目已经打开，打开失败在项目区提示并保留当前全部状态。成功派发 `project-opened`，page-shell 在窄窗口收起侧栏，再聚焦输入框；CSS 保留截断与可见焦点。
- 2026-11-01 核对实际三个渲染脚本与样式，语法检查通过。实际渲染层临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-project-open-page-actual-98rxm2ci` 通过 11 项打开项目、10 项添加项目和 13 项消息回归，共 34 项。覆盖失败保留、防重复、输入隔离、等待期间输入、目标模型和草稿、空会话、多处刷新失败、模型只读重试、生成和保存禁用、三档布局、Enter与焦点、成功才收起侧栏、初始化失败后恢复和清单慢加载。只使用模拟接口，不读 .env、真实项目或会话、不请求模型、不写真实剪贴板或工作文件。用户反馈“做完了”，未逐项说明真实界面验收，不把模拟检查称为真实模型验收。
- 使用者已亲手完成项目重命名存储与 `project-rename.test.js`。`project-store.js` 私有 `save(projects)` 复用原子写入，内部 `renameProject()` 通过 `rename: renameProject` 导出，避免遮蔽 fs.rename。只改登记名称，保留编号、真实目录、顺序和其他项目；名称 trim 后为 1～40 个 UTF-16 单元。2026-11-01 核对实际代码，运行新增 4 项加项目存储、项目添加、项目打开共 4 文件，23 项全部通过；未接服务、IPC或页面。实际文件另有格式变化及注释位置差异，功能暂存以原风格精确构造，工作区不改写。
- 使用者明确转向“文件草稿审阅增强”：修改显示行级差异、行号和增删标记，新建保留完整正文；先做前端，再扩展后端审阅数据；保存前仍核对文件变化。项目重命名接口与页面、置顶、归档暂留后续，不继续优先推进。
- 审阅与保存的边界：编辑审阅现已扩展真实文件起始行和上下文，实际前端已接入真实文件行号和上下文，验证记录见下文。审阅服务读取全文并比对 baseTextHash，保存模块重新读取、检查路径/全文哈希/唯一替换，临时文件同步后再次复核再发布；扩展审阅数据没有改变保存模块。已有检查非操作系统级并发锁，不声称能排除复核后瞬间的外部写入。
- 使用者已亲手完成前端逐行差异：新增 `proposal-diff.js` 使用保留行尾的最长公共子序列对齐（当前每侧最多1000字符），显示旧/新片段行号、+/−/=标记、LF/CRLF/CR/片段无换行。空格和Tab通过伪元素叠加可见标记，DOM仍保留原文；空片段不制造占位行，纯文本安全渲染。明确标注“片段行号，并非文件行号”；新建分支保持完整正文、空文件占位及空白不变。
- `proposal-panel.js` 实际增加导入并替换 edit 分支；编写时残留的 `afterPanel` / `beforePanel` 两行旧引用曾在实际页面模拟复现报错，现已由使用者删除并核对。`proposal-comparison.css` 增加单列差异表、内部横向滚动、键盘焦点及现有主题色，HTML和IPC不变。实际两个脚本语法检查通过；差异、编辑审阅、编辑保存、保存服务、新建审阅和新建保存共6文件35项测试通过。最新实际审阅组件复制到临时渲染副本后，Electron模拟专项8项通过，覆盖新建完整正文、HTML安全、空白/换行、审阅与保存检查失败、重新审阅、按钮/输入保留及三档滚动/焦点。使用者反馈“做完了”，未逐项描述真实文件验收；不将模拟检查等同于真实模型验收。未读取真实会话、不请求模型、不写真实剪贴板。
- 使用者已亲手完成后端审阅上下文：编辑审阅在原全文哈希和唯一定位检查后返回 `{ ...proposal, review: { startLine, oldText, newText } }`；review正文是修改涉及的完整行及前后各两行上下文，保留行内前后缀、BOM、空白与原始换行。起始行从1计数，末尾换行不虚构额外空行；原草稿字段、持久化、新建审阅和保存复核不变。已核对实际服务及新增 `proposal-review-context.test.js` 8项。原编辑审阅测试曾误将整个文件替换为一个测试，导致导入、setup和其他三项缺失，现已由使用者完整恢复并更新成功断言；实际工作区7文件43项全部通过，服务语法检查通过。仅使用临时文件，不读取真实会话或请求模型。
- 使用者已亲手完成真实文件行号的页面接入。`renderProposalDiff(review)` 接收完整行和起始行号，保留 buildLineDiff 算法；渲染时分别偏移旧、新行号，删除/新增的另一侧保持空号。表格说明旧行对应原文件、新行对应保存后的预计文件，行尾列不再称片段行尾。proposal-panel 的 edit 分支接到 proposal.review，并更新上下文提示，新建分支不变。实际两个脚本语法检查和差异算法6项通过；最新实际渲染代码复制到临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-review-file-lines-pgpyrps_` 后，9项Electron专项检查全部通过。专项包含真实临时文件审阅结果贯通页面、行内前后缀、上下文与增删后的行号，审阅后外部修改仍拒绝保存，以及空白/混合换行/纯删除/新建完整正文/HTML安全/错误后重新审阅/输入保留/三档内部横滚与焦点。使用者反馈“做完了”，不将模拟检查等同于助手实际操作真实会话。未读取真实会话、不请求模型、不写真实剪贴板。
- 使用者已要求下一阶段设计“日常使用体验”：输入草稿重启恢复、会话置顶与归档、上下文用量更易发现，要求草稿不串会话、发送成功不恢复旧输入、归档可撤销且不删除原记录。完整方案在 `docs/daily-use-experience.md`；会话状态存储现已由使用者完成，其余业务和界面尚未接通。输入当前仍只在页面内存中，不能提前宣称支持重启恢复；用户本次要求已授权下一阶段改变该限制，继续由使用者亲手编写。
- 使用者已亲手完成 `src/main/storage/session-state-store.js` 与 `tests/unit/session-state-store.test.js`，实际模块语法检查及8项测试通过。提供 load/update/saveDraft，同会话更新排队，输入版本单独核验；空字符串也保存版本，置顶和归档不覆盖输入。验证覆盖原文/空输入重建实例恢复、读取等待已有写入、会话隔离与目录绑定、并发字段更新、旧版本拒绝、损坏文件保留、替换失败清理和后续重试。输入草稿服务及启动组装、IPC与预加载接口现已完成；页面仍未接入。页面保存队列现已完成；读取凭证和编辑保护现已完成；发送快照与版本消费存储现已完成；聊天服务生命周期现已完成；消费确认通信现已完成；队列消费版本协调现已完成；只读状态核对接口现已完成；队列核对结果协调和主动清空保护现已完成；下一步页面输入持久化组件，再整体接页面自动保存与恢复、置顶归档和恢复过滤、上下文常驻入口。生成期间输入保存必须有独立入口，不能直接套用阻止生成期间操作的 runIdleOperation；存储按会话串行更新，避免自动保存覆盖组织状态。发送结果未确认的快照单独保留供手动查看，不自动回填或重发；成功与主动停止不恢复已消费输入，保留后续新输入。
- 使用者已亲手完成 `src/main/services/composer-draft-service.js` 与 `tests/unit/composer-draft-service.test.js`，实际服务语法检查、服务9项与存储8项测试全部通过。loadCurrentDraft/saveDraft 从 sessionService.getSession(true) 固定编号和真实目录，异步读取成功并复核后才登记；保存只接受已登记编号，不接页面目录、不重新查询当前会话。切换后延迟保存仍归原会话，响应仅含 sessionId/text/revision。并发同编号不同目录的迟到登记不能覆盖已确认归属。Map只是进程内登记，空会话重启恢复及页面持久化尚未实现。
- 使用者已亲手完成 bootstrap、agent-ipc、preload 接线及 composer-draft-ipc.test.js。已修正两个草稿通道重复注册和启动入口漏传第九参数的问题；模拟 handle 现在拒绝重复注册，另有 VM 启动组装测试。实际三脚本语法检查、通信5项加服务/存储/既有IPC共28项全部通过；仅已提交代码加本次相关接线的临时副本也通过28项。bootstrap共享 userData/session-state 存储，composerDraftService作为registerAgentIpc第九参数；固定通道agent:load-composer-draft、agent:save-composer-draft，preload提供loadComposerDraft()/saveComposerDraft(sessionId, text, expectedRevision)。输入保存独立于runIdleOperation，生成或切换期间允许按已登记编号保存；页面尚未调用这些接口。
- 使用者已亲手完成 `src/renderer/components/composer-draft-queue.js` 与 `tests/unit/composer-draft-queue.test.js`，实际脚本语法检查及队列7项、既有composer-drafts5项共12项全部通过。createComposerDraftQueue(saveDraft)提供register/setText/flush，同会话共用在途Promise并合并后续编辑，A慢保存不阻塞B；确认后才推进版本，在途改回空串仍补写。重复register不回退本地正文与版本；失败报告、不自动重试或猜测新版本。队列尚未接入renderer，不操作DOM，不处理发送消费。
- 使用者已亲手完成 composer-drafts.js 读取保护和 composer-draft-restore.test.js；实际脚本语法检查、恢复6项加队列7项和既有输入5项共18项全部通过。保留switchTo/restoreAfterFailure，增加recordEdit/beginRestore/applyRestore，读取凭证在编辑或真正切换后失效；A→B→A旧响应无效，加载期间输入、主动清空、失败恢复和已恢复空串均受保护。尚未接renderer输入事件、异步读取及程序清空；后续须调用recordEdit。beginRestore返回null只禁止回填，不能跳过服务读取与保存队列登记。
- 使用者已亲手完成 session-state-store.js 的pendingSend、consumeDraft/completeSend及composer-send-state.test.js。实际语法检查、发送状态7项加存储8项、输入服务9项和通信5项共29项通过；仅已提交代码加相关存储改动的隔离副本也29项通过，排除无关格式差异。旧记录缺少pendingSend仍可读取；消费在同次update中保存完整原文快照并清空draft、版本+1；已有未确认快照时拒绝覆盖，期间仍可saveDraft保存新输入。完成只按发送编号清理匹配快照，保留后续输入、版本和组织状态。已接入聊天服务的可选版本路径，页面尚未启用；失败或结果未知不能直接清理快照。
- 使用者已亲手完成chat-service.js、bootstrap存储注入和chat-draft-lifecycle.test.js。实际两脚本语法检查、生命周期8项加既有聊天5项和发送/状态存储15项共28项通过，隔离副本也28项通过。createChatService第四参数注入共享sessionStateStore；send保留原四参数，新增第五参数draftRequest:{sessionId,revision}和第六个同步onDraftConsumed。等待前固定参数、核对实际会话后消费完整原文，确认DTO为{sessionId,sendId,text:"",revision}且回调只拿副本；模型仍使用trim后的文本。初始化/消费期间停止也消费并清理，不调用模型。成功/停止按原会话清理，清理失败返回warning，不改变completed/stopped结果；消费后异常返回outcome:"unconfirmed"并保留快照，不自动回填或重发。消费前异常仍reject；无draftRequest的旧调用仍返回{stopped}。IPC现已支持可选版本发送；页面尚未启用该路径。
- 使用者已亲手完成agent-ipc、preload及draft-send-ipc.test.js，实际两脚本语法检查、通信7项加生命周期8项、既有IPC6项及输入通信5项共26项通过。agent:send-message新增可选draftRequest，IPC与preload只转发sessionId/revision，保留原文及缺省旧调用；显式无效值不降级。消费确认按agent:draft-consumed只通知请求来源，来源销毁则跳过通知；预加载onDraftConsumed只传数据并可独立取消。outcome/error/warning原样返回。仅已提交代码加相关功能块的隔离副本也通过这26项；包含真实临时存储+模拟发送，不请求模型。页面尚未启用版本路径。
- 使用者已亲手完成保存队列的beginSend/confirmConsumed/finishSend/rejectBeforeConsume及composer-draft-send-queue.test.js；实际语法检查、9项新增加既有队列/读取/输入共27项全部通过。代码与上轮已验证指南一致。发送前须保存完成并固定原文/版本凭证，等待确认暂停本会话保存，确认只推进基线、不清空新输入，凭证身份与版本防止迟到/重复确认；发送结束才释放本地凭证，确定消费前失败才允许为空时恢复。此恢复目前只判断空值，后续页面还须结合编辑记录保护后来主动清空。仍未接renderer，IPC异常或缺失确认不证明未消费，不可盲目解除暂停。
- 使用者已亲手完成composerDraftService.inspectSend(sessionId)、agent:inspect-composer-send、preload.inspectComposerSend与composer-send-inspection.test.js。实际三个脚本语法检查、11项新增加相关回归共38项全部通过；隔离的已提交代码加本次功能块也通过相关38项。服务只读已登记原会话并核对目录，返回{sessionId,text,revision,pendingSend:null|{id,text,draftRevision}}，不暴露目录或组织字段；IPC经runIdleOperation，生成中拒绝，读取期间阻止新发送/会话操作，输入保存仍独立。来源文件仅有格式差异，提交精确暂存功能块。尚未接renderer。
- 使用者已亲手完成队列reconcileSend及editVersion主动清空保护、原发送队列测试空串分支调整和composer-send-reconcile.test.js。实际语法检查、10项新增加既有队列/读取/输入共37项全部通过；与已验证指南一致。严格按原文、版本、凭证身份和确认状态协调，返回not-consumed/consumed/advanced，其他冲突保持暂停；advanced不证明模型成功，pendingSend保留供手动查看。发送清空不计为用户setText编辑。尚未接renderer。
- 上轮记录：使用者已亲手创建composer-persistence.js，内容与docs/composer-persistence-step.md一致，语法检查通过。实际测试误放tests/composer-persistence.test.js，直接运行16项因相对导入越过项目目录而失败，不能记作实际53项通过；原37项通过。下一步先由使用者移动到tests/unit/composer-persistence.test.js，不改导入。正确目录临时副本53项通过。完整页面接线建议见docs/composer-page-integration-step.md；候选位于 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-page-o_qy2gsq`，以HEAD和当前实际渲染层为基线。候选renderer语法检查及实际Electron页面/真实preload与IPC/临时存储14项模拟检查通过，覆盖输入隔离、保存失败与重试、发送/停止、生成中新输入、缺失确认/结果后的核对、未确认快照独立安全展示、新建继续、加载中编辑、项目打开互斥和其他页面操作、整页重建恢复、三档窗口布局；已查看页面截图。未请求模型、读取真实会话/配置或写真实剪贴板，不代表真实界面验收。实际HTML/CSS/renderer尚未接入；refreshSessions不得绑定输入，应在初始化及四个成功切换入口显式await bindComposer，项目绑定先于并行刷新，避免inspect与listProposals互斥冲突。组件已保护加载/编辑/主动清空和发送版本，300ms保存、持续输入最长1s；状态反馈与未确认原文遵循深色基线及ui-ux-pro-max指引。后续仍需未确认记录手动处理、空会话重建与正常关闭补保存，不能提前宣称完整重启恢复。
- 最新核对：使用者已将composer-persistence.test.js移到tests/unit并完成页面接线，实际组件/renderer语法检查及6个相关文件53项通过；漏传项目回调和重复body开始标签也已由使用者修正，不再要求移动测试或修复这两处。实际整个渲染层+实际IPC/preload的临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-page-verified-c6v2rti3` 通过14项Electron模拟检查，已查看截图；保留状态重试、版本发送、消费确认及四个切换入口，refreshSessions只刷新列表，项目绑定先于并行刷新。输入组件前轮已提交，本轮页面接线精确提取到仅HEAD加相关渲染变更的副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-page-commit-sh7qu9e3`，组件相关53项与页面14项也全部通过，排除model-settings和其他视觉改动。未请求模型或读取真实配置/会话，不代表用户逐项真实界面验收。model-settings等其他工作区改动保留且不验收/提交，不混入页面接线提交。
- 使用者已完成docs/composer-send-dismiss-step.md中的dismissSend、受runIdleOperation保护的agent:dismiss-composer-send、有限preload.dismissComposerSend及11项专项测试。实际三个脚本语法检查与8个相关文件67项全部通过，实际代码与上轮候选一致（仅排版差异）；仅HEAD加本次功能块和用户测试的隔离副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-dismiss-commit-00g7g0ie` 也67项通过。该后端功能及测试已在c550be6提交并推送，保留model-settings与其他未提交差异。接口仅按已登记原会话和发送编号，在update串行回调内比较id并清理pendingSend，保留输入、版本、组织状态，不请求模型或改Pi历史；页面确认现已接入，不重复实现后端。
- 上轮候选记录：完整代码保留在 `docs/composer-send-dismiss-ui-step.md`，候选副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-dismiss-ui-l_biuotn` 曾通过61项相关测试及23项页面模拟；本轮用户已完成实际代码，不再要求按指南重复编写。
- 本轮最新实际核对：使用者已完成 `composer-persistence.js` 的dismissPendingSend/refreshPending、canDismiss和每会话dismissing/pendingCheckError，renderer二次确认及HTML/CSS接线，并新建 `tests/unit/composer-send-dismiss-ui.test.js` 8项。实际两个脚本语法检查及以下7个文件61项全部通过；实际整个src的临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-dismiss-ui-final-actual-69onnft1` 通过23项Electron页面模拟，查看1120与375截图。确认绑定原sessionId/sendId，取消优先焦点，Escape有输入法保护，切换或快照变化使旧确认失效；解除不覆盖后来输入/主动清空，不重新发送，返回丢失先只读核对，核对失败继续限制且普通重试不重复清理，保存成功不能误抹核对错误。仅HEAD加本轮四个前端文件相关功能块和用户新测试的提交副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-dismiss-ui-final-commit-oqylikby` 也通过61项与23项，排除model-settings和其他未提交改动。测试使用模拟会话/请求、实际IPC/preload和真实临时状态存储，不请求模型、不读取真实配置/会话或写真实剪贴板；不等于真实应用重启验收。助手未代写实际应用或测试，只精确暂存已验证的用户代码及更新交接。

```bash
node --check src/renderer/components/composer-persistence.js
node --check src/renderer/renderer.js
node --test \
  tests/unit/composer-send-dismiss-ui.test.js \
  tests/unit/composer-persistence.test.js \
  tests/unit/composer-send-reconcile.test.js \
  tests/unit/composer-draft-send-queue.test.js \
  tests/unit/composer-draft-queue.test.js \
  tests/unit/composer-draft-restore.test.js \
  tests/unit/composer-drafts.test.js
```
- 已核对 SDK 空会话边界，并在临时目录验证公开的 `SessionManager.create(cwd, sessionDir, { id })` 可以保留原编号重建未发送空会话，单独绑定不会落盘历史。设计将登记这类输入并提供同目录“未发送”入口；有真实历史则优先原恢复链路，历史丢失不冒充空会话。完整业务尚未实施。归档还须同步过滤启动和项目自动恢复，不能只让侧栏隐藏；项目恢复仍按最近消息活动。上下文复用已有 getSessionInfo，不新增模型请求。

### 新 UI 迭代基线（2026-11-01）

- 使用者已明确要求后续建议在这套新 UI 上迭代。已核对工作区中的 `src/renderer/index.html`、`src/renderer/styles/codex-theme.css` 和 `src/renderer/components/page-shell.js`，三者与交付的候选代码一致，HTML 已引用新增主题与外壳脚本。这三个文件已单独提交为 `239becb`。
- 页面沿用现有 `renderer.js` 与业务组件；新主题在原有五个样式文件之后加载，`page-shell.js` 仅管理侧栏、标题、草稿面板入口和菜单展示，不调用 `window.agent`。整理上下文、导出、重命名和会话信息位于右上角菜单，模型选择位于输入区右下方；后续工作目录选择等新入口也在这套布局中设计。
- 候选页面已在临时副本中通过 Electron 模拟检查，覆盖模型切换成功及更新前/后失败、输入与草稿保留、目录读取失败重试、历史/新会话、生成期间禁用、侧栏与菜单操作、焦点恢复及五档窗口布局；全部 26 个既有页面 ID 保留且无重复。测试未读取真实会话、请求模型或执行真实文件保存。
- 使用者已反馈“页面测试我已经做完了”，按本轮新深色 UI 的真实界面验收完成记录，不再重复要求验收。助手另使用实际渲染代码的临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-dark-ui-final-glr5h36y` 通过 10 项模型选择器模拟回归检查，未请求模型或读取真实会话；这与使用者手动验收是两项独立证据。
- 深色视觉与布局继续作为基线。当前仅 Agent 聊天回复已接入安全 Markdown 与代码高亮；用户、工具、状态、错误消息和独立只读历史预览仍为纯文本。尚未实现系统窗口标题栏改造。

### 下一步顺序

1. 从上方未完项清单第1项开始，先核对 `workspace-session.mjs`、`pi-agent.mjs`、会话服务、输入服务与状态存储，设计最小的未发送空会话登记及重建步骤；保留原编号、目录和模型，不新增虚构聊天消息。继续给用户完整手写代码及针对性验证，不代写应用。
2. 再补正常关闭握手与待写输入保存，验证失败不关窗、生成期间关闭和正常退出；完成空会话与关闭链路后才做完整重启恢复验收。
3. 然后推进置顶归档（包括启动/项目恢复过滤）、上下文常驻入口；项目重命名接线稍后继续，详细规则见 `docs/daily-use-experience.md`。该设计文档仍保留部分历史进度描述，当前完成情况以本文件最新核对为准。
4. 已完成的模型、目录、Markdown、项目打开、文件草稿审阅及输入/发送/解除链路不要重复实施。页面沿用新深色UI；项目恢复继续选最近有消息活动的合法对话，重复点击当前项目保留当前对话。
5. 工作区其他改动保持原状，单独核验后再提交。只精确暂存本轮相关代码和文档，不读取或提交 `.env`、真实会话及本地验收文件，不执行 `git add .`。

### 本次提交范围

本轮只提交用户已完成且实际与隔离副本均通过61项测试、23项页面模拟的未确认发送解除前端：composer-persistence、renderer、index.html、codex-theme的相关功能及composer-send-dismiss-ui.test.js，并更新本AGENTS交接和未完项清单。renderer/HTML/CSS按功能块精确暂存，保留model-settings和其他视觉、排版、业务改动；实际应用文件不由助手改写。后端解除接口已在c550be6推送，不重复纳入。未读取或提交.env、真实会话及本地验收内容。

### 模型与配置多配置实现（2026-11-01）

- 用户本轮明确授权助手按计划直接实现并自行验证，实际模型设置存储、服务、运行时、启动、会话服务、IPC/preload及页面已接通；此前“model-settings待核验”的记录对本功能已过时，其他无关改动仍保留。
- 每项配置有稳定编号，模型、地址和凭据独立；通过当前会话setModel切换，保留上下文，历史按配置编号/当前分支恢复。新增与设默认不切换当前对话；修改用新名称另存，保留旧项。旧V1配置首次写入时升级V2并保留密文。
- 启动仍读取.env的PI_PROVIDER/PI_MODEL/PI_BASE_URL及供应商凭据；无本地配置时作为原有配置，已保存默认优先。新增表单“读取.env配置”在已有本地配置时也可使用，只填入启动时的非敏感字段，不回填密钥、不保存或切换；改变.env后重启才重读。保存不改写.env。
- 新增内置目录支持OpenAI/Anthropic/DeepSeek，自定义支持三种常见API Key兼容协议和手填模型ID/窗口/输出，文本输入；不包含OAuth复制、云厂商签名或额外认证头。原有配置仍兼容原生SDK供应商。自定义cost为SDK必需的未知价格占位，不能当免费或费用统计。
- 实际工作区15个相关测试文件82项通过，12个脚本语法通过；实际渲染层临时副本通过25项Electron模拟检查并查看截图。新增model-settings-env.test.js验证真实bootstrap加载临时.env、目录/地址/密钥、保存默认优先及.env文件不变；原composer-draft-ipc启动接线测试同步到第10个模型服务参数，并保留第9个输入服务参数断言。
- 另按用户本次配置检查要求，对本机.env做了不输出内容的离线校验：模型/地址/凭据解析与临时SDK初始化均通过；未改写.env、不读真实会话、不请求模型，不代表远程兼容性或账号权限已验收。空会话未落盘的恢复边界继续保留。
- 使用说明、验证命令与模拟界面截图见docs/model-settings.md。提交只包括本功能及必要接线，保留工作区其他视觉、格式和业务差异，不提交.env、会话或本地验收文件。

### 空会话恢复登记存储（2026-11-02 最新核对）

- 使用者已亲手完成 `session-state-store.js` 的可选 `registration` 校验、`registerSession(sessionId, workspaceDir, source, model)` 和 `tests/unit/session-registration.test.js` 6项。实际语法检查及登记、状态存储、发送状态、输入服务4个文件30项全部通过；仅HEAD加本次登记功能块和用户新测试的隔离副本也30项通过，排除既有排版差异。
- 登记保存 `source: empty/history` 和实际运行时的 `provider/modelId`，新增配置的provider含稳定配置编号；不存密钥、地址或完整模型。已有history不降级为empty，登记不改变输入版本、发送快照或组织字段；旧状态缺登记仍保持未知，不能认定为空会话。
- 此步仅完成存储能力，尚未由输入或会话业务调用，不代表未发送会话已可重启找回。助手未改写实际应用或测试，只精确暂存使用者已完成的登记功能和专项测试，保留其他工作区差异。
- 下一小步先由实际创建/打开分支标记可信来源，再接输入服务。完整手写指南见 `docs/session-origin-step.md`：`createWorkspaceSession()` 返回empty/history，Pi会话持有创建时的 `desktopSessionOrigin`，不靠历史文件缺失推断。此候选尚未接入实际代码；临时副本两个脚本语法检查及来源、目录绑定/恢复、Pi初始化/目录、模型恢复/多配置共7文件20项通过，新增来源专项4项。测试仅用临时配置和会话，不请求模型或读取真实配置/会话。
- 创建时empty不是永久证明；后续服务接线还须在产生消息后推进history并同步模型选择，保持迟到保存归原会话。未发送入口、原编号重建和正常关闭补保存仍未完成，优先级不变。

### 会话来源标识完成与输入登记接线候选（2026-11-02 最新核对）

- 使用者已亲手完成 `docs/session-origin-step.md` 的工作目录会话来源返回、Pi会话 `desktopSessionOrigin` 和 `tests/unit/session-origin.test.js` 4项。实际两个脚本语法检查及来源、目录绑定/恢复、Pi初始化/目录、模型恢复/多配置7文件20项全部通过；仅HEAD加本次来源功能块和用户新测试的提交副本也20项通过。此来源标识已完成，不重复实施；原工作区格式差异保留，助手未改写应用或测试。
- 下一小步完整手写指南为 `docs/composer-registration-step.md`，候选尚未接入实际应用或测试：会话服务同步读取当前实际来源/模型，离开后只保留小型元数据快照；存储saveDraft在同会话更新队列内部调用可信读取函数，与输入、版本同次原子写入；输入服务只查询原编号，不扩展IPC/preload或页面。未知来源保持未知，已有history不降级。
- 候选三个脚本语法检查通过，输入登记、既有存储/输入/通信、会话及目录切换/打开、来源、Pi初始化/目录和模型恢复/切换/多配置共18文件99项通过，新增登记接线专项10项；包括真实SDK同编号重新打开后的实际模型保存。只操作临时配置/会话和占位凭据，不读取.env、真实配置/会话或请求模型；不等于实际手写代码或真实页面验收。
- 本候选仅在输入保存时同步登记。单独切换模型后没有编辑、首次发送后没有新输入时，仍需下一小步补独立同步与history推进；完成前不启用空会话重建。之后继续未发送列表/原编号重建、正常关闭补保存，再验收完整重启恢复。

### 输入登记接线完成与独立同步候选（2026-11-02 最新核对）

- 使用者已亲手完成 `docs/composer-registration-step.md` 的会话只读登记/离开快照、saveDraft队列内原子登记、输入服务原编号回调，以及 `tests/unit/composer-registration.test.js` 10项。实际三个脚本语法检查及18文件99项全部通过；仅HEAD加本次三个应用文件功能块和用户新测试的精确提交副本也99项通过。此接线已经完成，不重复实施；助手未改写实际应用或测试，原工作区格式等无关差异保留。
- 下一小步完整手写指南为 `docs/registration-sync-step.md`，候选尚未接入实际应用或测试。会话服务第五参数注入共享状态存储，独立同步队列内实际来源/模型；模型或配置切换成功、部分更新后报错均尝试同步，同选择可在服务层重试；没有输入状态时不另建空记录。bootstrap仍让会话、输入和聊天共用同一实例。
- 发送候选在收尾、清理快照之前同步history；失败不改变completed/stopped/unconfirmed含义，附加提示并保留快照。明确解除快照前也必须同步成功，避免清理后丢失历史来源证明；不改输入原文、版本、组织状态或Pi历史。原初始化/消费期间停止不调用模型，仍按空会话事实收尾。
- 候选四个脚本语法检查通过，独立同步、既有输入/状态/发送/解除、会话/目录和模型链路共23文件142项通过，新增专项12项；含真实SDK初始化/模型切换、临时本地消息及真实bootstrap组装的离线验证，不请求模型，不读取.env、真实配置或真实会话，不等于实际手写文件或页面验收。
- 服务层重试候选已验证；现有模型选择框相同选项不触发change，专用登记错误重试入口仍未接入，不能记作页面完成。后续未发送入口/重建必须优先真实历史，并拒绝将仍有pendingSend的记录直接当空会话重建；随后补正常关闭保存，完整重启恢复仍未完成。

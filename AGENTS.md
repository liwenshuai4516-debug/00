# 仓库指南

## 协作与变更范围

- 默认使用中文交流和编写项目文档；标识符、命令及必要技术术语保留原文。
- 使用者已授权助手直接实现必要的代码、测试与文档，不再要求使用者照指南手写。实施前说明范围、关键假设和可验证目标；无法合理判断的歧义先澄清。
- 采用最小必要改动，沿用现有风格；不夹带功能、无关重构或格式整理，不为一次性逻辑引入抽象。关键中文注释解释不直观的意图。
- 开始工作先检查实际源码与 Git 状态。保留其他窗口或使用者的未提交、已暂存改动；不能仅凭文件存在、旧交接或测试数量认定功能完成。
- 完成并验证文件更新后，自动将本次相关变更提交并推送到 `origin` 当前分支，无需再次询问。远端为 `git@github.com:liwenshuai4516-debug/00.git`，使用已有 SSH 授权，不强制推送。提交前检查差异和忽略规则，避免混入无关改动；验证、提交或推送失败须如实说明。仅给建议而未修改文件时不创建提交。
- 提交信息简洁说明变更；合并请求说明目的与验证结果，界面变更附截图。

## 架构与代码约定

项目使用 Electron、原生 DOM/ES Module 渲染层和 Pi Agent SDK。允许使用 Element Plus 不代表已引入 Vue 或需要迁移框架。

| 位置 | 职责 |
| --- | --- |
| `src/main/main.js` | 单实例锁与重复启动恢复；先获取锁再加载业务模块 |
| `src/main/bootstrap.js` | 配置加载、服务组装、IPC 注册、窗口创建 |
| `src/main/lifecycle/` | 窗口关闭、退出协调及聊天停止 |
| `src/main/pi-agent.mjs` | Pi 会话创建、模型与工具组装 |
| `src/main/services/`、`src/main/storage/` | 业务操作与持久化 |
| `src/main/model/`、`src/main/ipc/model-ipc.js` | 模型目录、凭据、OAuth、参数补全与受限接口 |
| `src/main/tools/`、`src/main/workspace/` | 工作目录工具及路径、读取约束 |
| `src/preload/preload.js` | 向页面暴露有限的主进程接口 |
| `src/renderer/` | 页面与交互；`components/` 放组件，`styles/` 放样式 |
| `src/renderer/theme/`、`components/theme/`、`styles/themes/` | 主题偏好与首帧恢复、主题选择界面、独立配色；设置分类放在 `components/settings/` |

保持主进程、预加载、渲染进程职责分离；新功能确需接口时同步接通必要链路。移动文件时同步入口、导入和资源路径，并检查旧会话读取。

JavaScript 使用两空格缩进、双引号、分号和描述性驼峰命名；主进程使用 CommonJS，Pi 模块及渲染层使用 ES Module。渲染层局部 `package.json` 声明模块类型。HTML 使用两空格缩进，编辑时保持相邻风格。不要手动修改 `node_modules/`。

## 开发与验证

- `npm ci`：按锁文件安装依赖；`npm start`：启动 Electron。
- `npm test`：运行 `tests/unit/*.test.js`。默认仅执行本次涉及的测试：`node --test tests/unit/<name>.test.js`，不例行全量运行。
- 离线页面检查：`node_modules/.bin/electron tests/ui/<name>.check.cjs`。具体文件和验证范围见功能文档。
- 修复缺陷先复现，再验证修复；检查范围与改动相称。必要时使用仅含本次改动的临时副本，区分工作区结果与精确提交结果。
- 会话测试使用模拟工厂和临时数据；真实 SDK 初始化检查使用临时配置与会话，不请求模型。不要为验证读取用户真实 `.env`、配置、会话或验收文件，不调用付费模型制造失败。
- 自动测试、模拟页面检查和使用者真实验收分别记录，不能互相替代或扩大结论。按功能检查发送、流式回复、停止、切换、草稿及布局，不要求无关操作。
- 当前没有格式化、lint、覆盖率目标或打包命令。

## Pi SDK 与模型

- Pi SDK 固定为 `1.4.0`；npm 别名为 `"@mariozechner/pi-coding-agent": "npm:@earendil-works/pi-coding-agent@1.4.0"`，源码保留原导入路径。升级依赖同步修改 `package.json` 与 `package-lock.json`。
- SDK 要求 Node.js 至少 `22.19.0`。初始化使用 `await ModelRuntime.create()`、`getModel()` 和 `createAgentSession({ modelRuntime, ... })`；不沿用旧版 `AuthStorage`、`authStorage` / `modelRegistry` 会话选项。
- `SessionManager.list(cwd, sessionDir)` 按目录筛选；侧栏和只读历史预览使用 `listAll(sessionDir)`，自动恢复仍校验实际目录与应用绑定，不认领其他目录的会话。
- 模型选择按会话持久化；恢复时尊重历史选择，不能总用启动默认覆盖。配置编辑、应用到当前会话、设置新会话默认是独立操作；隐藏配置不破坏旧会话快照。
- SDK 切换报错可能发生在状态已改变之后；失败后读取实际选择，并同步恢复登记。模型目录可读不代表推理权限或额度可用。页面不接收完整 SDK 对象或已存凭据。

## 数据与操作边界

- 会话始终绑定真实工作目录；文件审阅和保存读取实际会话目录。目录切换先准备新会话并保存目录，再替换旧会话；失败保留原会话。打开项目按目录与应用绑定恢复。
- Pi 未发送空会话不保证有历史文件。按原编号重建必须有可信空会话登记、原模型和目录；存在真实历史时优先原恢复，历史丢失不能冒充空会话，有待确认发送时禁止直接重建。
- 输入原文和主动清空按会话隔离；共享状态通过版本校验与串行更新合并，避免输入、模型登记、置顶和归档互相覆盖。生成期间仍允许保存输入。
- 只有明确未消费、且没有后续编辑时才恢复发送原文；未确认发送单独保留快照，不自动回填或重发。解除需用户二次确认；正常回复和主动停止不恢复旧输入。
- 切换会话/目录/模型、上下文整理、文件草稿操作及会话组织写操作共用主进程 `runIdleOperation` 互斥入口；停止、取消及输入保存不能被同锁阻塞。
- 正常关闭冻结新操作，等待原操作、发送收尾和输入协调，再通过 `flushAll()` 保存本页面所有已访问会话的待写输入，成功后才确认关闭；失败留窗并允许重试。退出期间阻止新开窗，取消退出后恢复。强制结束仅保证已确认落盘内容。
- 置顶仅影响所属项目或最近分组内排序，不改变消息活动时间。归档不删除、移动历史或清除输入、快照、模型、置顶及文件草稿；当前会话归档前保存输入并准备同目录候选，归档落盘后才切换。恢复/撤销不自动打开；启动及项目自动恢复跳过归档项。
- Pi 会话使用原生工具与默认工具选择；使用者已明确允许 read、bash、edit、write 直接读写文件和执行命令。工作目录是相对路径基准，不是访问隔离边界，不再以技能专用 read、32 KiB 或隐藏目录规则限制原生工具。已有草稿审阅/保存接口仍复核真实目录、边界、目标状态及 UTF-8 32 KiB 等旧约束；这些只适用于旧草稿流程。生成草稿与实际保存事实分开记录，不把旧草稿约束写成 Pi 通用要求。
- 工具开始与结束按 `toolCallId` 关联；展示内容使用安全文本或现有 Markdown 清理链路，不把工具内容作为 HTML 执行。
- 菜单信息与常驻上下文用量共用 `getSessionInfo()` 读取，保护会话/模型切换后的迟到响应；未知不显示为零，不新增模型请求或轮询。整理仅由用户主动触发，导出是当前上下文展示文本，不是完整原始历史备份。

## 页面与安全

- 界面以 `src/renderer/index.html`、`src/renderer/styles/codex-theme.css`、`src/renderer/components/page-shell.js` 为布局基线；先核对实际组件，再修改。参考 Codex 桌面布局，默认深色，设置中的独立主题只覆盖配色；保留侧栏、居中消息区、底部圆角输入和右下模型选择。
- 使用中性色、轻量边框、统一间距与 CSS 变量。消息独立滚动，流式回复跟随最新内容，用户上翻时保留位置并提供返回最新入口；窄窗允许折叠侧栏和审阅区。
- 按钮状态明确，保留键盘操作、可见焦点及输入法保护。Agent Markdown 使用本地依赖和现有白名单清理，其他内容优先 `textContent`；不随意引入框架。
- 保留上下文隔离和受限预加载，不暴露完整 Electron 或 Node.js 能力。新增接口只接受必要参数，由主进程校验路径与归属。
- 密钥不写入源码、日志或对话，不向页面回填已存凭据；供应商地址决定密钥发送目的地。不要提交 `.env`、`sessions/`、`node_modules/` 或本地验收文件，保持忽略规则有效。
- 项目内 `.env` 和会话目录属于开发阶段方案。打包发布时另行检查可写目录、数据迁移、密钥存储、正式应用名称与图标；页面标题与 macOS Dock 名称分开配置，不修改 Electron 依赖包实现改名。

## Pi 原生适配约定与任务（2026-11-03）

使用者已明确选择 Pi 原生工具与资源行为，必要时修改原有逻辑；本轮授权助手直接实施必要代码、测试和文档。此前 P2b 私有路径采集、拒绝技能链接、技能专用 read 等方案不再作为实施约束。旧阶段完成记录只说明当时状态，当前以下述代码和验收边界为准。

### 规范与实现基线

- 固定官方 `earendil-works/pi` 的 `v1.4.0`：[SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)、[配置](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md)、[Skills](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md)、[Extensions](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)、[Packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md)、[Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md)。签名以安装包公开导出和 `.d.ts` 为准，不深层导入未公开内部函数。
- 通过 `SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false })` 与 `DefaultResourceLoader` 使用官方配置、资源发现、过滤、冲突和诊断，不再自行采集技能路径。资源目录为 `getAgentDir()`，默认 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 覆盖。原 `<userData>/pi-resources` 不再作为运行入口；既有文件保留，未自动迁移或删除。
- 不传 `tools`/`customTools` 覆盖原生登记，默认 read/bash/edit/write；尊重 `defaultTools`、扩展工具及其原生参数。Pi 1.4.0 的 edit 使用 `edits[]`。旧文件草稿记录和待保存接口保留兼容，新 Agent 文件操作按实际工具结果直接落盘。
- 技能、模板、扩展、主题、上下文和包资源由官方 loader 发现；保留应用内置技能显式追加。独立 Markdown、符号链接、脚本/资产、`.pi`、个人和项目 `.agents/skills` 均遵循 Pi 自身发现规则与读取工具，不另行收窄格式。默认发现关闭项已撤回，不能再假设外部资源全部禁用。
- 项目信任顺序为：受保护资源检查 → 用户扩展 project_trust 首个 yes/no → 最近保存决定 → global defaultProjectTrust → 宿主询问。通过公开 `LoadExtensionsResult` 事件处理器和 `ProjectTrustStore` 适配；未公开导出的 CLI resolver 不深层导入。上下文文件按 Pi 规则不受此信任开关保护；信任与 cwd 都不是工具或扩展的隔离边界。
- 不覆盖原生系统提示词；保留 SYSTEM.md/APPEND_SYSTEM.md 的发现与优先级，通过公开 appendSystemPromptOverride 追加桌面结果说明和已有业务提示词。业务提示词快照继续按原会话保存，不改写使用者已存内容；其中若引用旧草稿工具，以当前实际工具为准。
- 通过公开工厂登记 codemode、tool-search、mcp 的 builtin 身份，保留禁用和第三方替换语义。bindExtensions 启动运行时，运行期 onError 与加载期诊断分别接通；非终端 SDK 模式使用 json/hasUI=false，不伪装 TUI 组件。扩展默认工具/事件/命令可接入，终端组件、完整命令会话控制仍须桌面适配，不宣称所有 TUI 扩展已兼容。
- 宿主通过官方 SDK 的显式 model/modelRuntime/sessionManager 参数保留模型管理、会话目录绑定与旧历史，不复制 CLI 的模型选择和会话发现。这是公开 SDK 的宿主覆盖，不另建资源格式。Pi 主题加载与 Electron 主题映射属于不同工作，未自动把终端主题转换为 CSS。

### 当前执行与后续验收

- [x] **原生资源与工具基础接入**：接通官方设置/发现、项目决定、默认工具与本地包配置；移除原技能专用读取及草稿工具允许名单。临时夹具验证独立 Markdown、链接技能、祖先 `.agents/skills` 与仓库边界、项目允许/拒绝、字段警告/缺描述、SYSTEM/APPEND/AGENTS、模板参数和技能命令展开、原生读写/命令，以及 defaultTools/retry。
- [x] **扩展基础生命周期与重载**：绑定 session_start、错误回调和 ctx.reload；宿主 `/reload` 经已有发送互斥调用官方 session.reload，不请求模型。会话切换和关闭显式等待 session_shutdown、设置 flush，再 dispose；正常关闭在输入保存后等待此清理，失败留窗。验证扩展工具、命令、重载与最终关闭顺序，以及本地 stdio MCP 连接、工具调用和子进程退出。
- [ ] **桌面交互与命令控制适配**：按公开 ExtensionUIContext/ExtensionCommandContextActions 接通所需对话框、通知、会话替换及工具展示；终端组件按官方 mode/hasUI 能力区分。验证扩展命令被消费或失败时不误报推理、会话替换后订阅和输入归属、迟到响应与中文输入法。
- [ ] **资源列表与包管理界面**：通过有限 IPC 展示官方登记结果和诊断，提供技能/模板选择；采用官方包管理 API 支持 npm/Git/本地来源和官方资源过滤。当前仅验证配置中的本地包加载，尚未完成交互安装、更新、删除、远程包及安装失败回滚，不把 pi-package 关键词作为加载必要条件。
- [ ] **真实桌面验收**：人工核对项目信任弹窗、自动技能选择的 read 证据、脚本执行、模板、原生文件修改、MCP 登录、切换/重载/关窗、停止及输入保存。离线检查未调用模型、未读取真实用户配置/会话，不代表供应商推理或系统窗口已验收。

已有 `docs/pi-skills-packages-plan.md` 为旧草案；与当前约定冲突的限制和 API 推断不作为实现依据。旧 `read-skill-file.mjs` 和旧信任适配若仍在工作区，不代表它们仍处于运行链路；不删除其他窗口或使用者保留的文件。

## 当前状态与剩余工作（2026-11-02）

已接通模型与供应商管理、会话模型记忆、工作目录与项目打开/重命名、Markdown/高亮、文件新建与修改草稿、整理与导出、输入自动保存与发送核对、未发送空会话找回、正常关闭保存、置顶与可撤销归档、上下文用量常驻入口；这些不再列为待实现。

原有功能待办：**无历史待确认发送的专用入口**。统一对话列表中的空会话条目目前展示阻塞原因并禁止重建；尚需专用查看与显式处理入口，不能绕过确认或自动重发。Pi 已改为上节所述原生资源、工具及扩展基础生命周期；桌面交互、包管理界面与真实模型验收仍按上节未完项推进。

验证边界：使用者已反馈完成模型记忆、文件草稿、整理/导出及正常关闭/重启必做场景；生成、整理、系统窗口及真实输入法组词中关闭未逐项反馈。置顶、归档、上下文用量及模型管理已有离线自动检查，不能据此宣称真实供应商登录、推理或全部系统场景已验收。其余工作区改动须按各自范围另行核验。

功能说明与验证入口：

- [模型与供应商管理](docs/model-management.md)
- [项目重命名](docs/project-renaming.md)
- [主题设置](docs/themes.md)
- [会话置顶](docs/session-pinning.md)与[归档恢复](docs/session-archiving.md)
- [上下文用量](docs/context-usage.md)
- [侧栏布局](docs/sidebar-layout.md)
- [关闭与重启验收](docs/window-close-acceptance.md)

历史步骤、测试明细和阶段候选见 Git 历史及 `docs/`；旧 `*-step.md` 中的“下一步”“尚未接入”仅代表当时状态，继续开发以实际源码及本节待办为准。这里只维护长期约定、当前未完项和必要验证边界，不再累积逐轮过程记录、临时目录与重复测试数字。

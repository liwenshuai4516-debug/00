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
- 文件工具复核真实目录、边界、隐藏/排除路径与目标状态。新建草稿允许空文件，限制 UTF-8 32 KiB、拒绝空字节，保存拒绝覆盖。生成草稿与实际保存事实分开记录；放弃草稿只移除待保存记录，不改工作文件。
- 工具开始与结束按 `toolCallId` 关联；展示内容使用安全文本或现有 Markdown 清理链路，不把工具内容作为 HTML 执行。
- 菜单信息与常驻上下文用量共用 `getSessionInfo()` 读取，保护会话/模型切换后的迟到响应；未知不显示为零，不新增模型请求或轮询。整理仅由用户主动触发，导出是当前上下文展示文本，不是完整原始历史备份。

## 页面与安全

- 界面以 `src/renderer/index.html`、`src/renderer/styles/codex-theme.css`、`src/renderer/components/page-shell.js` 为布局基线；先核对实际组件，再修改。参考 Codex 桌面布局，默认深色，设置中的独立主题只覆盖配色；保留侧栏、居中消息区、底部圆角输入和右下模型选择。
- 使用中性色、轻量边框、统一间距与 CSS 变量。消息独立滚动，流式回复跟随最新内容，用户上翻时保留位置并提供返回最新入口；窄窗允许折叠侧栏和审阅区。
- 按钮状态明确，保留键盘操作、可见焦点及输入法保护。Agent Markdown 使用本地依赖和现有白名单清理，其他内容优先 `textContent`；不随意引入框架。
- 保留上下文隔离和受限预加载，不暴露完整 Electron 或 Node.js 能力。新增接口只接受必要参数，由主进程校验路径与归属。
- 密钥不写入源码、日志或对话，不向页面回填已存凭据；供应商地址决定密钥发送目的地。不要提交 `.env`、`sessions/`、`node_modules/` 或本地验收文件，保持忽略规则有效。
- 项目内 `.env` 和会话目录属于开发阶段方案。打包发布时另行检查可写目录、数据迁移、密钥存储、正式应用名称与图标；页面标题与 macOS Dock 名称分开配置，不修改 Electron 依赖包实现改名。

## Pi 资源能力接入任务（2026-11-03）

本节按阶段记录接入进度，未勾选项不能据此认定能力已接通。使用者要求手动实现业务代码；助手只更新计划并提供带关键中文注释的建议代码，后续实施方式以使用者新指令为准。

### 规范与事实基线

- 规范固定为官方仓库 `earendil-works/pi` 的 `v1.4.0`，不混用旧包名对应的旧版 API 或主分支的新行为：[SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)、[Skills](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md)、[Prompt Templates](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/prompt-templates.md)、[Extensions](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)、[Packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md)、[Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md)。具体签名以当前安装包导出的 `.d.ts` 为准。
- Skill 与“技能”是同一能力，使用 Agent Skills 的 `SKILL.md` 格式；模板复用提示词，扩展执行代码并注册工具/命令/事件，Package 分发这些资源。保留 Electron + 原生 DOM + 进程内 SDK 架构。
- 当前 `pi-agent.mjs` 已传入 `DefaultResourceLoader`，五类默认资源加载仍关闭，已显式登记内置 `qa-skill-smoke`；使用 `SettingsManager.inMemory({}, { projectTrusted: false })`，不会自动读取 CLI 写入磁盘的包配置。工具为现有自定义名称的允许名单，未绑定扩展启动生命周期。
- `noSkills: true` / `noExtensions: true` 禁用相应默认发现结果，不阻止显式 `additionalSkillPaths` / `additionalExtensionPaths` 加载；这些开关也不能代替信任策略或保证完全不扫描外部目录。
- Pi 1.4.0 的默认系统提示词依赖活动 `read` / `bash` 工具展示技能目录；当前自定义读取工具不满足该条件。但 `session.prompt()` 仍能展开已登记技能的 `/skill:name` 命令，两者必须分别验收。
- 官方对部分非法技能字段只警告；缺少描述或无法解析等情况才跳过加载。同名技能保留首先发现者并产生诊断，不自行假设所有警告都会导致拒绝。
- 已有 `docs/pi-skills-packages-plan.md` 为待评审草案；执行顺序以本节为准。草案中“开关全关就绝不加载资源”“非法名称一律不加载”“包必须同时声明 pi 清单和 pi-package 关键词”等表述不能作为官方契约；`pi` 清单是可选资源声明，关键词用于包画廊发现。

### 依赖顺序与验收清单

- [x] **P0 最小技能闭环（第一步）**：已接入随应用提供的 `src/main/resources/skills/qa-skill-smoke/SKILL.md`，通过 `import.meta.url` 定位并显式登记，保留五类默认资源关闭项和 `projectTrusted: false`；内置资源诊断或缺失会明确中止初始化。技能设 `disable-model-invocation: true`，仅通过 `/skill:qa-skill-smoke` 显式调用，无脚本或外部参考文件。使用者反馈完成；已核对实际源码，并在隔离临时配置与会话中验证仅指定技能加载、项目技能/扩展夹具不加载、SDK 展开正文和参数、原工具允许名单保持不变，未请求模型。真实模型回复未逐项核对，不据此宣称自动匹配、外部资源或扩展已验收。
- [ ] **P1a 应用私有资源目录（下一步）**：在 `bootstrap.js` 的 `createConfiguredAgent` 中以第九个 `resourceOptions` 参数传入 `{ agentDir: path.join(app.getPath("userData"), "pi-resources") }`；`pi-agent.mjs` 检查绝对路径并创建目录，同时传给 loader 和 `createAgentSession`。旧调用未传此参数时沿用 `getAgentDir()`，便于现有独立初始化检查继续使用临时配置。保留当前内存设置、`projectTrusted: false`、显式内置技能和工具允许名单；SDK 会话继续接收已创建的 `modelRuntime`，不能因新增资源目录改变凭据来源。本步目录准备不代表已经加载私有 `settings.json`，也不代表完全停止 SDK 的外部目录探测。验证：私有目录可重复创建、相对路径/文件占位失败可见，旧调用与内置技能展开正常，模型及工作目录绑定保持不变。仅在临时副本验证建议代码，不代表工作区已实施。
- [ ] **P1b 配置来源与信任**：完成 P1a 后，再明确应用内置、用户显式选择及项目资源，使用官方 `SettingsManager` 的设置作用域；首次加入外部持久化设置时核验模型默认值、`sessionDir` 等影响，不能直接替换现有全部配置。接通 `resourceLoader.reload({ resolveProjectTrust })` 的信任决策，再允许项目 `.pi` / `.agents` 资源；显式路径不是项目信任的替代品。验证：未决定/拒绝信任时项目资源不加载，允许后仅目标项目生效；切换目录不继承错误信任，用户原 Pi 配置不被改写。
- [ ] **P2 自动匹配与配套资源读取**：先实现仅访问已启用技能资源的只读工具，复核真实路径、符号链接、文件类型、UTF-8、大小及取消；拒绝越界和凭据文件，不放宽工作目录工具的现有边界。随后解决当前工具名与 SDK 技能目录展示的兼容：优先评估具备受限文件读取实现的 `read` 工具；如采用宿主注入，则使用官方 `formatSkillsForPrompt(skills, "indirect")` 并明确真实读取工具，两种方案只落地一种，目录与 loader 登记保持同源、无重复注入。验证：上下文只含名称/描述/路径，正文按需读取；引用相对技能目录解析；越界和符号链接逃逸被拒绝；`disable-model-invocation` 技能不进入自动目录。真实模型是否选中技能单独人工验收，不能由离线目录断言代替。
- [ ] **P3 模板、列表与显式调用界面**：按官方 Markdown 模板和参数替换规则接入 Prompt Templates；经有限 IPC 返回技能/模板名称、描述、来源、状态与诊断，输入框增加选择及 `/` 补全。保持现有提示词快照、输入保存、未确认发送语义与输入法保护；未知命令、正文读取失败及无需模型的命令不能被误判成已接受的推理发送。验证：`/skill:name 参数` 与模板参数展开正确；同名、缺描述、加载错误可见；切换会话后迟到列表不覆盖新会话；键盘和中文组词可用。
- [ ] **P4 扩展工具、生命周期与桌面适配**：首批加载经核对的应用扩展，使用官方 `registerTool` / `registerCommand` / `pi.on`。同时接入加载期 `getExtensions().errors` 与运行期 `bindExtensions({ onError, ... })`，不能以 `onError` 代替加载诊断；工具选择须允许已批准扩展工具，并继续禁用未经授权的内置 `bash/edit/write`。适配可支持的 `ExtensionUIContext` 和命令操作，其余明确显示不兼容，不把 TUI 组件当作 DOM。长连接在 `session_start` 启动；核对 SDK 的实际关闭 API，确保切换/关闭/重载发出 `session_shutdown`、等待清理后再 dispose，不能假设 `dispose()` 会代发该事件。验证：工具登记、启用、调用分别通过；启动与清理次数正确，工厂抛错/事件抛错可见；切换失败保留原会话，旧上下文失效。
- [ ] **P5 Pi Package 安装与资源管理**：按官方普通目录约定或可选 `package.json.pi` 清单识别资源，复用官方包管理 API 和资源过滤语义，不另建包格式。接通 npm/Git/本地来源，明确安装、登记、启用、停用、更新与移除的区别；应用策略优先固定版本/ref，不把“必须固定”说成官方通用要求。宿主提供的依赖遵循官方 `peerDependencies` 约定，并核验本项目 npm 别名下的模块解析。安装工具链与生命周期脚本可能执行代码，应在加载扩展前完成来源决策，不能声称“未启用扩展就没有安装期代码执行”。验证：本地夹具覆盖资源过滤、同名包去重、缺依赖/离线失败、版本与更新、移除后资源消失；不靠关键词拒绝合法普通目录包，不混入模型配置和凭据。
- [ ] **P6 空闲应用与回归交付**：第一步资源变更在重新创建会话时生效；后续增加显式“应用到当前会话”，经 `runIdleOperation` 调用 `session.reload()` 并刷新工具、技能目录、列表和诊断，不能只重载 loader。安装/卸载/启停等修改资源状态的操作也与会话操作协调；停止、取消、输入保存保持可用。验证：生成期间互斥、失败后读取并呈现实际状态、关闭保存、模型记忆、会话/目录切换和文件草稿流程不退化；自动、离线页面、真实模型验收分别记录。每阶段仅运行相关检查，通过后再推进并勾选。

MCP、codemode、tool_search 在 Pi 1.4.0 中有官方扩展工厂，但本轮不默认启用；有明确业务需求时追加任务并核验工厂、工具启用及 `bindExtensions()`。Pi Themes 面向其 TUI，桌面现有配色体系另行管理。扩展与宿主同权限，项目信任和工具白名单均不是扩展代码的系统隔离边界；第三方扩展若需隔离执行，另行设计进程/操作系统边界。

## 当前状态与剩余工作（2026-11-02）

已接通模型与供应商管理、会话模型记忆、工作目录与项目打开/重命名、Markdown/高亮、文件新建与修改草稿、整理与导出、输入自动保存与发送核对、未发送空会话找回、正常关闭保存、置顶与可撤销归档、上下文用量常驻入口；这些不再列为待实现。

原有功能待办：**无历史待确认发送的专用入口**。统一对话列表中的空会话条目目前展示阻塞原因并禁止重建；尚需专用查看与显式处理入口，不能绕过确认或自动重发。Pi 资源能力接入已完成上节 P0，其余阶段尚未实施。

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

# Pi 1.4.0 原生接入

资源与工具优先遵循固定版本的 [Pi SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)。Electron 继续负责模型选择、会话绑定、输入保存和窗口交互。

## 资源位置

运行入口使用官方 `getAgentDir()`：默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定。设置、信任记录和内置 MCP 使用同一目录。旧 `<userData>/pi-resources` 内容保留，未自动搬迁；已有资源需要放入所选的官方目录。

由 `SettingsManager.create` 和 `DefaultResourceLoader` 处理：

- 用户 `settings.json` 中的资源路径、过滤和 `packages`。
- 用户与受信任项目的技能、模板、扩展、主题。
- 个人和项目 `.agents/skills`，包括官方祖先目录及仓库边界规则。
- `SYSTEM.md`、`APPEND_SYSTEM.md` 与上下文文件。

技能保留官方独立 Markdown、便携 `SKILL.md` 目录与链接支持；参考文件、脚本和资产按实际 Pi 工具使用。警告、冲突与加载失败通过主进程诊断提示，名称冲突遵循官方先发现者保留规则。应用内置技能通过显式路径追加，不抢占其他来源的名称。

## 当前项目的需求评审技能

本仓库的 `.pi/skills/qa-requirement-review/SKILL.md` 与 `references/checklist.md` 提供需求评审能力，随仓库版本管理。项目资源由 Pi 官方 loader 按实际会话工作目录和项目信任决定加载。

在应用中打开本仓库目录，允许项目信任并新建会话；已有受信任会话编辑技能后发送 `/reload`。在“设置 → 技能与扩展包”确认 `qa-requirement-review` 已加载，然后发送：

```text
/skill:qa-requirement-review 请评审以下需求：用户可上传文件，上传成功后显示结果。
```

应读取技能参考清单，将文件类型、大小与失败处理等未规定内容列为待确认项，新增验收条件标为建议。项目技能的发现、信任拒绝、参考文件读取和命令展开通过临时目录离线检查；实际模型是否自动选择并正确完成评审仍需单独验收。

## 工具与文件状态

不传入自定义工具允许名单或替代 read。默认启用 read、bash、edit、write，尊重 `defaultTools`；扩展工具也遵循 Pi 登记及启用语义。edit 的参数为 `path` 和 `edits: [{ oldText, newText }]`。

原生 edit/write 和命令可直接改动文件，成功后不再等待草稿保存。工作目录是相对路径基准，不限制绝对路径或命令的访问范围。旧草稿的存储、审阅和历史记录仍可使用，其限制不适用于原生工具。

模型与凭据仍由现有模型服务通过 SDK 的 model/modelRuntime 显式提供；会话仍通过 sessionManager 使用应用的真实目录绑定与历史。Pi 设置中的模型或会话默认值不会覆盖这些宿主显式参数。

## 信任与扩展

项目信任按官方顺序处理：用户扩展 project_trust 事件、最近保存的目录决定、全局默认策略、桌面确认。拒绝时由官方 loader 跳过受保护的项目资源；上下文文件不属于此保护范围。信任不会限制工具、扩展或安装器的进程权限。

内置 codemode、tool-search 和 MCP 通过公开工厂登记，支持其官方 builtin 配置和替换行为。会话调用 bindExtensions 启动运行时；切换或关闭时等待 session_shutdown 与设置保存后再 dispose。输入保存失败或会话清理失败时保留窗口。

`/reload` 调用官方 session.reload，不请求模型，并与聊天发送及其他主进程操作互斥。扩展 ctx.reload 接入同一重载函数。加载诊断和运行事件错误分别报告。

桌面通过 `bindExtensions({ mode: "rpc", uiContext, commandContextActions })` 绑定，`hasUI=true`；无界面检查仍使用 json/hasUI=false。选择、确认、输入支持信号取消和超时，多行编辑支持预填；通知、状态、字符串数组组件、标题、编辑器正文与工具展开接入页面。正文等输入绑定完成且组词结束后经原保存链路应用，页面销毁/重载会结束等待，迟到响应不再消费。

继承官方默认非 TUI UI context；自定义终端组件返回 undefined，终端编辑器、输入监听、页眉页脚、工作指示器与主题切换等不支持的方法维持官方非 TUI 行为。Pi 终端主题不会自动转换为 CSS。不要仅凭 hasUI 判断 TUI 组件可用，应结合 mode。

`waitForIdle/newSession/fork/navigateTree/switchSession/reload` 通过公开 SDK 执行。`AgentSessionRuntime` 负责真实会话替换和 withSession；宿主重绑事件、输入与停止目标，仍检查应用历史归属和归档状态。官方替换先释放旧会话；创建失败明确提示重新打开，setup/withSession 在替换后失败时继续跟随实际新对象，不虚构回滚。显式 display=true 的扩展自定义消息按纯文本展示并恢复。

## 包管理

设置 → 技能与扩展包，展示当前会话资源及诊断。技能/模板按钮只把官方命令插入输入框，供使用者检查后发送。

通过公开 `DefaultPackageManager` 执行 npm、Git、本地来源的安装、更新、移除和更新检查；本地包按标准目录或可选 pi 清单发现，不要求 pi-package 关键词。个人与项目范围由官方设置保存，项目范围需先信任。资源筛选直接使用官方 `extensions/skills/prompts/themes` 字符串数组和 `autoload` 布尔值；空数组禁用该类资源，空对象恢复默认发现。

安装/筛选/更新后显式重载才应用到当前会话，不自动激活新扩展。`update(source)` 的实际范围遵循官方 API，同一来源同时配置在个人与项目时可能一并更新；范围选择不是更新隔离。安装器可能执行代码；SDK 没有取消或事务回滚契约，失败会明确提示核对磁盘与登记，不承诺还原。

## 本轮验收（2026-11-03）

| 类型 | 实际结果 | 边界 |
| --- | --- | --- |
| 单元与真实 SDK 临时夹具 | 616 项通过，无失败或跳过 | 不请求模型；覆盖 RPC bridge 来源校验、取消、会话替换及替换后失败、包范围/筛选、关闭和原有功能 |
| Electron 组件与设置集成 | `pi-desktop.check.cjs` 16 项通过，含 1280/390 宽度截图 | 真实 SDK/IPC/预加载/DOM 组件；会话及包为临时夹具，组词用事件模拟 |
| 既有页面回归 | 主题 43、模型 23、项目重命名 16、归档 17、置顶 19、上下文 19、关闭 14、未发送会话 18 项通过 | 模拟业务接口；补齐新 bridge，并修正旧分类数量与未发送项选择器 |
| 真实模型 | 应用默认 `deepseek/deepseek-flash`：流式短答、技能选择并 read → write → edit → bash、文件最终内容、主动停止及子进程退出均通过 | 复用已有认证，仅临时资源/工作目录/历史；没有切换模型或更改凭据，不代表所有供应商、登录和额度均可用 |
| 真实远程 Git | 本仓库固定 ref 安装登记 → 解析 → 更新 → 检查更新 → 移除登记通过，固定 ref 未移动 | 来源见下；该 ref 包资源均为 0，不把个人技能算入远程资源，不代表远程扩展功能或公共 npm 注册表已验收 |
| 原生扩展交互 | 实际选择乙、确认、输入中文文本、多行编辑完成；手动分支 15 项通过 | 该轮中文文本使用粘贴；真实输入法另按下一行记录，余下检查仍由脚本断言 |
| 真实输入法与系统关窗 | 使用者手动拼音输入“中文关窗验收”，真实事件捕获 3 次组词开始/结束；系统关窗后原文恢复。扩展输入框组词确认回车未提交，组词中关窗完成取消、无待确认发送、扩展清理已完成 | 该轮共 5 次组词开始/结束、1 次组词中回车、1 次组词中关闭，期间 submit 为 0；早期夹具因固定要求拒绝/允许顺序而报错，不能把整轮日志标为通过。修正后独立复跑系统脚本通过，捕获 2 次真实组词、1 次回车、1 次关窗 |
| 原生项目信任 | 不信任且不记住 → 项目扩展未加载 → 新建对话重新询问 → 信任并记住 → 项目扩展加载 → 关窗恢复不再询问，通过 | 最终独立系统脚本通过，报告同时记录 allowed/rejected；仅临时目录，不改变用户真实项目的信任 |
| 剩余系统场景 | MCP 真实登录尚缺目标服务地址；主消息框组词中关闭、真实推理或整理中系统退出未逐项验收 | 本地 stdio、模拟事件和扩展输入框组词中关闭均不能替代这些场景 |

真实 Git 来源取自 AGENTS.md：

```text
git:git@github.com:liwenshuai4516-debug/00.git@c4f570dc00c1a7aa56989316047fcdc868c3f4a4
```

使用 `ResolvedResource.metadata.origin/source` 统计该包资源；`resolve()` 还会包含顶层个人资源，不能直接累计全部结果。

真实模型最终一轮：短答 4 段文本增量（约 1.8 秒），技能与四个原生工具完成（约 4.7 秒），工具等待时经应用停止入口中止（约 1.8 秒），PID 已不存在。脚本只保存模型标识、步骤、计数和状态，不保存密钥、供应商请求或真实聊天内容。正常中止由应用发送服务识别，不能仅把 SDK 中止异常算作请求失败。

验收中另修复凭据状态缓存竞态：配置安装改用 `getAuth(model)` 实际读取认证，避免后台目录刷新合并后 `hasConfiguredAuth` 误报登录/注销状态。扩展消息不再被旧草稿类型名单隐藏。文档内资源设置截图仍来自离线 Electron 页面，不是原生系统验收截图。本轮补充验收通过原生桌面控制与真实 DOM 事件记录完成；未发现需要修改生产逻辑的问题。

可复现入口：

```bash
NODE_OPTIONS="--require $PWD/tests/helpers/pi-test-isolation.cjs" npm test
PI_UI_ARTIFACT_DIR=/tmp/pi-desktop-ui node_modules/.bin/electron tests/ui/pi-desktop.check.cjs
# 以下只在明确授权远程安装/真实推理后执行，不属于 npm test。
NODE_OPTIONS="--require $PWD/tests/helpers/pi-test-isolation.cjs" node scripts/verify-pi-remote.mjs 'git:git@github.com:liwenshuai4516-debug/00.git@c4f570dc00c1a7aa56989316047fcdc868c3f4a4'
node_modules/.bin/electron scripts/verify-pi-live.cjs
# 原生交互验收，无模型请求；请按可见窗口及控制台提示操作。
PI_ACCEPTANCE_REPORT=/tmp/pi-system-report.json node_modules/.bin/electron scripts/verify-pi-system.cjs
```

原生点击辅助模式：`PI_UI_MANUAL_SELECT=1` 运行上述桌面检查，依次选择“乙”、确认、输入“中文验收”，再将多行编辑改为“中文第一行”和“第二行”并确认。报告只记录组词次数，文本相等不能证明使用了输入法。

系统脚本先显示“开始验收”。可先拒绝且不记住，核对扩展状态未出现，再新建对话允许并记住。输入“中文关窗验收”，使用系统关闭按钮；恢复后核对原文，再发送 `/system-wait`，在扩展输入框组词时按回车，核对弹框仍在，再次组词并关闭系统窗口。脚本复核草稿、待确认发送及扩展清理，报告按实际事件和信任选择记录覆盖范围；计数为零的场景不算执行过。验收模型菜单、项目列表为临时夹具，其余使用生产 renderer、IPC、发送、输入保存及关闭链路；临时 recorder 为加载生产 preload 关闭了测试窗口的 preload sandbox，生产设置没有变更。不发模型请求，不读取真实凭据或聊天。

真实模型脚本默认用应用新会话默认选择；当前应用未运行，未读取旧历史猜测最后使用模型。可用 `PI_ACCEPTANCE_REPORT` 指定本地结果文件，报告不要包含真实配置与历史。

截图：[桌面资源设置](images/pi-resources.png)、[窄窗资源设置](images/pi-resources-narrow.png)。

## 工作区复核（2026-11-03）

本次按已安装的官方 1.4.0 随包文档与公开声明复核会话创建、资源加载、工具选择、信任顺序及扩展生命周期。运行入口没有旧 `AuthStorage`、私有资源扫描、技能专用 read 或草稿工具允许名单；无引用的旧技能读取与旧信任模块已移除，旧接入计划已废止。

提示词设置保存的是应用追加的测试职责，并按会话保留快照；不替代 Pi 原生系统提示词、SYSTEM.md、APPEND_SYSTEM.md 或资源发现。界面内置的测试任务模板只写入待发送输入，不替代 Pi 官方提示词模板。旧草稿的服务、历史展示与对应测试继续保留，原生 Agent 不注册这组工具。

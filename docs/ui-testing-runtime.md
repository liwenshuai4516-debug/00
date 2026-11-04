# 客户端内置 UI 测试

Agent 使用官方 Playwright Test MCP 录制真实页面，再用内置执行器调用官方 CLI。支持项目识别、按配置自动登录及必要时可见窗口接管、多文件/多测试批次、原生 JSON/HTML、统一摘要与版本、证据清单。被测工作目录不需要自行安装 Node、Playwright 或浏览器。

## 代码分工

| 位置 | 职责 |
| --- | --- |
| `src/main/capabilities/ui-testing/extension.mjs` | `qa_ui_project`、`qa_ui_login`、`qa_ui_prepare`、`qa_ui_finalize`、官方 MCP 登记和日志保存 |
| 同目录 `project-context.mjs` | 项目地址匹配、输入冲突检查、当前工作区数据目录与命名 |
| 同目录 `login-session.mjs` | 私有登录目录、登录子进程和会话关闭清理 |
| 同目录 `runtime-paths.js` | 开发和发布资源定位 |
| `resources/testing/ui/login.cjs` | 独立可见 Chromium、登录判断/自动登录/人工接管、私有 storageState 导出 |
| `resources/testing/ui/run.cjs` | 批次执行、取消、清理、摘要与清单 |
| `resources/testing/ui/playwright.config.cjs` | 单 worker、零重试、报告和证据策略 |
| `resources/testing/ui/skills/qa-ui-basic/SKILL.md` | 录制、断言来源及批次交付操作约定 |
| `tooling/testing/ui/prepare-runtime.cjs` | 准备当前平台的内置 Node、Playwright 及匹配浏览器 |

通过 Pi 1.4.0 的官方资源加载器登记一次 `builtin:desktop-ui-testing`；允许禁用或替换，不覆盖原生工具或添加关键词路由。开发资源在 `resources/testing/ui`；发布读取 `process.resourcesPath/testing/ui`。Node、浏览器、node_modules 和运行证据不提交。打包后需完整复制对应平台资源；本次没有进行安装包验收。

## 当前七步流程（2026-11-04）

在被测工作目录会话选择 `/skill:qa-ui-basic`，提供目标 URL、角色、操作范围和有来源的预期。这个 Skill 是 Agent 的操作规程，登录及资产准备的关键条件同时由工具检查；没有另建绕过 Pi 的宿主关键词路由或通用流程引擎。

| 步骤 | 实际行为与完成条件 |
| --- | --- |
| 1. 工作区检查 | 使用当前会话 cwd，真实路径、目录边界与写入探针通过后准备 qa/data；没有工作区则先选择，不自动用安装目录 |
| 2. 项目和前置数据检查 | qa_ui_project 将 URL、可选 projectId/projectName 与本机配置比对，只返回脱敏项目上下文；Agent 核验相关业务输入、初态、角色和预期来源 |
| 3. 判断登录 | qa_ui_login(action=auto, projectRef) 检查表单，按需使用配置凭据登录一次；公开页面返回 not-required，认证成功返回 saved，异常返回 manual-required |
| 4. 真实录制 | qa_ui_prepare(mode=record, projectRef, targetUrl) 继承该项目登录态；真实官方 MCP 快照、操作、生成日志及写脚本，结束关闭页面 |
| 5. 整理与持久化 | Agent 根据日志整理稳定定位器、独立 test 和业务断言，保存用例说明；qa_ui_finalize 检查语法、真实日志、说明及密码误写，并保存 .asset.json |
| 6. 独立回放 | qa_ui_prepare(mode=run, projectRef, targetUrl, caseId) 验证资产登记哈希，执行返回命令；在新浏览器上下文回放，并清理私有登录态 |
| 7. 输出结果 | 原生 JSON/HTML 加 summary.json/summary.md/manifest.json，明确逐例结果、原始失败、版本/来源、清理和未覆盖范围 |

项目配置仍使用客户端源码根目录的 `config/projects.local.json`，不复制到被测工作区。配置位置与手工编辑约定见 [项目前置数据](project-data.md)。账号密码由后端及独立登录进程使用，不返回模型，不写脚本或报告；不要让 Agent 用原生 read/bash 读取真实配置。目录/地址就绪不表示业务前置数据已正确，返回的 businessDataStatus=not-validated 明示这个边界。

例如，用户给出 `http://192.168.90.224:8238/pms/OperationContract`，若已配置项目地址为同 origin 的根路径，就匹配该项目；协议、端口或主机不同则不匹配。路径按完整段边界匹配，最长范围优先；多个同等候选必须给 projectId，用户名称冲突也停止，不能随意选择账号。当前实现不会用工作区名称猜目标系统。

项目目录和测试存储目录分别处理：目标项目可登记其他工作目录，本次产物仍写当前会话工作区。新脚本使用 `qa/data/ui/cases/项目名称__页面路径__短摘要.spec.cjs`，同名重复录制自动增加版本；路由 hash 纳入路径命名，查询参数保留在任务 URL、不作为目录名。中文及文件长度做路径处理，旧资产不会被覆盖。

qa_ui_finalize 检查的是脚本语法、来源登记与持久化，不是业务设计批准，也不是自动格式化器；排版和断言整理由 Agent 根据 Skill 执行。新项目回放要求同目录 .asset.json 与当前脚本哈希一致。准备回放后修改脚本会被执行器拒绝，不自动修复再跑。

自动登录默认识别唯一的账号、密码及登录按钮，可用 selectors.account/password/submit/authenticated 提供实际页面定位器；应优先提供明确的登录后角色或页面标识。默认检查目标路由可达且登录表单消失，不足以证明角色权限，录制前仍需通过页面核验。自动登录同 origin 内执行一次，验证码/MFA、跨域认证、无法确定的表单或失败会保留可见窗口并返回具体受阻原因，不重复提交。用户解决后 complete 即可交接；本次已授权的自动流程不再次询问私有状态保存。纯手动 start/complete 保留原确认方式。

旧资产可省略 projectRef，沿用 qa/ui/cases 的单文件或多文件入口，不做迁移。本次新录制流程必须走项目检查和资产登记。一个脚本可以有多个 test，同一页面的多份脚本可用 caseIds 组成批次，不能与 caseId 同时提供。

正式回放命令使用原生 bash，批次上限 600 秒，timeout 可用 660 秒留出收尾。录制准备不返回可执行命令，不使用关闭报告器的 MCP test_run 代替官方 CLI。已授权录制和回放不逐阶段重复确认；只有事实缺失、冲突或认证受阻才暂停依赖步骤。

登录态按目标 origin 交接，保存适用 cookie 和该 origin 的 localStorage/IndexedDB，不支持 sessionStorage 或其他 origin 的状态。工具只确认已保存，实际身份、有效期和权限由页面前置断言验证。SSO 登录须回到目标 origin 再保存。URL 不允许内嵌账号密码。

临时目录在系统临时目录下 `qa-ui-auth-*`，目录权限 0700、状态文件 0600，不进入项目证据。绑定信息仅在本地任务内部使用，不返回状态内容。拒绝保存、显式 cancel、正常会话关闭/重载均回收；回放成功、失败、正常取消都删除，摘要记录 deleted/not-needed/failed。失败清理不能判批次通过。强制杀死、系统崩溃/断电无法保证收尾；会话仍在时可用 loginId cancel，已丢失会话需核对该临时目录，不承诺自动恢复或跨会话复用。

## 批次产物与判断

新项目资产在 `qa/data/ui/cases/`，旧资产仍在 `qa/ui/cases/`，录制日志在 `qa/ui/recordings/<id>/`；每次回放写独立的 `qa/ui/runs/<id>/`，独占标记禁止同一任务重复执行。

| 产物 | 内容 |
| --- | --- |
| `task.json` | 所选脚本、准备时哈希、运行状态和路径；执行收尾移除私有状态路径 |
| `results.json`、`html/` | 官方原生结果与 HTML，不重写失败或统计 |
| `summary.json`、`summary.md` | 批次范围、起止时间、退出码、逐例状态/耗时/错误/证据、清理状态和版本 |
| `sources/` | 执行前所选脚本、用例说明、资产索引、配置及执行器副本 |
| `project-context.json` | 项目名称/编号、地址、工作区和本次范围，不含凭据 |
| `manifest.json` | 证据相对路径、大小与 SHA-256；不包含私有登录态、task 或清单自身 |
| `stdout.log`、`stderr.log`、`artifacts/` | 原生进程输出和原生附件 |

准备 run 时记录脚本 SHA-256，执行前拒绝变更，执行后复核脚本、用例说明、资产索引、配置、执行器；版本记录包括实际 Node/Playwright。它不是依赖锁定或整个导入依赖闭包的快照，被测系统部署版本仍为未知。

只有原生报告完整、所选文件均有测试结果、至少一条测试、全部实际 passed、命令成功且无原生错误/附件缺失/版本变化/清理问题，批次才为 passed。保留 failed、flaky、skipped、expected-failure、cancelled、not-run 等状态；缺少报告为 incomplete，测试数为 null，不当成零测试通过。取消不冒充断言失败。失败根因需依据业务来源另行判断，不能由断言失败直接推定产品缺陷。

未使用私有登录态时 trace 保留步骤，关闭 DOM、网络快照和源码。**带登录态的录制及回放关闭 trace**：Playwright trace 的 context-options 会保存 storageState 内容，仅关闭网络快照不足以避免归档凭据。仍提供原生 JSON/HTML 和失败截图，摘要通过 tracePolicy 明示该限制；测试错误、截图及业务日志仍需按业务数据管理。登录过程不产生录制证据。

旧的根级 npm 脚本入口指向不存在的执行器，已移除；旧 `config/` 测试配置同步删除。当前唯一准备入口是内置工具及返回的批次命令。POSIX shell 已验证，Windows 命令适配尚未验证。

## 验证（2026-11-04）

命令：`node --test tests/unit/ui-project-context.test.js tests/unit/ui-testing-runtime.test.js`。浏览器项依赖已准备的内置环境，缺失时明确跳过。全部在临时目录和本地 HTTP 页面进行，不请求模型、不访问真实业务站点、不读取用户认证。

- 真实 Pi SDK 下无运行环境、启用、官方禁用的工具/技能登记。
- 真实 Pi SDK 中项目匹配、后端使用模拟账号自动登录（无 UI 确认接管）、可见官方 MCP 页面准备/点击/生成日志/写脚本、语法和资产登记、独立回放、私有状态删除，原生报告通过且不再次提交登录。
- 不同主机/协议/端口、最长路径、同范围歧义、工作区内写入、目录越界链接与同名文件、配置更新和中文长文件名。
- 公开页面无需账号、验证码不提交、失败只提交一次、清理及工作区切换阻断；缺少资产登记不能回放。
- 路径含中文、空格、单引号；目标脚本过滤排除 seed/其他文件；单文件通过与失败、新旧批次隔离、原生 HTML/trace/失败截图。
- 独立可见登录窗口；临时页面模拟已登录状态，核对私有权限、cookie/localStorage 在新上下文中生效；拒绝保存、显式取消、会话关闭均删除，回收浏览器临时资料。
- 两文件四测试准确汇总 2 通过、1 失败、1 跳过；清单逐项哈希复核且无模拟认证值、无登录 trace；重复执行拒绝、所选空脚本不判通过；脚本准备后变更记 incomplete；执行中 SIGTERM 取消仍生成摘要、删除私有状态。

本轮项目识别、UI 运行时及原有项目数据检查共 17 项通过。验证包含无人工确认的自动登录→官方录制→登记→回放，但没有读取真实 projects.local.json、没有登录用户提供的业务地址。

这些是自动集成检查。临时站点验证模拟账号密码，不替代真实项目账号有效性、用户输入验证码、SSO、外部站点真实角色、Electron 自然语言技能选择或打包后的人工验收。2026-11-03 的历史业务回放仍为 5 通过、1 失败，不因能力补足改写结论。

# 客户端内置 UI 测试

Agent 使用官方 Playwright Test MCP 录制真实页面，再用内置执行器调用官方 CLI。支持可见窗口手动登录、多文件/多测试批次、原生 JSON/HTML、统一摘要与版本、证据清单。被测工作目录不需要自行安装 Node、Playwright 或浏览器。

## 代码分工

| 位置 | 职责 |
| --- | --- |
| `src/main/capabilities/ui-testing/extension.mjs` | `qa_ui_login`、`qa_ui_prepare`、官方 MCP 登记和日志保存 |
| 同目录 `login-session.mjs` | 私有登录目录、登录子进程和会话关闭清理 |
| 同目录 `runtime-paths.js` | 开发和发布资源定位 |
| `resources/testing/ui/login.cjs` | 独立可见 Chromium、人工登录、公开 storageState 导出 |
| `resources/testing/ui/run.cjs` | 批次执行、取消、清理、摘要与清单 |
| `resources/testing/ui/playwright.config.cjs` | 单 worker、零重试、报告和证据策略 |
| `resources/testing/ui/skills/qa-ui-basic/SKILL.md` | 录制、断言来源及批次交付操作约定 |
| `tooling/testing/ui/prepare-runtime.cjs` | 准备当前平台的内置 Node、Playwright 及匹配浏览器 |

通过 Pi 1.4.0 的官方资源加载器登记一次 `builtin:desktop-ui-testing`；允许禁用或替换，不覆盖原生工具或添加关键词路由。开发资源在 `resources/testing/ui`；发布读取 `process.resourcesPath/testing/ui`。Node、浏览器、node_modules 和运行证据不提交。打包后需完整复制对应平台资源；本次没有进行安装包验收。

## 操作链路

在被测工作目录会话选择 `/skill:qa-ui-basic`，给出目标 URL、角色、范围、步骤和预期来源。

1. 需要登录时调用 `qa_ui_login({action:"start",targetUrl})`。用户在独立可见窗口操作，登录期间不启用 trace、截图或生成日志。用户完成后调用 `complete` 并传返回的 loginId，宿主确认后私有保存；不要在聊天中收集密码。
2. 调用 `qa_ui_prepare({mode:"record",caseId,targetUrl,loginId,headed:true})`。无需登录可省略 loginId，可见录制选项也可省略。使用真实官方工具录制，`generator_write_test.fileName` 必须使用返回的相对 `caseFileName`。一个文件可有多个独立 test，多份资产按不同 caseId 录制。
3. 读取真实生成日志，保存带来源的业务断言和 case 文档，调用 `browser_close` 关闭录制页面。
4. 重新调用 `qa_ui_prepare({mode:"run",caseIds:["search","detail"],targetUrl,loginId})`。单文件可用 caseId，不能同时给两种参数。登录态绑定本批次后不能再次分配。
5. 执行返回的 replayCommand；批次上限 600 秒，bash timeout 可用 660 秒留出收尾时间。录制准备不返回可执行命令。正式执行不使用 MCP `test_run`，以保留官方报告器。
6. 读取统一摘要和原生结果，交付原始失败证据与清理状态。不要为了通过修改脚本后自动重跑；重新准备才能生成新的独立批次。

登录态按目标 origin 交接，保存适用 cookie 和该 origin 的 localStorage/IndexedDB，不支持 sessionStorage 或其他 origin 的状态。工具只确认已保存，实际身份、有效期和权限由页面前置断言验证。SSO 登录须回到目标 origin 再保存。URL 不允许内嵌账号密码。

临时目录在系统临时目录下 `qa-ui-auth-*`，目录权限 0700、状态文件 0600，不进入项目证据。绑定信息仅在本地任务内部使用，不返回状态内容。拒绝保存、显式 cancel、正常会话关闭/重载均回收；回放成功、失败、正常取消都删除，摘要记录 deleted/not-needed/failed。失败清理不能判批次通过。强制杀死、系统崩溃/断电无法保证收尾；会话仍在时可用 loginId cancel，已丢失会话需核对该临时目录，不承诺自动恢复或跨会话复用。

## 批次产物与判断

资产在 `qa/ui/cases/`，录制日志在 `qa/ui/recordings/<id>/`；每次回放写独立的 `qa/ui/runs/<id>/`，独占标记禁止同一任务重复执行。

| 产物 | 内容 |
| --- | --- |
| `task.json` | 所选脚本、准备时哈希、运行状态和路径；执行收尾移除私有状态路径 |
| `results.json`、`html/` | 官方原生结果与 HTML，不重写失败或统计 |
| `summary.json`、`summary.md` | 批次范围、起止时间、退出码、逐例状态/耗时/错误/证据、清理状态和版本 |
| `sources/` | 执行前所选脚本、配置及执行器副本 |
| `manifest.json` | 证据相对路径、大小与 SHA-256；不包含私有登录态、task 或清单自身 |
| `stdout.log`、`stderr.log`、`artifacts/` | 原生进程输出和原生附件 |

准备 run 时记录脚本 SHA-256，执行前拒绝变更，执行后复核脚本、配置、执行器；版本记录包括实际 Node/Playwright。它不是依赖锁定或整个导入依赖闭包的快照，被测系统部署版本仍为未知。

只有原生报告完整、所选文件均有测试结果、至少一条测试、全部实际 passed、命令成功且无原生错误/附件缺失/版本变化/清理问题，批次才为 passed。保留 failed、flaky、skipped、expected-failure、cancelled、not-run 等状态；缺少报告为 incomplete，测试数为 null，不当成零测试通过。取消不冒充断言失败。失败根因需依据业务来源另行判断，不能由断言失败直接推定产品缺陷。

未使用私有登录态时 trace 保留步骤，关闭 DOM、网络快照和源码。**带登录态的录制及回放关闭 trace**：Playwright trace 的 context-options 会保存 storageState 内容，仅关闭网络快照不足以避免归档凭据。仍提供原生 JSON/HTML 和失败截图，摘要通过 tracePolicy 明示该限制；测试错误、截图及业务日志仍需按业务数据管理。登录过程不产生录制证据。

旧的根级 npm 脚本入口指向不存在的执行器，已移除；旧 `config/` 测试配置同步删除。当前唯一准备入口是内置工具及返回的批次命令。POSIX shell 已验证，Windows 命令适配尚未验证。

## 本轮验证（2026-11-03）

命令：`node --test tests/unit/ui-testing-runtime.test.js`。浏览器项依赖已准备的内置环境，缺失时明确跳过。全部在临时目录和本地 HTTP 页面进行，不请求模型、不访问真实业务站点、不读取用户认证。

- 真实 Pi SDK 下无运行环境、启用、官方禁用的工具/技能登记。
- 真实 Pi UI 确认适配、可见窗口模拟登录、登录态交给可见官方 MCP 页面准备、点击、生成日志、脚本生成、关闭页面及正式回放，最终删除私有状态。
- 路径含中文、空格、单引号；目标脚本过滤排除 seed/其他文件；单文件通过与失败、新旧批次隔离、原生 HTML/trace/失败截图。
- 独立可见登录窗口；临时页面模拟已登录状态，核对私有权限、cookie/localStorage 在新上下文中生效；拒绝保存、显式取消、会话关闭均删除，回收浏览器临时资料。
- 两文件四测试准确汇总 2 通过、1 失败、1 跳过；清单逐项哈希复核且无模拟认证值、无登录 trace；重复执行拒绝、所选空脚本不判通过；脚本准备后变更记 incomplete；执行中 SIGTERM 取消仍生成摘要、删除私有状态。

这些是自动集成检查。临时页面自动设置模拟身份，不能替代用户真实输入密码/验证码、SSO、外部站点真实角色、Electron 自然语言技能选择或打包后的人工验收。本次历史业务回放仍为 5 通过、1 失败，不因能力补足改写结论。

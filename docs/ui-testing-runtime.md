# 客户端内置 UI 测试

2026-11-09，生产会话已切换到 browser-use 探索、Playwright 独立验证与版本发布链路。当前只支持只读测试；写操作、多角色和安装包验收不在本阶段范围。已有只读用例的修复任务与父批次关联已接入：不启动探索浏览器，最多两个补丁，业务预期与步骤冻结。2026-11-09 11:03，真实模型（qwen3.8-flash-next）在受控本地页面完成探索→候选→定向验证→发布→正式回归整链；真实模型生成候选脚本、真实业务站点、写操作与安装包仍未验收。详细证据和历史异常见 [只读闭环](browser-use-readonly-workflow.md)。

## 入口和资源

通过 Pi 1.4.0 官方扩展工厂登记一次 builtin:desktop-ui-testing，尊重禁用与替换；不再过滤用户 MCP 配置或强制启用内置 MCP。每个生产会话将自身的官方 ModelRuntime 传给工作流，模型与认证仅在后端使用。

内置运行时核验 `verify.cjs`（`prepare-runtime.cjs` 末尾调用）在 Node、Playwright、Chromium 之外，还检查 browser-use Python 运行时存在、平台一致、Python ≥ 3.11 且版本等于 `browser-use/upstream.json` 的固定补丁版；缺 Python 运行时或版本不符直接失败，不会只凭 Node 侧检查通过。

| 工具 | 行为 |
| --- | --- |
| qa_ui_explore | 根据真实工作区与地址匹配项目，后台登录并执行只读探索，返回 taskId 和轨迹 |
| qa_ui_save_candidate | 检查任务草稿、来源与步骤，冻结准确 revision，不执行 |
| qa_ui_run | validate 验证候选，regression 仅执行当前正式版本 |
| qa_ui_publish | 核对真实 passed 结果、版本哈希、证据与清理后更新正式引用 |

内置 UI 技能为 qa-ui-basic、qa-ui-assertion、qa-ui-execute，共用报告技能 qa-test-report。旧意图/录制技能及旧 project/login/prepare/finalize 工具已移除；旧平铺资产和录制日志不迁移、不作为新版来源。已有会话需重新加载资源或新建会话才使用更新入口。

| 位置 | 职责 |
| --- | --- |
| src/main/capabilities/ui-testing/extension.mjs | 四工具、技能发现、关闭时取消并等待任务收尾 |
| 同目录 workflow.mjs | 候选、验证、发布、正式回归及工作区锁 |
| 同目录 project-context.mjs、login-session.mjs | 项目边界、后台登录、私有临时状态 |
| resources/testing/ui/browser-use/ | 固定 Python/browser-use 探索及协议 |
| resources/testing/ui/run.cjs、playwright.config.cjs | 独立回放、取消、原生报告、快照和清单 |
| resources/testing/ui/execute.cjs | 正式版本 CLI，共享工作流执行核心 |
| src/main/services/test-data-service.js、test-report-service.js | 用例与报告分页、准确详情和删除检查 |
| tooling/testing/ui/prepare-runtime.cjs | 准备当前平台 Node、Python、Playwright 和浏览器 |

开发资源位于 resources/testing/ui 和 resources/testing/reporting；发布路径分别为 process.resourcesPath/testing/ui、testing/reporting。运行依赖、浏览器、认证与证据不提交。发布需完整复制对应资源；当前未做安装包或跨平台验收。

## 只读任务

先声明目标 URL、项目、角色、可见身份、可重复初态、业务预期与 user/rule/baseline 来源。contract.mode 区分 explore、candidate、complete；分别到探索、候选保存、验证发布阶段结束。已有正式用例回归加载执行技能，不重新探索。

dataStrategy 固定 read-only，cleanup 固定 none。允许的 click/input/select_dropdown 控件与输入值须明确，使用稳定定位和业务容器；探索最多 12 步、180 秒，明确指定已有 Pi provider/modelId，不自动换模型。缺少会改变业务目标、身份或预期的信息时先澄清。页面实际结果不能倒推预期。

项目配置仍在客户端 config/projects.local.json，见 [项目前置数据](project-data.md)。按 origin 和完整路径段匹配，最长范围优先；同等候选须明确项目。产物写当前会话真实工作区 qa/ui，不根据工作区名称猜系统。凭据由后端使用，不返回模型或写入脚本。

自动登录仅后台执行一次。公开页不提交凭据；验证码/MFA、跨域认证、未知表单、登录失败或身份无法确认时停止，无人工接管窗口。已验证 cookie/localStorage 交接，IndexedDB 状态尚不支持。每次回放创建独立上下文并核对身份和初态，结束删除私有状态。

## 文件与通过条件

- qa/ui/tasks/<taskId>/：任务约定、动作轨迹、必要证据及 drafts/<caseId>/case.spec.cjs、case.json。
- qa/ui/cases/<caseId>/：asset.json、revisions/0001/ 等冻结版本；currentRevision 仅指向验证通过的正式版本。
- qa/ui/runs/<runId>/：原生 JSON/HTML、summary、源码快照、截图与 manifest。

一例一 test，业务断言覆盖固定预期并引用真实成功步骤。先核对独立初态、附 qa-initial-state PNG，再断言业务结果并附 qa-business-result PNG；附件必须保存为可核对的文件。静态检查不代表执行通过。validate 只允许完整测试任务，每个 revision 仅一次定向验证；只有实际 passed、退出 0、哈希一致、必要证据齐全且清理成功才发布。回归不修改资产。

同工作区跨实例串行；取消直接交给原任务并等待终值。首次异常停止依赖链，保留任务和日志；明确修复前置条件后才允许一次恢复验证。收尾未知保留锁和现场，不自行删锁、换模型或新建等价任务绕过。

## 正式版本 CLI

运行 resources/testing/ui/bin/node resources/testing/ui/execute.cjs --project pms --cases caseA,caseB。

--project 接受项目编号或唯一名称；配置默认 config/projects.local.json，可用 --config 指定。--cases 与 --all 二选一，只执行 currentRevision。同批必须项目、目标、角色和身份一致；每批登录一次，记录准确 revisions/sourceTaskIds。最终 JSON 输出 runId/status/summaryFile/counts/cleanup；全部通过退出 0，其余退出 1。SIGINT/SIGTERM 交给共享执行器收尾。无账号发现、外部登录态、地址覆盖或自动修复参数，不读取 .env 或调用模型。外部调度可调用该入口，真实项目定时运行尚未验收。

## 用例和报告面板

用例面板只读取新版 qa-ui-asset/v1，完整枚举、筛选排序后每页 50 条；展开才读取准确 revision 和核对哈希。正式内容只读，候选独立标示；只有正式版本可生成精确 CLI 提示，插入输入框但不发送。整例删除需确认，在共享锁内检查过期版本和归属，tasks/runs 保留。其他 qa/data 普通文件保留原单文件操作。

UI 报告只接收 qa-report/v1、kind=ui、workflow=browser-use-playwright 和有效版本来源；API 报告保持兼容。列表及逐例详情每页 50 条，全批失败摘要记录总数及前 5 条，不因分页改统计。删除在共享锁内核对活动任务与有效用例来源/验证引用，必要来源不可删。细节见 [测试报告](test-reports.md)。

## 验证边界

本轮生产入口、项目上下文、提示词和后台登录定向测试 9 项通过、无失败或跳过。真实生产工厂创建临时官方 SDK 会话，确认四工具及四技能只登记一次、禁用和第三方 MCP 替换语义不变；离线探索协议夹具连接真实本地 Chromium，验证候选、发布、正式回归、拒绝边界、取消与清理。未读取真实认证，未请求模型。

2026-11-09 定向修复后，用例页 16 项、报告页 18 项与共用侧栏 79 项检查通过、退出 0；同步创建临时目录并在 ready 前设置 sessionData 后，三页原缓存错误消失。侧栏另修正设置断言范围、展开动画等待及 390px 聊天标签栏溢出。报告页退出时仍有 GPU shared-image 日志，根因待确认；历史与本次恢复记录见 [实现记录](browser-use-readonly-workflow.md)。真实模型整链已在受控本地页面通过（见上），真实业务、跨 frame、IndexedDB、写操作、多角色、真实模型生成候选和安装包均未扩大为已验收能力。

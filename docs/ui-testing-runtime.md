# 客户端内置 UI 测试

2026-11-09，生产会话已切换到 browser-use 探索、Playwright 独立验证与版本发布链路。默认只读；新增、编辑、删除等写操作仅在用户明确授权的隔离写任务中支持，要求 `QA_RUN_ID` 唯一数据、用例内清理和 `qa-cleanup` 证据，未获授权不能执行。只读与隔离写用例都支持修复任务与父批次关联：不启动探索浏览器，最多两个补丁，业务预期、步骤与写授权冻结。多角色、真实业务写操作与安装包验收不在本阶段范围。2026-11-09 11:03，真实模型（qwen3.8-flash-next）在受控本地页面完成探索→候选→定向验证→发布→正式回归整链；同日又完成真实模型自行生成候选脚本，以及真实失败回归后生成最小补丁（revision 0002）并通过定向验证、发布和正式回归。真实业务站点、跨 frame／IndexedDB、多角色、自动修复决策与安装包仍未验收；真实业务写操作仅完成采购合同草稿创建/查询的授权验收，且因当前版本无删除入口采用已声明残留（每次回归新增草稿）；提交审批、编辑、删除与批量业务写入仍未验收。详细证据、边界和历史异常见 [只读闭环](browser-use-readonly-workflow.md)。

## 入口和资源

通过 Pi 1.4.0 官方扩展工厂登记一次 builtin:desktop-ui-testing，尊重禁用与替换；不再过滤用户 MCP 配置或强制启用内置 MCP。每个生产会话将自身的官方 ModelRuntime 传给工作流，模型与认证仅在后端使用。

内置运行时核验 `verify.cjs`（`prepare-runtime.cjs` 末尾调用）在 Node、Playwright、Chromium 之外，还检查 browser-use Python 运行时存在、平台一致、Python ≥ 3.11 且版本等于 `browser-use/upstream.json` 的固定补丁版；缺 Python 运行时或版本不符直接失败，不会只凭 Node 侧检查通过。

| 工具 | 行为 |
| --- | --- |
| qa_ui_explore | 根据真实工作区与地址匹配项目，后台登录并执行只读探索，返回 taskId 和轨迹 |
| qa_ui_save_candidate | 检查任务草稿、来源与步骤，冻结准确 revision，不执行 |
| qa_ui_run | validate 验证候选，regression 仅执行当前正式版本 |
| qa_ui_publish | 核对真实 passed 结果、版本哈希、证据与清理后更新正式引用 |
| qa_ui_coverage | 保存本轮功能清单、校验准确候选映射并统计；read 读取已保存版本，不执行测试 |

内置 UI 技能为 qa-ui-basic、qa-ui-assertion、qa-ui-execute，共用报告技能 qa-test-report。旧意图/录制技能及旧 project/login/prepare/finalize 工具已移除；旧平铺资产和录制日志不迁移、不作为新版来源。已有会话需重新加载资源或新建会话才使用更新入口。

| 位置 | 职责 |
| --- | --- |
| src/main/capabilities/ui-testing/extension.mjs | 五工具、技能发现、关闭时取消并等待任务收尾 |
| 同目录 workflow.mjs | 候选、验证、发布、正式回归及工作区锁 |
| 同目录 coverage.mjs | 本轮范围、功能与检查项留档、准确候选映射及确定性统计 |
| 同目录 project-context.mjs、login-session.mjs | 项目边界、后台登录、私有临时状态 |
| resources/testing/ui/browser-use/ | 固定 Python/browser-use 探索及协议 |
| resources/testing/ui/run.cjs、playwright.config.cjs | 独立回放、取消、原生报告、快照和清单 |
| resources/testing/ui/execute.cjs | 正式版本 CLI，共享工作流执行核心 |
| src/main/services/test-data-service.js、test-report-service.js | 用例与报告分页、准确详情和删除检查 |
| tooling/testing/ui/prepare-runtime.cjs | 准备当前平台 Node、Python、Playwright 和浏览器 |

开发资源位于 resources/testing/ui 和 resources/testing/reporting；发布路径分别为 process.resourcesPath/testing/ui、testing/reporting。运行依赖、浏览器、认证与证据不提交。发布需完整复制对应资源。`prepare-runtime.cjs` 会把独立 CLI 依赖的宿主模块复制到 `resources/testing/ui/lib`，CLI 在打包布局下从随包副本加载；模拟 resources 布局并完成真实回放的检查已通过，真实安装包、代码签名与跨平台运行仍未验收。

## 只读任务

先声明目标 URL、项目、角色、可见身份、可重复初态、业务预期与 user/rule/baseline 来源。contract.mode 区分 explore、candidate、complete；分别到探索、候选保存、验证发布阶段结束。已有正式用例回归加载执行技能，不重新探索。

dataStrategy 固定 read-only，cleanup 固定 none。允许的 click/input/select_dropdown 控件与输入值须明确，使用稳定定位和业务容器；探索最多 12 步、180 秒，明确指定已有 Pi provider/modelId，不自动换模型。缺少会改变业务目标、身份或预期的信息时先澄清。页面实际结果不能倒推预期。

探索前读取 [功能探索提示词](../resources/testing/ui/prompt/exploration-control.md)，主 Agent 建立优先清单、自由探索队列与有限总预算；指定功能完成后继续发现其他功能，不以初始清单作为功能白名单。每次调用仍冻结单目标，browser-use 完成后通过真实轨迹交回发现，由主 Agent 声明后续只读任务；工具不内置跨任务遍历。完整顺序、维度及停止规则在该文件单处维护。交付分别列出优先功能、自由发现、证据、剩余队列和停止依据；文件操作、业务写入与审批等受阻项须保留原因，不能因已识别入口就计为执行或通过。此次更新不新增动作、不扩大写授权，真实模型的两阶段探索效果仍待单独验收。

项目配置仍在客户端 config/projects.local.json，见 [项目前置数据](project-data.md)。按 origin 和完整路径段匹配，最长范围优先；同等候选须明确项目。产物写当前会话真实工作区 qa/ui，不根据工作区名称猜系统。凭据由后端使用，不返回模型或写入脚本。

探索提示词还约定主 Agent 在明确审批线索出现时动态加载项目 qa-approval-workflow，普通功能不预加载；browser-use 只报告线索，由主 Agent 将适用的只读要点及来源交给后续任务。成功且清理确认后按证据去重，并回写通用覆盖项或带 projectId 的专属功能索引，核实过程与变更依据保存在原任务目录 discoveries.md；回写失败保留待处理项。这是提示词执行约定，qa_ui_explore 未新增自动回写服务、技能安装、可写运行副本或审批执行能力；真实模型的条件加载、持续回写及安装包可写性仍未验收，详细规则只在探索提示词维护。

自动登录仅后台执行一次。公开页不提交凭据；验证码/MFA、跨域认证、未知表单、登录失败或身份无法确认时停止，无人工接管窗口。已验证 cookie/localStorage 交接，IndexedDB 状态尚不支持。每次回放创建独立上下文并核对身份和初态，结束删除私有状态。

## 文件与通过条件

- qa/ui/tasks/<taskId>/：任务约定、动作轨迹、必要证据及 drafts/<caseId>/case.spec.cjs、case.json。
- qa/ui/cases/<caseId>/：asset.json、revisions/0001/ 等冻结版本；currentRevision 仅指向验证通过的正式版本。
- qa/ui/runs/<runId>/：原生 JSON/HTML、summary、源码快照、截图与 manifest。
- qa/ui/rounds/<roundId>/：本轮 draft 与逐版 summary.json/summary.md；跨探索任务和执行批次的功能明细，不作为执行结果。

一例一 test，业务断言覆盖固定预期并引用真实成功步骤。先核对独立初态、附 qa-initial-state PNG，再断言业务结果并附 qa-business-result PNG；附件必须保存为可核对的文件。静态检查不代表执行通过。validate 只允许完整测试任务，每个 revision 仅一次定向验证；只有实际 passed、退出 0、哈希一致、必要证据齐全且清理成功才发布。回归不修改资产。

同工作区跨实例串行；取消直接交给原任务并等待终值。首次异常停止依赖链，保留任务和日志；明确修复前置条件后才允许一次恢复验证。收尾未知保留锁和现场，不自行删锁、换模型或新建等价任务绕过。

## 本轮功能清单与候选转换

探索前保存本轮范围，探索和候选生成中持续登记，收尾保存 completed/partial 准确版本；保留优先功能、自由发现、受阻与待确认项。工具沿用共享锁及 JSON 保存机制，候选版本和预期引用均从现有资产核对。结构、调用、统计和停止规则统一见 [本轮清单规程](../resources/testing/ui/skills/qa-ui-basic/references/coverage.md)，主流程见 qa-ui-basic。生成、历史复用、独立验证和发布分列；单功能至少一例不表示全部检查项完成。

清单快照通过文件链接交付，右侧报告面板继续只显示执行批次。仅探索、仅生成候选不制造 run；已有回归无需补建探索清单。功能确认与业务断言是否相符仍需 Agent 按来源核对，工具校验不能代替语义评审。运行资源准备同步复制 coverage.mjs，不手动修改生成的 lib。

## 正式版本 CLI

审批测试的提示词授权、人员账号映射、逐节点核验与异常停止统一维护在 [qa-ui-execute 的审批测试执行](../resources/testing/ui/skills/qa-ui-execute/SKILL.md#审批测试执行)。测试任务包含审批时，允许依据项目 qa-approval-workflow 的流程人员信息及已确认账号执行；例如实际启用并到达董事长审核节点后，使用用户明确指定的账号。普通只读回归不触发审批操作。此为提示词执行规则，当前 CLI/qa_ui_run 仍只使用项目配置的一套账号，没有动态选人或多角色调度参数；能力不足须报告已授权但执行受阻。本次未新增运行时账号切换或审批实现，也未进行真实审批验收。

运行 resources/testing/ui/bin/node resources/testing/ui/execute.cjs --project pms --cases caseA,caseB。

--project 接受项目编号或唯一名称；配置默认 config/projects.local.json，可用 --config 指定。--cases 与 --all 二选一，只执行 currentRevision。同批必须项目、目标、角色和身份一致；每批登录一次，记录准确 revisions/sourceTaskIds。最终 JSON 输出 runId/status/summaryFile/counts/cleanup；全部通过退出 0，其余退出 1。SIGINT/SIGTERM 交给共享执行器收尾。无账号发现、外部登录态、地址覆盖或自动修复参数，不读取 .env 或调用模型。外部调度可调用该入口；2026-11-09 已在项目管理系统以临时 launchd 60 秒间隔完成两次真实定时回归（均 passed、资产未变），应用内调度、失败/取消/并发调度和长期稳定性仍未验收。

## 用例和报告面板

用例面板只读取新版 qa-ui-asset/v1，完整枚举后按 `modulePath` 生成左侧目录树与右侧列表；支持目录筛选、按状态筛选、排序、搜索和每页 50 条。展开才读取准确 revision 和核对哈希。Agent 生成内容按 revision 只读，候选独立标示；只有正式版本可生成精确 CLI 提示，插入输入框但不发送。「设置目录」只写 `asset.json` 的可选 `folder`，不改 revision，并在共享锁内用 assetHash 防止覆盖并发变化；整例删除需确认，在共享锁内检查过期版本和归属，tasks/runs 保留。面板可新建和编辑 `origin: "manual"` 的手动用例，保存为占位 spec、`currentRevision: null`，不会成为可执行正式版本；编辑追加手动版本。其他 qa/data 普通文件不再在面板展示。

UI 报告只接收 qa-report/v1、kind=ui、workflow=browser-use-playwright 和有效版本来源；API 报告保持兼容。列表及逐例详情每页 50 条，全批失败摘要记录总数及前 5 条，不因分页改统计。删除在共享锁内核对活动任务与有效用例来源/验证引用，必要来源不可删。细节见 [测试报告](test-reports.md)。

## 验证边界

本轮清单接入的 2026-11-10 定向结果及环境异常恢复见 [功能清单验收记录](ui-coverage-acceptance.md)。以下原有验收记录不扩大为新清单规则的真实模型行为验收。

本轮生产入口、项目上下文、提示词和后台登录定向测试 9 项通过、无失败或跳过。真实生产工厂创建临时官方 SDK 会话，确认四工具及四技能只登记一次、禁用和第三方 MCP 替换语义不变；离线探索协议夹具连接真实本地 Chromium，验证候选、发布、正式回归、拒绝边界、取消与清理。未读取真实认证，未请求模型。

真实模型候选/补丁验收使用 `node tests/helpers/ui-model-generation.check.mjs <隔离证据目录> all`（或 `repair` 复用已完成候选）；候选 revision 0001、补丁 revision 0002 与最终回归均通过，模型为 `qwen3.8-flash-next`，未访问真实业务站点。包装脚本两次提前结束的修正记录见 [异常报告 L](browser-use-readonly-workflow.md#异常报告-l真实模型验收包装脚本误判与登录守卫阻断已修正)。

2026-11-09 定向修复后，用例页 16 项、报告页 18 项与共用侧栏 79 项检查通过、退出 0；同步创建临时目录并在 ready 前设置 sessionData 后，三页原缓存错误消失。侧栏另修正设置断言范围、展开动画等待及 390px 聊天标签栏溢出。报告页退出时仍有 GPU shared-image 日志，根因待确认；历史与本次恢复记录见 [实现记录](browser-use-readonly-workflow.md)。2026-11-09 隔离写与修复关联接入后：用例页 16 项连续 3 次、报告页 19 项通过；期间修复了确认框第二次打开被旧 close 事件关闭的竞态（报告 J）。真实模型整链及真实模型生成候选/补丁已在受控本地页面通过（见上）；真实业务、跨 frame、IndexedDB、多角色、自动修复决策和安装包仍未扩大为已验收能力。真实业务写操作仅限已声明的采购合同草稿创建/查询。

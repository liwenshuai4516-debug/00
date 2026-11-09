# browser-use + Playwright：阶段 2 只读闭环

核对时间：2026-11-09，Asia/Shanghai（UTC+08:00）。开发入口及独立执行 CLI 已接入，离线集成验证通过；真实 Qwen 首次请求超时，真实探索后的整链验收尚未通过。阶段 3 已接入 CLI、执行技能、用例面板及对应 IPC；生产扩展、其他技能和报告面板的新契约仍待替换。用例面板定向检查通过，共用侧栏检查与 Chromium 缓存异常见下方记录。

## 已接入的链路

开发扩展工厂为 `src/main/capabilities/ui-testing/workflow-extension.mjs` 的 `createReadOnlyWorkflowExtension(runtime)`，通过官方 `DefaultResourceLoader.extensionFactories` 加载。`runtime` 沿用 `resolveUiTestingRuntime` 的路径，可传宿主已有的官方 `modelRuntime`。生产 `pi-resources.mjs` 仍登记旧扩展；本阶段不同时加载两组工具，不提供运行时切换开关。

| 工具 | 行为 |
| --- | --- |
| `qa_ui_explore` | 按当前真实工作目录和目标地址匹配项目，后台登录，取得官方 Pi 模型认证，仅在内存传给 Python；返回任务编号和轨迹目录 |
| `qa_ui_save_candidate` | 从任务草稿读取一例一 test 的脚本和唯一 `case.json`，检查语法、字段、固定预期、实际步骤引用和明显违规，冻结新 revision 与 SHA-256 |
| `qa_ui_run` | `validate` 执行准确候选版本，每个 revision 仅一个定向验证批次；`regression` 仅执行当前正式引用。复用现有 `run.cjs`，每次重新后台登录并创建新回放上下文 |
| `qa_ui_publish` | 从磁盘核对准确版本、原生单个 passed、退出码、清理、执行前后哈希、快照和报告/截图清单，再原子更新正式引用 |

只读任务必须声明：`mode`（explore/candidate/complete）、目标、角色、可见身份标识、业务预期及 user/rule/baseline 来源、可重新定位的初态、`dataStrategy: "read-only"`、`cleanup: "none"`、完成时可见文本、允许的控件和输入值、明确 provider/model，以及最多 12 步/180 秒的探索预算。`explore` 不准保存候选，`candidate` 不准回放候选。

Python 只暴露 navigate/click/input/select_dropdown/done。动作前按实际页面目标的 role/name、稳定属性与业务容器核对约定；输入仅允许声明值，拒绝追加、坐标、密码框与未声明控件。导航限定项目 origin/路径；非导航动作要求当前页面仍在项目范围。结束要求观察到身份和全部完成信号，不以模型自行宣称成功替代。沿用已批准的严格运行时补丁，无模型自动重试、浏览器自动重连或默认逐步截图。

后台登录沿用私有临时状态和现有登录进程。公开页无登录表单时跳过凭据提交；验证码/MFA/身份无法确认返回 blocked。角色文本仍须在探索与用例中核对。只支持已验证的 cookie/localStorage；遇到 IndexedDB 状态明确 blocked。Qwen 的内网直连仅在 Python 子进程中按用户已确认的该 provider/model 配置，不改变宿主代理。

## 文件契约与发布门槛

```text
qa/ui/tasks/<taskId>/task.json
qa/ui/tasks/<taskId>/actions.jsonl
qa/ui/tasks/<taskId>/evidence/
qa/ui/tasks/<taskId>/drafts/<caseId>/case.spec.cjs
qa/ui/tasks/<taskId>/drafts/<caseId>/case.json
qa/ui/cases/<caseId>/asset.json
qa/ui/cases/<caseId>/revisions/0001/{case.spec.cjs,case.json}
qa/ui/runs/<runId>/{task.json,summary.json,summary.md,results.json,manifest.json}
qa/ui/runs/<runId>/{html,sources,artifacts}/
```

`case.json` 使用 `qa-ui-case/v1`，包含 caseId/title/project/modulePath/targetUrl/role/taskId、与任务相同的 initialState/dataStrategy/cleanup/expected、引用真实成功 `stepId` 的 steps，以及覆盖每条 expected.id 的 business assertions。完整示例见 `tests/helpers/ui-readonly-workflow.check.mjs`。保存后的 revision 不原地修改；同一新建任务最多初稿加两个补丁，已有用例的修复任务留到阶段 4。

候选必须实际包含一个 test 和 expect，并提供 `qa-initial-state`、`qa-business-result` 两个 PNG 附件。截图需先保存到 `testInfo.outputPath(...)`，再用 `testInfo.attach(name, { path, contentType: "image/png" })` 附加，保证清单可核验独立文件；仅内嵌 base64 的附件不满足本阶段发布要求。成功回放记录 `workflow: "browser-use-playwright"`、purpose 和准确 revisions。

发布同时检查原生 JSON/HTML、summary 和清单存在且内容哈希一致、所选脚本确有且仅有一个实际 passed、统计一致、退出 0、私有回放状态已删除、脚本与说明的执行前后哈希均等于 revision 哈希、相应源码快照已归档，以及两张必要截图存在并纳入清单。跳过、预期失败、普通失败、证据缺失、内容变化均不更新正式引用。失败结果保留原运行目录；后续回归不自动修改资产或调用模型。

所有工具共用工作区排他文件锁，跨扩展实例生效；取消直接传给进程，不等待该锁。Python 仍须同时确认 done、退出和浏览器收尾。回放取消先交给现有执行器收尾，超限才终止进程组；收尾未知时保留锁和现场，禁止新任务。应用重启不自动续跑或清理遗留锁，先核对原任务与相关进程。新路径拒绝链接越界，不创建旧 `qa/data/ui` 目录。tasks、runs 和互斥标记属于本地产物并被忽略。

静态检查是轻量规则检查，不能证明任意 JavaScript 与业务说明的语义一致，也不构成执行不可信脚本的隔离机制。只读控件的业务含义、初态和断言内容须基于任务来源；发布证明该脚本在记录条件下实际执行通过。此次集成检查中的候选是显式编写的夹具，并非 Qwen 生成脚本的验收。真实业务、跨 frame、IndexedDB、重启续跑、写操作、自动修复及真实应用操作均不扩大为已验证能力。

## 独立执行 CLI

`resources/testing/ui/execute.cjs` 与 `qa_ui_run` 共用 `workflow.mjs` 的执行核心。CLI 使用项目编号或唯一名称选择实际工作目录，支持 `--cases id1,id2` 或 `--all`，可用 `--config` 指定项目配置。只读取 `qa/ui/cases/<caseId>/asset.json` 的 `currentRevision`，要求正式版本具有成功验证引用；忽略未发布候选和旧平铺资产，不读取 `.env`，不调用模型或修改版本。

批次在工作区锁内固定准确版本、文件哈希及 `sourceTaskIds`，检查用例与已完成只读探索任务的项目、目标和角色一致。批量执行须项目、目标地址、角色及可见身份标识一致，否则在登录前拒绝；不同范围须拆批。每批仅后台登录一次，共用私有状态，再由原执行器运行准确脚本并保存原生报告。退出 0 仅表示全部通过；失败、取消、incomplete 和参数错误均退出 1。SIGINT/SIGTERM 传给共享执行器收尾，状态未知时保留锁与现场。

`qa-ui-execute` 及用例面板生成的执行提示已同步为此入口。旧生产录制工具尚未替换，不能将旧资产交给新 CLI。当前 CLI 从开发仓库加载共享实现，安装包资源布局及跨平台运行未验收。

## 版本用例面板

右侧「测试数据」只将 `qa/ui/cases/<caseId>/asset.json` 的 `qa-ui-asset/v1` 纳入 UI 用例列表；无索引、旧 schema 和旧平铺资产不展示、不迁移。先完整枚举新格式目录，按模块、标题、caseId 排序并筛选，再每页 50 条；搜索范围是编号、标题、模块和角色。列表不携带步骤、预期或断言；展开时按准确 revision 读取详情，同时核对说明与脚本 SHA-256。

有正式版本时列表采用正式说明，展示后续未发布候选；只有候选时展示最新候选。详情可切换已登记版本，只读展示初态、数据策略、步骤、固定预期及来源、business/guard 断言和来源 task/验证 run。最近结果只关联同项目、真实工作区、准确 caseId/revision/脚本的新版 regression 摘要，不混入 validate 或其他版本结果。

只有正式用例提供「生成执行提示」，向输入框插入精确 `--project` 和 `--cases`，不自动发送；查看候选详情不改变正式执行目标。旧步骤/断言编辑、流程标记、批量删除 test 及 grep 入口已退出。删除需确认整个 case 的所有版本永久删除；主进程 idle 互斥及共享工作区锁内核对列表 assetHash、版本说明哈希、项目和 task 归属，版本变化或活动任务会阻止删除；tasks/runs 保留。其他 `qa/data` 普通文件仍可列表和单文件删除，最多展示 500 个并提示截断，排除旧 `ui/cases`。

接口为 `listTestData(projectId, { page, query })`、`getTestCase(projectId, caseId, revision)`、`deleteTestCase(projectId, caseId, assetHash)` 及普通文件的 `deleteTestData`。页面使用请求编号、项目和详情请求对象核对迟到结果。

![用例版本与只读详情](images/test-data-versions.png)

## 验证记录

2026-11-09 用例面板：`node --test tests/unit/test-data-service.test.js tests/unit/agent-ipc.test.js tests/unit/project-service.test.js tests/unit/ui-readonly-workflow.test.js`，23 项通过、0 失败/跳过。覆盖 205 例完整排序筛选分页、正式/候选隔离、准确详情与回归、哈希/项目/链接拒绝、旧资产隔离、普通文件、锁/过期删除拒绝、整例删除及历史保留、IPC 转发与互斥；共享工作流仍使用离线模型协议夹具及本地 Chromium。

`TEST_DATA_CATALOG_SCREENSHOT_PATH=docs/images/test-data-versions.png node_modules/.bin/electron tests/ui/test-data-catalog.check.cjs`（实际截图参数为仓库绝对路径）：16 项断言通过，退出 0。覆盖每页 50 条、按需版本详情、来源只读、正式执行提示、候选无执行、筛选分页、删除确认、普通文件、切换项目后的迟到详情和无横向溢出；截图已视觉核对。首次及补齐缓存目录后的一次恢复检查均有 Chromium 缓存错误，不能视为环境检查完全通过。共用 `sidebar-layout.check.cjs` 两次均退出 1，恢复后仍停在旧模型设置断言，尚未到用例区域；不扩大为共用侧栏通过。详见报告 D–F。本轮未请求真实模型。

2026-11-09：`node --test --test-concurrency=1 tests/unit/execute-cli.test.js tests/unit/ui-readonly-workflow.test.js`，4 项通过、0 跳过。CLI 在含中文、空格及单引号的临时目录实际调用 Chromium，覆盖双用例正式版本选择、候选隔离、单次登录、来源记录、执行不改资产、项目/角色/来源/哈希/链接拒绝、跨实例锁、真实业务断言失败退出及 SIGTERM 取消与私有状态清理。来源任务和候选为显式文件夹具，保存、验证、发布及回放实际执行；不代表 browser-use 或真实模型生成已通过。执行技能文案定向检查 `node --test tests/unit/prompt-content.test.js`，7 项通过。本轮未请求真实模型。

此前阶段 2 检查：

- `node --test tests/unit/ui-readonly-workflow.test.js`：通过。真实官方 SDK 会话登记四工具；Python 使用明确标记的离线协议夹具，Playwright/Chromium 实际运行本地页面。覆盖筛选 Beta、排除 Alpha、同一业务行详情异步结果、准确候选回放、发布与正式回归；另外覆盖预期漂移、虚构步骤、跳过脚本、候选回归、重复候选验证、报告/版本变化、失败报告、跨实例互斥、取消终值、链接越界及收尾未知阻断。
- `node --test tests/unit/browser-use-bridge.test.js`：9 项通过，无模型请求。已通过的协议项未反复运行。
- `node --test tests/unit/ui-project-context.test.js`：4 项通过，旧入口默认目录及项目匹配行为仍通过。
- `node --test --test-name-pattern='：replay' tests/unit/ui-testing-runtime.test.js`：旧回放集成场景通过，确认共享执行器改动未破坏该旧入口。
- `resources/testing/ui/browser-use/.venv/bin/python tests/helpers/browser-use-probe.check.py`：11 项通过，未启动浏览器或请求模型。
- `resources/testing/ui/browser-use/.venv/bin/python tests/helpers/browser-use-readonly.check.py`：7 项通过，覆盖只读动作 schema、同名按钮业务行、身份、限定输入、写控件/坐标拒绝、项目 URL 和完成信号。
- 真实 Qwen：通过开发扩展的 `qa_ui_explore` 发起 1 次请求，0 动作，随后因超时停止。未保存候选、未执行 Playwright、未发布，也未发起第二次真实请求。

离线测试通过不代替真实探索验收。真实调用恢复前，本阶段标记为“代码与离线闭环就绪，真实探索整链待验”，不宣称阶段 2 全部验收完成。

## 异常报告 A：截图附件格式不满足文件证据契约（已修正）

| 项目 | 记录 |
| --- | --- |
| 任务与结论 | 2026-11-06 17:40:12–17:40:14 UTC+08:00，首次离线集成检查在回放结果检查处停止；Playwright 实际 passed、退出 0，但批次为 incomplete，发布及后续检查未执行 |
| 调用链路 | 用户阶段 2 目标 → `ui-readonly-workflow.test.js` → helper/官方 SDK 四工具（登记、探索协议夹具、保存候选成功）→ `qa_ui_run`/`run.cjs` → 本地 Chromium（断言成功）→ 附件检查失败；未使用技能 |
| 工具与参数 | `functions.exec` → `exec_command`，运行定向 Node 测试；测试进程退出 1。失败 runId 为 `run-4e2d795c-4359-4ca7-9336-4f0eece63a20`。协议测试同批 9 项成功 |
| 原因与证据 | 原生 `attachments` 中为 `body`，无 `path`；summary.problems 为“缺少必要截图：qa-initial-state / qa-business-result”。已确认是夹具证据格式问题；不是浏览器断言失败。现场保留于 `/private/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/ui-readonly-Dm7Acj` |
| 已执行处置 | 停止依赖链路；读取原生结果确认内嵌附件格式，将夹具改为实际保存 PNG 后按 path 附加，按已改变的前置条件做一次恢复验证，通过。后续代码复核增加“收尾未知保留锁”等独立边界后，按新改动再次定向验证通过；没有重放原失败 run |
| 影响与恢复 | 未发生模型或业务写请求；保留首次 incomplete 结果，不发布失败版本。截图文件契约已写入本说明，恢复后串联通过 |

## 异常报告 B：真实 Qwen 首次请求超时（未重试）

| 项目 | 记录 |
| --- | --- |
| 任务与结论 | 2026-11-06 17:42:23–17:43:13 UTC+08:00；实际模型探索在 agent-run 阶段停止。taskId=`task-88c86e04-ff2b-4425-8c42-500a6d17d058`；候选保存、独立验证、发布与正式回归均未执行 |
| 调用链路 | 用户授权的指定 Qwen 小验证 → `ui-readonly-workflow.check.mjs ... real` → 官方 SDK 加载开发扩展/`qa_ui_explore` → 项目匹配、后台公开页确认、官方 ModelRuntime 认证（成功）→ bridge/Python/Chromium 启动（成功）→ ChatOpenAI 调用指定模型（失败）→ 正常浏览器收尾（成功）；未使用技能 |
| 工具与参数 | `functions.exec` → `exec_command`，Node helper real 模式，仅 `qwen3.8-flash-next/qwen3.8-flash-next`，目标为受控本地页面，Python 子进程内使用已授权直连。helper 退出 1，Python code=1，signal=null，bridge fault=null |
| 原因与证据 | terminal.modelError：`ModelProviderError` 的 statusCode=502 / `Request timed out.`，下层 `APITimeoutError → ReadTimeout`。这是适配层的错误码；没有证据表明服务端实际返回 HTTP 502。已确认请求超时，尚不能确定是服务处理、链路还是超时预算原因。modelCalls=1、actions=0、usage=[]、reconnectAttempts=0、cleanupConfirmed=true |
| 已执行处置 | 首次异常立即停止，读取已保存 process-result。未换模型、未变更连接路径、未增大超时、未重跑或发起恢复模型请求；无证据证明故障条件改变。独立的离线代码复核与测试继续完成 |
| 影响与恢复 | 没有探索动作或业务写入；模型侧是否计费未确认，不把空 usage 当成零计费。浏览器收尾已确认，任务 private 目录已删除；保留失败 task/process-result。需先有该模型推理服务可用或明确前置条件已修复的证据，再按仓库规则做一次有界恢复验证；不能直接重复原调用 |

真实现场保留在 `qa/ui/browser-use-smoke/stage2-u6LLSr/`（已忽略），其中 `check-summary.json` 为检查摘要，任务目录下 `process-result.json` 为脱敏协议结果；无凭据或真实业务账号。后续“继续”应从故障恢复证据开始，不把阶段 1 的历史成功或离线协议夹具当作本次真实探索完成。

## 异常报告 C：只读源码路径检查错误（已修正）

| 项目 | 记录 |
| --- | --- |
| 任务与结论 | CLI 与用例面板接入期间的源码检查；日期 2026-11-09 UTC+08:00，具体时刻未记录。路径检查报错后分别暂停相应读取；没有写入或结果未知操作 |
| 调用链路与工具 | 用户继续接入 → `functions.exec` / `exec_command` → 本地文件读取；未使用技能。`src/main/services/ui*` 被 zsh 判为无匹配，依赖它的后续搜索未执行；读取 `src/main/storage/project-storage.js` 时文件不存在 |
| 原因与证据 | 错误为 `no matches found` 和文件不存在；`rg --files` 及实际源码导入确认目标位置，存储模块实际为 `src/main/storage/project-store.js` |
| 面板期间的路径检查 | `src/main/pi-resources.mjs` 不存在，实际为 `src/main/resources/pi-resources.mjs`；`src/main/capabilities/ui-testing/*.cjs` 无匹配，执行入口实际为 `resources/testing/ui/run.cjs`；`settings/model-settings.js` 不存在，实际为 `settings/model-providers.js`；`tests/ui/model-providers.preload.cjs` 不存在（rg 退出 2），模拟接口实际在 `tests/ui/model-providers.check.cjs` 内。均依据文件清单/实际导入修正后只读成功，未原样重试 |
| 已执行处置 | 未原样重跑；根据目录清单和真实 import 修正读取路径，各完成一次只读检查。未改变业务代码以绕过异常 |
| 影响与恢复 | 无文件写入影响，无待恢复操作；CLI 与共享执行器的定向验证随后通过。真实 Qwen 故障仍按报告 B 保留，不在此次检查中重试 |

## 异常报告 D：临时工作区路径别名（已修正）

| 项目 | 记录 |
| --- | --- |
| 任务与结论 | 2026-11-09 UTC+08:00，具体时刻未记录；用例服务首轮定向测试在最近结果关联处失败，停止该检查链路 |
| 调用链路与工具 | 用户继续接入 → `functions.exec` / `exec_command` → `node --test` → 临时工作区夹具 → test-data-service；未使用技能，无模型调用 |
| 原因与证据 | 夹具 summary.workspace 使用 `/var/...`，服务返回真实目录 `/private/var/...`，准确工作区核对不匹配；这是夹具路径问题，不放宽产品归属检查 |
| 已执行处置 | setup 改为 `fs.realpath(mkdtemp(...))`，在前置条件修正后完成一次定向恢复验证；23 项通过、退出 0 |
| 影响与恢复 | 仅临时测试数据，无真实业务写入、无结果未知；恢复已完成，未重放正式运行或模型请求 |

## 异常报告 E：Chromium 缓存初始化（未解决）

| 项目 | 记录 |
| --- | --- |
| 任务与结论 | 2026-11-09 UTC+08:00，首次与恢复时刻未记录；新版用例面板页面断言均通过，但缓存初始化报错。共用侧栏 09:29:19 的恢复检查也有同类日志。已停止缓存恢复链路 |
| 调用链路与工具 | 用户面板接入 → `functions.exec` / `exec_command` → Electron 的 `test-data-catalog.check.cjs` → 临时 userData / Chromium；未使用技能。截图由 Electron capturePage 保存并经 view_image 核对 |
| 预期与实际 | 预期本地页面与临时缓存正常；两次均 16 项断言通过、退出 0。首次 `Failed to create directory .../Shared Dictionary/cache` / `wrong file structure on disk: 1` / `Unable to create cache`；恢复后 `Failed to write a new fake index.` / `wrong file structure on disk: 8` / `Unable to create cache` |
| 原因与证据 | 已确认 Chromium 缓存写入失败，根因待确认；补齐目录并未消除错误，因此不能归因为只缺目录。证据为本轮工具输出，未另存完整日志。共用侧栏还出现 GPU shared-image 日志，因果关系未确认 |
| 已执行处置 | 首次停止后读取已有夹具契约，补建 `Shared Dictionary/cache`，做一次恢复检查；仍有错误后停止，未再次更换缓存路径、启动参数或重跑该链路 |
| 影响与恢复 | 保留代码及 `docs/images/test-data-versions.png`；仅临时模拟接口，无真实认证/模型/业务写入。页面断言通过不代表 Chromium 环境无异常。后续需先确认缓存失败原因和修复依据，再由用户继续恢复检查；不能原样重复启动 |

## 异常报告 F：共用侧栏旧夹具与断言（未通过）

| 项目 | 记录 |
| --- | --- |
| 任务与结论 | 2026-11-09 UTC+08:00，首次时刻未记录；09:29:19–09:29:20 恢复检查仍在模型设置断言失败，退出 1；停止后续共用检查，用例区域未执行 |
| 调用链路与工具 | 用户面板接入 → `functions.exec` / `exec_command` → `electron tests/ui/sidebar-layout.check.cjs` → sidebar-check 模拟接口及本地 renderer；未使用技能，无模型请求 |
| 预期与实际 | 首次接口调用报 `未登记的模拟接口：readModelCatalog`，继而“设置左侧纵向显示模型、主题与已归档，模型页使用官方配置入口”断言失败。补齐最小空 catalog 后，接口错误消失，但同一断言仍为 actual=false / expected=true；前 6 项通过 |
| 原因与证据 | 已确认夹具缺 catalog 接口。恢复后只读源码还确认旧断言的 `document.querySelector('[role=tablist]')` 首先匹配 `index.html` 的对话视图标签条，而非设置分类标签条，其没有 aria-orientation；本轮没有修改产品设置功能 |
| 已执行处置 | 首次停止、读取实际模型页面契约、补齐模拟接口，完成一次恢复验证；仍失败即停止，未继续改断言并重跑。已有缓存/GPU 日志另见报告 E，不据此推断断言失败原因 |
| 影响与恢复 | 共用侧栏回归结论未通过；新版用例面板 16 项独立断言仍有效。无真实业务写入或未知提交。最小后续修复是将旧断言的 tablist 查询限定到设置对话框，再按用户继续指令及有界规则验证；不能把尚未执行的其他共用检查标为通过 |

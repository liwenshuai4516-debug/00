# 采购合同真实 Agent 续验（2026-11-12）

时区：Asia/Shanghai（UTC+08:00）。本轮遵循用户新增约束：严格按实际功能测试，不修改被测系统源码，不代审、不改账号权限或业务配置来凑通过。

## 已确认的进展与停止位置

**当前结论：客户端修复已通过定向测试，真实完整审批链仍未通过。** 唯一测试合同已真实完成创建、所有启用审核、上传定稿及刘波盖章，已实际到达并打开本人“发起人确认”表单。最后一次确认尝试被测试编号格式校验拦住：本次准备的 `QA-CG-20261112-109` 不符合页面要求，并非被测系统功能缺失。扫描件上传已发生，确认未流转；未执行归档、未生成或发布完整链 E2E。不能把页面有按钮、HTTP200或客户端测试通过当成全链验收通过。


客户端补齐脱敏登录子阶段、有限请求 HTTP 状态/数字业务码及审批页面失败观察；不保存认证头、请求/响应正文。inspect、execute 成功及页面失败增加有限 pageText，截图使用 fullPage，内嵌滚动区不承诺全部展开；inspect 保留隐藏文件输入框，text/value 检查为全等、须定位具体节点。验收启动器在进程内从现有项目配置读取已授权密码并注入原 QA_UI_TEST_PASSWORD 入口，未改写凭据文件，没有新增凭据库、重试器或流程引擎；这不代表已重启用户桌面窗口或验证其既有进程环境。

用户更正的“姜干才”已核对并同步至实际测试工作区人员表，除8处姓名外与原文件一致；旧候选、失败批次和来源快照保持不变。新增目标按更新来源建立独立任务，不把新预期伪装成旧用例定位修复。

真实生产 Pi Agent（Electron 主进程，既有 qwen3.8-flash-next 模型）已创建并提交独立测试合同，未用模拟模型代替业务验收：

实际链路：用户目标 → 临时 Electron 验收启动器 → 本仓库 createPiAgent（会话目录临时隔离、真实模型及已登记qa_ui工具）→ qa_ui_approval / qa_ui_explore → 生产登录与浏览器执行资源 → pms 测试环境。只读候选随后经 qa_ui_save_candidate → qa_ui_run(validate) → qa_ui_publish；没有使用 Codex 子Agent替代业务Agent，也未向其他人员发送消息。

| 项目 | 实际结果 |
| --- | --- |
| flowId / 配置版本 | approval-procurement-new-20261111；创建版本2；逐人修订租户控件，董事长纠正选择器后为版本12，保持 frozen |
| 创建 Agent 会话 | 01a1cd56-c8b3-7471-890b-d146e82f79f5 |
| 合同名 | QA-采购合同-approval-procurement-new-20261111 |
| 记录 ID / 流程编号 | 478297089609900032 / LC-HSKJ-CGHT-2026-11-109 |
| 创建提交 | completed，20个动作有原始轨迹；并未重复新建 |
| 首次停止时状态 | APPROVING / APPROVAL，部门负责人审核、辛晓岩 |
| 首个审批人恢复 | 版本3，check-ce9725f4-b9d1-42ab-ad55-00b869c7568a inspect completed，已选择正确租户，有本人同意入口 |
| 首个审批动作 | department-review completed，check-b54e0cda-95d2-4422-9875-cd0e1fa97c73，3条原生动作；10:13:57（UTC+08:00）转入法务审核，页面处理人科技公司法务 |
| 法务 / 合同管理员 | legal-review completed（含原失败attempts）、contract-admin-review completed（check-70a4b245-e060-465a-9f6c-ba5b8dc7a834），转入经营发展部审核 |
| 经营发展部串行 | operation-development-first completed（check-ded44780-6ecb-4261-a708-098eafafeb94）后仍待朱栋华；operation-development-second completed（check-f13c6023-ad1f-41a9-849f-68b91f3b29ce）后进入市场营销部／许玲懿；逐人独立登录和3条动作 |
| 市场营销部 / 分管领导 | marketing-review completed（check-9795b065-b8c2-4c2e-b651-89ec5ab3d432）；executive-review completed（check-6512d474-2dc9-48ee-bae1-5eb78a95753e）；转入总经理审核／陈振飞 |
| 总经理审核 | general-manager-review completed（check-43e31608-3985-45d9-9e15-08db98f60124）；只读接口确认转入董事长审核，顶层开关false与配置内true差异仍保留 |
| 董事长审核 | chairman-review completed（check-d526c8bf-f7cf-4499-a13f-d8e7d945d3c6），10:52:25 进入发起人上传定稿 |
| 发起人上传定稿 | upload-final completed（check-779f1de8-edd2-4dc9-b387-6992c50380fd），真实上传测试fixture并提交，10:58:52 进入合同管理员盖章／刘波 |
| 合同管理员盖章 | seal 3动作完整，原check-131127f1-5714-428e-b049-68990cdbfd69因结果标签层级错误保留unknown；只读纠正定位后check-1faca40a-5688-4e13-aeed-9b960fd7bf34 completed，未重复盖章 |
| 发起人确认 | 本人inspect completed（check-0b5c4fe9-deff-4984-a048-4ec03d8e5471）；execute check-142835be-dc8d-4721-be22-c793c0badb9d为unknown/target-unconfirmed，7动作完成、最后列表链接未出现。测试编号格式不合法，未确认通过 |
| 归档 / 完整链独立验证 | 未执行；没有完整链candidate/run/publish，不计通过 |
| 残留 | 用户已接受的唯一测试合同及测试附件，保留现场，不清理其他数据 |

管理员只读详情业务码200，确认上述记录及节点；辛晓岩账号真实登录后，同一详情接口 HTTP200但业务码403，页面提示“权限不足／详情加载失败”；其 department-tree 和 permission 两接口 HTTP200、业务码500。管理员的相应接口均为业务码200。已证实当前账号访问被拒绝；403/500的服务端根因（权限、租户或流程权限判断）仍缺服务端日志，不能仅凭状态码认定某种配置错误。不更换管理员审批，不提升账号权限绕过。

09:58（UTC+08:00）独立首页观察进一步确认：辛晓岩登录后进入 `/tenant/switch`，有「项目管理」(20220107) 和另一个租户，尚无已选择租户标记；目标合同 tenantId 也是20220107。已部署的正常登录机制要求多租户账号先选择卡片，而原验收配置缺少此步骤、直接访问目标页。因此前述403/500是在未完成租户上下文时观察到的，不能据此宣判账号需要授权或被测系统存在权限缺陷。证据为工作区 `qa/ui/tasks/approval-remediation-20261112/tenant-membership.json` 及截图。

针对实际前置条件补充最小修复：租户卡片单击即选择时省略 confirm，等待选择页完成跳转后才访问业务页；`configure-login` 仅对已登记人员修订登录选择器，须当前 baseRevision 与来源，保留旧配置及修订原因、递增版本。已执行步骤均 completed、无候选时才允许；业务账号、身份、记录、入口、审批规则及旧执行步骤不变。未知写入仍禁止修改。该操作明确替代原“冻结后连登录定位也无法纠错”的过严限制，不开放通用冻结配置修改。

生产 Agent 已使用新接口将辛晓岩登录选择器修订为版本3，随后唯一一次 inspect 成功，并已完成其部门负责人审核。原403/500阻塞在正确租户下解除；这里的成功指同一合同及本人审批入口、流转到下一节点均有真实证据，不是仅凭登录返回成功。未修改被测系统或其权限。完整链尚需后续节点及独立回放，不在首节点成功时提前结束验收。

工作区证据（下列路径相对 `/Users/liyingjun/Desktop/SW-QA/18-00work space`）：

- `qa/ui/approvals/approval-procurement-new-20261111/flow.json`：冻结步骤与真实编号。
- `check-b946e776-80fb-44d8-b443-f0357f8f3db0`：本轮最初初态失败；只读DOM证实旧 button:text-is 定位不到嵌套 span，提交按钮真实存在；修正定位器后一次 inspect 成功。
- 同 flow 下 `check-85406306-f07a-409f-bc70-d0eef1c49035`：修正后的创建前 inspect。
- 同 flow 下 `check-8c0bf926-11ae-437e-b695-015fb3d71953`：创建提交 completed、意图与20步成功轨迹、记录ID及截图。
- 同 flow 下 `check-ba97145a-d782-4ecf-9376-e9f4f74108bc`：辛晓岩 record-unconfirmed，无审批意图。
- `qa/ui/tasks/approval-remediation-20261112/{reviewer,administrator}-api-observation.json`：脱敏真实接口对照及业务状态；同目录保留截图与创建Agent报告。
- 脱敏精选事件已保存至工作区任务目录 agent-*-events.json；原始 Agent 事件与临时历史：`/private/tmp/procurement-remediation-20261112/agent-{diagnose,create,coverage}.json` 及对应 sessions 目录。

## 本轮执行路径

```mermaid
flowchart TD
  A[核对更新后的人员来源] --> B[客户端脱敏诊断及离线检查]
  B --> C[真实 Agent 原计划认证与初态观察]
  C --> D[定位器有真实证据后修正并一次验证]
  D --> E[创建提交唯一合同 completed]
  E --> F[辛晓岩身份成功 详情权限拒绝]
  F --> G[停止审批写链 保留原记录]
  G --> H[只读对照管理员与审批人接口]
  H --> K[发现多租户选择未完成]
  K --> L[仅修正登录选择器并一次inspect成功]
  L --> M[辛晓岩审核通过 转入法务审核]
  A --> I[更新来源的矩阵与三模型独立检查]
  M --> O[法务控件歧义 仅fill后暂停]
  O --> P[只读确认未提交 精确操作区定位]
  P --> Q[原节点一次纠错完成 转入合同管理员]
  Q --> U[逐人审核至董事长 完成上传定稿]
  U --> V[刘波盖章生效 结果定位失败]
  V --> W[只改结果selector 一次只读核对成功]
  W --> X[本人实际到达发起人确认]
  X --> Y[测试编号校验拒绝 停止写链]
  Y --> J[保留现场 准确覆盖交付]
  I --> J
```

恢复路径：以多租户页面新证据为依据，仅修正原人员的登录选择器，选择与合同一致的项目管理租户；沿原 flowId/recordId 一次只读 inspect，通过后从首个未执行审批节点继续。仍被拒绝则保留结果并停止，届时再依据带正确租户的证据排查服务端。不得重建合同或修改业务预期。审批人、当前待办、记录和下一节点均须逐人核对；发起人确认严格等真实到达该节点后验收。

## 法务控件歧义及有界恢复

法务账号正确租户下 inspect completed（check-902953e6-5c40-4735-88c3-699c27a182e1）。首次 execute 的 check-1f70471c-4585-4c6b-9a07-e0f8e1fb43e6 为 unknown / target-unconfirmed，actionIndex=1；原生 actions/intents 均仅一条 fill，未点击同意，已记录请求均为GET。业务页仍是法务节点；只读观察确认同意文字有两个：历史 approval-status 标签与当前 footer.form-actions 下操作按钮。不是业务提交超时，不重放已提交动作。法务节点已由生产Agent一次纠正完成（check-9744a177-92a3-4ee9-8c2b-85ab51f01aec，3条成功动作），进入合同管理员审核，原失败作为attempts保留。

新增的 retryEvidence 校验仅允许该类有完整证据的 target 失败、此前所有动作均fill、cleanup确认、原节点最多一次、仅改失败selector；before/after/人员/输入均冻结。新尝试保留旧attempts，重新登录核对原状态后才操作。已开始click/upload/select、action/after未知、预期变化或第三次尝试全部拒绝；本地夹具已验证提交生效后未知仍只能reconcile。实际唯一按钮定位为 `footer.form-actions button.primary:has-text("同意")`，不以全页文字匹配历史标签。

原记录分支只读核对（record-branch-before-gm.json）另发现顶层 chairmanReviewRequired=false，而 approverConfig.chairmanReviewRequired=true；两字段不一致按原值保留，不修改被测系统或记录。总经理节点预期只验证本人完成及同意留痕，后续按真实待办观察可选分支，不提前假定董事长已启用或已跳过。

## 定向验证与其他覆盖

最终客户端定向检查通过：

```sh
node --test --test-name-pattern='auto-login' tests/unit/ui-testing-runtime.test.js tests/unit/ui-approval-preparation.test.js tests/unit/ui-approval.test.js
node --test tests/unit/ui-approval.test.js tests/unit/ui-approval-preparation.test.js
```

第一条命令按名称筛选，仅计入 auto-login 的实际检查；第二条单独运行审批和准备检查为2项通过。增加隐藏上传输入观察及reconcileAfter后又分别运行 `node --test tests/unit/ui-approval.test.js`（1项通过）和 `node --test tests/unit/ui-approval-preparation.test.js`（1项通过）；未把名称筛选跳过项记为通过。新增单击租户选择（无独立confirm）、冻结业务下版本化登录选择器纠错、只填写意见后定位纠错一次、拒绝已提交未知结果重放与保留原尝试的检查均通过。登录检查验证失败仅提交一次、禁用按钮不发请求、凭据与查询参数脱敏；审批检查验证有限页面文字、HTTP200内业务403诊断且不泄露响应token，并保留三账号隔离、真实本地上传、完整链候选回放和未知结果只读核对。均使用临时本地夹具、不请求付费模型或访问真实账号。语法与差异检查通过；发布包、跨平台和全量测试未执行。

真实补覆盖与上述本地检查分别记录：

| 目标 | 实际任务 / 资产 / 结果 | 结论边界 |
| --- | --- | --- |
| 更新姓名及采购合同七部门矩阵 | `task-88fe3e3e-51e9-4059-b091-ec2e1bf46aaa` completed，4次模型调用、4动作、cleanupConfirmed=true；`pms-procurement-approver-matrix-updated-20261112@0001`；`run-282344b4-1bda-406e-b18c-d2d394a05641` passed，1 test、退出码0、cleanup=deleted；已发布 verified | 七行负责人/分管领导、六固定列以及新增经营发展部/市场营销部两列检查通过。此矩阵测试本身不证明真实串行；本轮另有审批专用分支的逐人串行证据，二者不混算。脚本没有精确的11列全集及顺序断言，不据此宣布 AP-01 全覆盖。 |
| 采购结果及三模型切换隔离 | `task-3f14447e-7dd5-414f-bad3-e1e5c5dcc87b` failed，2026-11-12 09:46:42（UTC+08:00）；agent-run / RuntimeError / undeclared-readonly-control，6次模型调用、5个成功动作、cleanupConfirmed=true | 成功点击采购结果选项后，下一点击目标为 LI、role=none，未匹配 contract 中 role=option 的只读声明，执行守卫停止；不放宽守卫、不原样重试。未完成采购文件及回切，未生成候选、未 validate/publish；不能将部分截图视为三模型隔离通过。 |

本轮新增独立回放只有1个 test且通过，不是48条设计全通过；旧姓名不符的 failed run 保持原值。旧采购合同↔采购文件两模型的 passed 记录也不能替代采购结果模型。本轮矩阵 case 的 S1–S5 是同一目标的多个断言，不拆成五条 test。round 快照里的 conversionRate 分母仅是 eligibleFeatures，不是48条设计；候选关联计数也不是语义覆盖率。

进一步核对脚本：人员断言使用 toContain，经营发展部还检查两人文本先后位置。因此通过证明预期姓名出现及所测顺序，不证明单元格没有额外人员、人员全集严格相等，也不证明真实审批串行执行。不能把补覆盖设计中“全等”的表述扩大为脚本已经验证的事实。

新48条逐例状态另存工作区 `qa/design/采购合同-审批流程-执行映射-2026-11-12-rev5.md`，与原设计编号集合一一对应，保留旧rev4。新映射区分已回放资产、仅业务观察、部分覆盖和未执行节点。

## 异常及处置

- 本地浏览器首次因监听本机端口 EPERM 未启动，经所需运行权限解除后登录检查通过；失败现场保留，未访问业务。
- 最初诊断 Agent 在只读分析后未按时收尾，20分钟上限触发 client aborted；没有业务写入，不再重启该阶段。后续创建 Agent 已正常收尾，不能把诊断超时写为完整通过。
- 创建 Agent 首次 execute 缺少动作数组，被校验以“每个节点需要1–40个明确动作”拒绝，尚未执行业务；补齐已准备的20步后执行成功。工具调用有两次，业务创建仅一次，未掩盖首次拒绝。
- 创建前旧选择器导致 before-unconfirmed；只读DOM与截图证明按钮存在、定位器不匹配；修正后一次验证通过。
- 首个审批人的 record-unconfirmed 之后仅做只读接口诊断及管理员状态对照，未重放审批、未改权限。当时依据业务403与基础接口500暂停；后续查明缺少多租户选择，按新证据修复并恢复，原失败保留。
- 最终并发测试暴露既有夹具预设某方必先取得文件锁，依赖调度顺序；已改为观察执行持锁后的首个请求再竞争准备操作，一次修正后定向验证通过。
- 三模型任务的只读控件不匹配已停止该分支；模型请求当次有6次成功调用，没有证据将其归因为模型服务超时。该失败不构成重启旧超时任务或放宽控件权限的理由。
- 补覆盖 Agent 保存 round 时一次因 baseRevision 过期被拒；读取实际0002后更新引用，保存0003 partial成功。随后触发20分钟上限、client aborted，未完成最终 coverage.md；已有原生 passed run 和0003快照仍有效，Agent整体不记成功，由本报告补齐交接。

round 0003 的原始计数为 plannedChecks=8、checksWithCandidate=1、missingChecks=7，包含已聚合到同一 case 的旧断言登记，不能将7解释为七个语义缺口。该冻结快照不回写。快照中“用户要求暂停AP-46”来源不准确：这是补覆盖阶段调度限制，用户总体仍要求业务验收；后续AP-46有恢复证据时另做一次定向只读取证，不能拿本阶段限制缩小总体授权。

实际业务技能由生产 Agent 读取工作区 `.pi/skills/qa-approval-workflow/SKILL.md`，执行规则通过 `qa_ui_approval instructions` 读取客户端 `resources/testing/ui/prompt/approval-control.md`。未调用钉钉审批服务。

AP-46 已在同通道恢复证据下做唯一一次定向只读恢复：`task-33ed66a5-ff3f-4690-8396-950dbce8864f`，09:54:04–09:54:31（UTC+08:00），failed / undeclared-readonly-control，2次模型返回、1个导航动作、cleanupConfirmed=true；模型生成导航带有额外尾缀，下一 BUTTON 点击不匹配仅允许 tab 的契约，被守卫停止。没有 done、字段文本或截图，不声称页面无部门字段或AP-46通过；不放宽守卫、不再重试。原两个超时任务保留。详细报告位于工作区 `qa/ui/tasks/approval-remediation-20261112/ap46-recovery.md`；其中“需新增授权”的表述是阶段Agent自行扩大的限制，用户已有总体授权持续有效，后续依本仓库有证据修复与有界验证规则处理。

创建 Agent 的阶段报告 `create.md` 中，关于“record 定位器可能与只读页面形态不匹配”的解释是当时未取证的猜测；后续接口对照已确认实际详情403，应以本报告和脱敏接口产物为准。该报告的动作列表漏列合同主要内容填写，原生 actions.jsonl 实际保留20条成功记录，本报告不据摘要漏项改动原生轨迹。

本轮验证过程另有两处工程异常：新增登录修订测试第一次因较早校验先拒绝完整config而未匹配测试预期文字，改为传同一config验证目标分支后通过；复制脱敏控件证据时自动审批审核一次超时未执行，依工具返回规则重试一次成功，没有业务调用。AP-46启动器首次拒绝含数字的阶段名，尚未创建会话，原进程退出并修正参数校验后才执行实际唯一探索。

## 后续节点的定位异常与恢复

董事长 Agent 首次 configure-login 的 selector 少了最外层右括号，check-0748ac4f-ecce-486d-b99e-e33787d35fb6 为 tenant-incomplete / tenant-selection / browser-error；此时接口业务码200，不能据此判认证或权限失败。读取实际配置与已证实的正确选择器后，版本11→12只补齐括号；一次 inspect（check-f15a7f5e-8eef-4513-b273-c2a0bb405880）成功，随后本人审批完成。首次 execute 遗漏 actorId 被参数校验拒绝、未开始业务，补齐后业务执行仅一次。原失败保留。临时 chairman-tenant-membership.cjs 未执行，不记为证据。

发起人首次上传前 inspect 使用 body 与片段文字作全等，check-eab6ca24-8093-42e5-8f64-c2addde01648 为 before-unconfirmed，pageText 同时显示真实上传区和同意按钮。只读 DOM（creator-final-controls.json）核实原发起人、节点和唯一文件输入；修正为节点级全等后，一次 inspect（check-4fc20587-f67d-4b50-bb80-36e048fd8104）成功，执行 upload-final 的4动作完成。本轮不把错误的 body 断言解释为页面缺失。客户端补齐 inspect 对隐藏文件输入框的观察，隔离夹具验证该控件可发现及完整链上传回放仍通过。

## 盖章结果定位及一次只读核对

11:01:41（UTC+08:00），刘波 `seal` 的 fill、同意和返回原合同3条成功动作均落盘，`POST .../procurement-contract/seal` HTTP200/业务200；随后页面实际进入 `BusinessProcess?kind=procurement&id=478297089609900032` 的发起人确认。Agent生成的第二个 after 错写为 `.approval-person ... .approval-status`，真实状态标签位于同一 `.approval-step` 下，因而结果核对失败；不是权限拒绝或盖章业务失败。最初口头更新提及“合同标识定位”是当时未定位的猜测，以本节DOM证据和最终结论为准。

只读 `seal-readonly-controls.json` 与 `creator-confirm-controls.json` 确认原记录、刘波意见、同意标签和新待办。新增 `reconcileAfter:{source,checks}` 仅对 after 阶段、动作完整且收尾确认的未知节点允许一次只读纠正 selector；原文字、kind、顺序和数量全等保留，禁止用于 execute。原 step/check不改，成功另存 reconciledStep，后续候选回放继承正确定位。check-1faca40a-5688-4e13-aeed-9b960fd7bf34 已确认盖章结果；没有再点盖章。隔离夹具验证拒绝修改预期、拒绝用于execute、保留原失败、无新增业务写入和回放计划继承，最终 `node --test tests/unit/ui-approval.test.js` 通过1项（74.7秒）。

## 最终停止报告：发起人确认测试数据不合法

| 项目 | 事实 |
| --- | --- |
| 时间与目标 | 2026-11-12 11:10:38–11:10:47，Asia/Shanghai；原唯一合同的发起人确认，后续归档及全链验证未完成 |
| 实际调用 | 用户目标→生产Electron/Pi Agent→qa_ui_approval instructions→seal reconcile completed→creator inspect completed→creator execute unknown；模型为既有qwen3.8-flash-next |
| 关键调用号 | reconcile `chatcmpl-tool-a7d531b2cdde56aa`；creator execute `chatcmpl-tool-bb9cbd9f002fca56`；完整顺序见 `agent-confirm-events.json` |
| 预期 | 合法测试编号、签订日期、有效期及扫描件由本人确认，流转到刘波归档并保存编号/签订日期 |
| 实际 | 7条动作完成：4次fill、1次upload、1次意见fill、1次确认click；actionIndex=7等待列表链接失败。页面仍显示发起人确认及“请输入正确的合同编号，例如 HSKJ-CGHT-2026-001” |
| 已确认原因 | 本次准备的测试输入 `QA-CG-20261112-109` 违反实际格式；该输入来自本轮验收准备错误，不能归因系统缺陷。此前未先核对该字段格式，且把错误字面值同步写入after，冻结后不可静默改为实际值 |
| 原生状态 | check-142835be-dc8d-4721-be22-c793c0badb9d unknown/target-unconfirmed，cleanupConfirmed=true，原check、7动作和意图保留；确认步骤不计通过 |
| 请求证据 | 10条已记录请求；唯一POST为 `/api/base-service/upload`，HTTP200/业务200，另有download GET；没有记录到确认业务请求。不能只凭click成功推断确认成功 |
| 只读核对 | 11:13:58–11:14:01，原详情HTTP200/业务200，recordId/名称一致，processTaskName=发起人确认、contractStatus=APPROVING、processStatus=APPROVAL、finalDraftConfirmed=0；详见 record-after-confirm-check.json |
| 部分写入与残留 | 测试扫描件上传已发生；是否形成孤立文件及其文件ID未记录。唯一测试合同、定稿及该次上传保留，不自动删文件或补交 |
| 已执行处置 | 确认Agent已正常收尾；停止确认及依赖它的归档、candidate/validate/publish；没有重复确认、上传、盖章或新建合同。只读核对不是重试 |
| 最小恢复条件 | 先核实并选择唯一、符合页面格式的测试编号，按真实表单规则建立有来源的新设计修订，显式保留原错误输入、after和失败证据；不得使用仅改selector的retryEvidence修改测试输入/预期，也不得因未流转就重放包含已成功上传的原动作序列。现有冻结计划没有通用输入/预期修订入口，本轮未扩大为任意预期编辑器 |

本人页面真实具有合同编号、签订日期、有效期、扫描件及确认按钮；此前技能中“BusinessProcess必定只读”的旧说法已在仓库和实际工作区同步修正。用户关于“到确认节点才有对应页面”的说明已被本轮实际页面验证。旧静态代码中的提示没有在本次有效输入下触发，不能声称已证明该功能缺失或系统修复必需。当前只能确认测试数据阻塞，合法输入的业务确认及归档仍待真实验收。

临时启动器事件文件在写入时曾被读取，出现一次JSONDecodeError；没有重启业务，后续读取已落盘终值成功。文件匹配和文档补丁的本机检查异常均未触发业务重放。所有业务执行Agent（含gm/chairman/upload/seal/confirm）已settled，超时阶段保留原deadline与failed，不把停止等待写成取消业务。

## 独立交付核对

生产Pi Agent以独立临时会话执行只读证据核对（sessionId与终值见工作区 `agent-final-events.json`），03:20:01Z正常收尾；报告 `qa/ui/tasks/approval-remediation-20261112/final-evidence-audit.md`。没有启动浏览器、登录或执行业务，没有把本报告写成完整链批准。核对确认48个唯一AP编号、共享1个passed test、创建至盖章的业务轨迹及确认编号错误、归档未执行；另指出顶层/配置内董事长字段差异、扫描件ID缺失及seal当前条目仍带原unknown原因。

最后一项客户端显示问题已修正，最终审批夹具1项通过（72.5秒）：今后 reconcile 成功后清理当前条目的过期reason，原失败check仍保留；本轮真实seal条目保持旧现场，不为修正文案再执行核对。字段差异及上传残留继续保留待确认。独立审计列出的后两项为本报告已披露的限制，不构成全链批准，也不能反过来宣判被测系统存在缺陷。

审批执行提示词同步补充输入前置检查：冻结确认步骤和上传前，核实编号、日期等实际格式、必填及唯一性，不用任意QA前缀替代业务编号。此为后续行为约束，未把本次非法编号尝试改记为通过，也不等于合法输入已验收。

# 审批探索与完整链测试

你正在处理测试主线中的审批分支。本文件只在用户明确要求审批，或页面/可信业务资料出现审批节点、处理人、审批记录、待办及通过/驳回/退回/转交/加签等明确语义时加载。普通保存按钮不足以触发；普通功能不预加载本文件或项目审批资料。主 Agent 调用实际登记的 `qa_ui_approval({operation:"instructions"})` 读取当前运行资源中的本文件，再按下面规则推进。browser-use 只负责报告审批线索，不自行切换人员或执行审批。

## 目标、授权和流程事实

- 保留用户的任务模式：只设计时只设计；只读探索时只观察；用户要求探索并执行完整审批链时，自动推进已授权的创建、提交、逐节点处理及终态核对，不因“审批是写操作”或“需要换账号”再次逐人请求许可。当前应用完全权限、用户在本任务中的明确授权均可作为来源；工具门禁仍按当前应用权限生效。
- 不把普通功能探索扩展成审批执行授权。只读模式被工具阻止时报告实际原因；每次确认模式直接调用工具，由应用处理本次确认，不额外制造同一授权问题。
- 按 Pi 资源发现与信任规则，加载**当前被测工作区**已登记的 `qa-approval-workflow/SKILL.md` 及本次流程、发起部门对应参考章节。技能提供业务事实、节点和人员，本文件维护执行规则，当前登记工具提供真实能力。历史资料中的旧登录/prepare/complete 命令不是现行接口，不调用、不照抄。
- 列出来源明确的实际启用节点及顺序、当前处理人、合法动作、转移条件、下一节点/处理人及终态。可选分支以本次记录配置为准；驳回不默认等于退回，同人连续节点分别核对，不跳过节点、不为凑覆盖强开分支。
- 缺少匹配流程、人员映射、必要认证、业务预期、独立测试数据或残留约定时，只阻塞依赖它的分支，保留已设计检查项及准确缺口，继续无依赖工作。不要套用其他模块的合同流程，不猜节点、账号或预期，不把看到的结果倒推为正确规则。

### 项目管理系统（pms）采购合同的已确认口径

以下为用户于 2026-11-11 对采购合同测试的补充，限当前项目测试环境；其他项目不自动继承这些业务事实或授权。

- 流程依据：读取用户指定的《审批流人员对照表（流程模型 × 部门）》，或实际工作区 qa-approval-workflow 的 `references/审批流人员对照表-流程模型×部门.md`，明确定位「二、采购合同审批流」与本次发起部门的完整行，并读取人员基线、固定角色和末尾核实范围。不得因技能正文只举经营合同案例，就断言采购合同没有流程定义。参考文件未随旧版技能安装时，先定位用户指定资料，或准确报告该参考文件未安装；不能以单条历史记录替代已指定的流程定义。
- 对照表作为用户指定的期望来源；其中待页面核实的人员、模型映射及可选节点开关仍需核对本次配置。`HSKJ-CGHT-2026-001` 的 12 条历史记录只作观察基线，不是唯一流程标准，不固定所有合同的节点数量或顺序。
- 会签规则：按用户最新确认，**串行、全部通过**。先从本记录配置取得参与人及顺序，依次核对身份并处理；前一人通过后进入下一会签人的处理环节，尚有人员未通过时不得离开该会签节点。全部参与人依序通过后，才流转至本记录配置的下一启用节点。用例分别验证前序人员通过后仍待后续人员处理、最后一人通过后正常流转，不允许跳过或提前代签。此通过条件不定义驳回语义，未确认的驳回分支仍单独保留缺口。
- 节点类型先区分：对照表中的「潘琴荣 → 朱栋华（串行）」与可选 `【会签人】` 保留各自节点定义和启用依据，均按已确认顺序逐人处理，不合并两人的动作。矩阵同一单元格列出两个人、历史同名节点出现两次，不能单独证明节点类型；以对照表和本记录配置确认参与人、顺序及待办。旧设计按本次“串行、全部通过”口径核对并生成新修订，不继续沿用“任一人通过即可离开该节点”的旧预期。
- 测试残留：用户已明确接受该测试环境留下独立采购合同测试记录，包括审批推进后不可回退的合同。相关任务使用 `cleanup=residual`，在 `residualAuthorization` 中引用本次用户“测试环境允许存在测试残留数据”的确认，不再重复询问是否接受残留。每例/每批仍创建唯一记录，交付记录名称、ID、停留节点和残留截图；不复用、删除其他业务数据。此约定不把仅设计任务变成审批执行任务，也不自动授权定时回归。

## 人员与认证

根据用户指定映射、项目已确认映射或获授权的用户目录查询取得账号。姓名不等于账号。**例如，实际到达已启用的“董事长审核”，处理人是叶圣炯，且用户已指定 `yeshengjiong` 为该节点测试账号时，可直接使用该账号执行测试审批。** 示例不作为其他项目的默认人员或拼音转换规则。

每个 actor 登记 `id/account/source/credentialSource/identity`；`identity` 是页面稳定选择器和明确身份文本。首个 actor 是创建人；每个节点指定 actorId。工具为各人员建立独立登录状态和浏览器上下文，不修改项目全局账号。

- `credentialSource:"project"`：仅可使用项目已配置的同一 account，宿主读取既有认证。
- `credentialSource:"test-password"`：仅用于已经确认共用测试密码的账号，宿主从启动环境 `QA_UI_TEST_PASSWORD` 取值。它不是新的项目配置来源；未配置则报告缺失。不同人员使用不同密码的项目目前不能使用此模式，需要单独认证能力。
- pms 采购合同测试已由用户确认使用统一测试密码，已核实的测试账号可直接采用 `credentialSource:"test-password"`，不再逐人索要密码或重复询问是否允许共用。密码正文仅由宿主通过 `QA_UI_TEST_PASSWORD` 注入，不写入本文件、技能、计划、报告、日志或命令行。已确认密码不等于宿主已完成注入；变量缺失时准确报告“宿主未注入已确认测试凭据”，只暂停依赖登录的执行，继续流程分析和用例设计。共用密码不提供账号映射，仍按真实目录或用户确认取得 account 并验证 identity。
- 可选 `login.account/password/submit` **都是控件选择器**；`login.tenant:{selector,confirm}` 是已知租户与确认按钮。不得传密码正文，不读 `.env`、Cookie 或真实凭据配置给模型，不把凭据写入计划、用例、报告或命令行。
- 登录成功仍必须核对 identity；再核对同一业务记录、当前节点及可用动作。验证码、MFA、跨站登录或身份不符时停止依赖链，不换账号绕过。
- 先调用 `preflight` 核对实际宿主配置；不带 flowId 时提供 projectId/targetUrl 及 config，可在创建计划前检查。只返回配置是否齐备、缺失项及 actorId，不返回凭据、不登录。`configured` 不代表账号认证成功；不能用 Agent 命令进程的环境检查替代 Electron 主进程预检。人员目录需核对部门、账号状态与分页，同名无法唯一匹配才请求确认。

## 工具操作与节点规程

实际工具为 `qa_ui_approval`；未登记/被禁用时报告能力不可用。`qa_ui_explore` 保持只读；审批写动作走此专用分支。整个分支沿用工作区互斥锁。每条流程使用稳定 flowId，记录在 `qa/ui/approvals/<flowId>/flow.json`，不要新建等价流程来绕过错误。

1. `instructions`：动态读取本文件，不登录或执行审批。
2. `prepare`：首次提供 flowId、targetUrl、projectId、config，保存准备阶段配置（configRevision=1）；修订时提供原 flowId、当前 baseRevision 和完整 config。仅无执行步骤、无冻结标记的计划可修订，旧配置保存在 configHistory，旧证据不改写；旧零步骤计划按版本 1 处理，旧检查证据绑定初始配置。config 含 source、record、actors、residualAuthorization。先补齐本次启用节点的人员、身份和选择器，不能指望执行后再添加人员。
3. `inspect`：首次也可同时保存 config；提供 `step:{actorId,url,before}`，隔离登录、严格核对身份，等待同一 record 和非空 before（如当前节点）后才读取控件并截图。创建前入口还须 `createsRecord:true`，仅无执行步骤时允许跳过尚不存在的 record 检查。每次检查保存 configRevision；认证失败仍处于准备阶段，可通过 prepare 校正，不手改历史或换 flowId。record 的 text 可含 `{{runId}}` 或已提取变量。残留授权按上文继承，不宣称自动清理。
4. `execute`：提供 flowId、完整 step、authorization；第二个及后续节点还需 previousStepId，精确引用最近已确认节点。先预检全部已登记人员认证配置，再认证当前处理人；失败不冻结。首次执行在同一互斥入口保存冻结版本和动作意图，再进入业务操作；此后任何 blocked/unknown 结果均禁止修改配置，不能以“可能没写入”为由退回准备阶段。每次只执行一个节点，按真实页面声明动作，不把整个流程塞成一串无状态检查的点击。节点预期在该节点首次登记后不可改写，后续节点按已核实流程追加。
5. 每个 step 必须有 id/name/source/actorId/url、非空 before/after 和 actions；after 的预期来自流程规则。首个创建节点 `createsRecord:true`，输入唯一标识 `{{runId}}`；可用 `capture:{name:"recordId",query:"id"}` 从最终 URL 提取记录标识，或用 selector/attribute 从真实页面属性提取。后续 URL/断言可以引用 `{{recordId}}`。每次操作后核对 record 及 after；最后节点 `terminal:true`，after 明确验证业务终态。把节点、下一处理人及审批记录等需要验证的内容列成独立检查。
6. actions 仅支持 `click {selector}`、`fill/select {selector,value}`、`upload {selector,file}`，动作 kind 写在对象中。file 是当前工作区内相对路径，工具拒绝逃逸与符号链接并冻结文件哈希；不猜附件或上传非测试文件。定位器必须来自真实 inspect/页面证据且唯一，密码输入仅由宿主登录处理。页面/请求受项目地址约束。
7. 每节点成功返回后保存证据，再 inspect 下一处理人的真实页面、执行下一节点，直至规则终态。默认正常链一次只执行一个合法动作序列；驳回、退回、转交等独立分支按用户范围用独立记录设计，不在正常链临时试点。

参数示意（选择器、URL、人员和来源均须换为本项目真实值）：

```json
{
  "operation":"inspect", "flowId":"approval-round-001",
  "projectId":"project-id", "targetUrl":"https://test.example/contracts/new",
  "config":{
    "source":"qa-approval-workflow 中本流程的章节",
    "record":{"selector":"[data-testid=record-name]","text":"qa-{{runId}}"},
    "residualAuthorization":{"kind":"user","reference":"本任务已接受独立测试记录残留的授权原文"},
    "actors":[
      {"id":"creator","account":"confirmed-creator","source":"已确认映射来源","credentialSource":"project","identity":{"selector":"[data-testid=identity]","text":"发起人姓名"}},
      {"id":"chairman","account":"yeshengjiong","source":"本任务用户指定的董事长账号映射","credentialSource":"test-password","identity":{"selector":"[data-testid=identity]","text":"叶圣炯"}}
    ]
  },
  "step":{"actorId":"creator","url":"https://test.example/contracts/new","createsRecord":true,
    "before":[{"selector":"[data-testid=status]","text":"待创建"}]}
}
```

```json
{
  "operation":"execute", "flowId":"approval-round-001", "previousStepId":"submit",
  "authorization":{"kind":"user","reference":"本任务完整审批测试授权"},
  "step":{
    "id":"chairman-review", "name":"董事长审核", "source":"本流程节点规则的准确章节",
    "actorId":"chairman", "url":"https://test.example/contracts/detail?id={{recordId}}",
    "before":[{"selector":"[data-testid=node]","text":"董事长审核"}],
    "actions":[{"kind":"fill","selector":"[data-testid=opinion]","value":"测试审批同意"},{"kind":"click","selector":"[data-testid=approve]"}],
    "after":[{"selector":"[data-testid=status]","text":"审批完成"}], "terminal":true
  }
}
```

示例仅描述已核实的节点格式，不代表实际流程只有提交和董事长两个节点；所有中间节点仍须实际执行并核对。首个创建节点同样用 execute，before 明确为可创建初态，actions 创建本轮唯一记录，after 核对提交后的业务状态，capture 取得真实记录标识。

## 归档与终态断言

审批人矩阵描述角色配置，时间线描述已执行动作，两者不要求列数、条数或名称逐项相等。“矩阵含归档、时间线无归档条目”先作为配置与展示差异取证，不能仅凭差集判为配置遗漏，也不能直接宣布符合设计。

1. 设计/执行前，按对应流程行和本记录配置明确归档节点是否启用、是否为人工动作及其完成证据。对照表有“刘波（归档）”时纳入待核对的期望链；不能因历史记录没有该条目就删掉。可选节点按实际开关，不从列表“已完成”倒推出归档已跳过。
2. 分别登记“审批完成”与“归档完成”的预期。审批完成核对同一记录的列表/详情完成状态、实际启用审批节点的处理人/时间/意见，以及流程要求的定稿、盖章或确认附件。会签须核对全部参与人依序通过的留痕，缺少任何参与人的处理证据不得判为会签完成；展示可以合并，但证据须能逐人核对。数量与顺序按本记录启用节点和参与人计算，不硬编码历史的 12 条时间线。
3. 已启用且需人工处理的归档节点必须实际执行，再验证同一记录的归档状态/归档信息、处理人和完成时间。时间线不是唯一证据入口，可使用真实归档页面或已授权取得的状态证据；没有时间线条目但其他来源完整证明归档成功时，不仅据缺少条目判失败。只有规则明确要求时间线展示归档记录时，才另列展示断言。
4. 若配置明确没有独立归档动作，或规定自动归档，分别按该定义验证审批完成与所需的自动归档结果，不虚构点击步骤。不强求“已完成”“已完结”“已归档”文字完全相同，先记录有来源的状态映射，再核对列表和详情的业务含义一致。
5. 审批已完成但归档仍待处理，交付为“审批完成、归档未完成”；整个范围含归档时，不能提前给最后审批节点设置 `terminal:true` 或生成完整链通过结论。归档是否启用、完成证据或状态映射仍不清楚时，只将相关断言标为待确认，保留其他已确认结果；不得把缺证据计为通过，或改写既有 DEF-PC-006 为已修复/误报。

在节点执行前冻结上述口径及准确来源，把需要验证的业务状态拆成独立 `after` 检查；`qa_ui_approval` 当前仅支持真实 selector/text（可选 kind=text/value），不得把“任一证据满足”等自然语言条件伪装成工具已有的 OR、absence 或计数断言。预期发生变化时新建候选修订并重新验证，不热改已冻结计划或历史批次。

## 异常、取消与结果核对

首次失败暂停依赖链，保留 flowId、stepId、原动作意图、截图与结果。不得原样重交、删除 flow.json/锁、改预期或换入口绕过。认证故障不作为“无数据”。

认证诊断按 code/stage 区分 credentials-missing、form-ambiguous、tenant-incomplete、identity-mismatch/identity-unconfirmed、route-mismatch、manual-authentication-required、login-unconfirmed。后续页面检查通过 record/before/target/action/after 阶段定位。诊断仅说明失败位置，不能仅凭登录未成功就断言密码错误，也不能将管理员页面上的控件作为真实处理人的入口证据。发现明确新证据、修复前置条件且操作可安全重复时，才做一次定向验证。

- `blocked`：前置身份、页面或初态未满足；未开始该节点动作。说明缺口，不把它记为执行通过。
- `unknown`：可能已有部分写入，包括超时/取消。沿原 flowId 使用 `reconcile` 只读核对原节点的 record/after/capture；创建已生效但中断时，可先用 inspect/已有证据找到本轮唯一记录，再提供真实 `targetUrl` 定位该记录（仍核对相同 record/after），不能重复 execute 原节点；核对仍不满足则保留未知。不得把“尚未观察到”解释成“没有写入”。
- reconcile 确认后可继续下一个节点；若原动作成功轨迹不完整，不能生成完整链候选。状态核对成功不能补造动作轨迹。
- 浏览器收尾未知时保留工作区锁并停止新任务；先按报告核对实际进程、记录和恢复条件。工具确认已关闭后才解除正常锁；取消信号已发送不代表业务已撤回。

## 候选、回放与交付

用户要求完整测试时，完整链确认终态后调用 `candidate`，提供 flowId/caseId/title/modulePath/contract。工具只准备草稿，不发布。contract 沿用 qa-ui-basic 的完整格式：mode=complete、role=approval-workflow、identity=首个 actor.identity、dataStrategy=isolated-write、cleanup=residual，保留 writeAuthorization 和与 config 相同的 residualAuthorization。每条 expected.text 须对应某节点 after.text（可含变量），expected.source.reference 须等于该节点 source，保证回放实际检查这些预期，不添加未实现的断言。controls/completionTexts/model/budget 仍按现行 contract 格式声明；审批节点执行与回放不额外调用模型。

执行前可先准备有来源的设计稿、步骤、断言和独立数据策略；当前工具的 candidate 仍依赖完整成功轨迹，不提前生成可回放 E2E。非处理人不可见、禁止流转请求等负向断言由独立 Playwright 用例承担；普通用例目前不自动继承审批多账号认证，需先核实角色登录能力。接口越权需明确接口契约与授权，未知驳回、撤回或归档规则保留待确认。

工具要求从创建唯一记录开始，全部节点有完整成功动作证据，最后节点为 terminal；通过后返回 taskId 和 drafts 目录。依次执行：

`candidate → qa_ui_save_candidate → qa_ui_run(mode=validate,准确revision) → 读取原生结果与证据 → passed才qa_ui_publish → 按用户范围正式回归`。

回放每批使用新的 QA_RUN_ID，为各账号重新隔离认证，重新创建专属记录，按冻结计划逐节点验证，不复用探索记录，不混合其他 case。单节点用例的设计仍按 qa-ui-case-design；本工具自动生成的是完整链 E2E，不把它拆名计为多个独立节点用例。修复任务继承冻结审批计划，不为通过变更业务规则。

探索/节点执行证据与正式批次分开：flow.json 及其证据不等于 run，也不等于发布通过。qa-test-report 按需读取本文件和实际 flow.json，列出流程/部门来源、记录标识、节点、人员与映射来源、前后状态、实际动作、证据、缺口、残留及准确 case/revision/run。功能清单保留全部审批检查项，数量和生成率按既有清单规程计算，不把一条 E2E 视为覆盖全部分支。分支结束回到测试主线的其他功能与本轮清单收尾，不因审批链完成而提前结束整个模块。

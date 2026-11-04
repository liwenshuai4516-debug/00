---
name: qa-ui-record
description: 录制并整理 UI 用例脚本：在 qa_ui_prepare(record) 后用官方 Playwright Test MCP 现场操作与断言，按断言来源、定位器、数据隔离、等待方式整理成可独立回放的 spec，并生成含断言的标准化用例列表与 qa-ui-case/v1 元数据稿，再经 qa_ui_finalize 校验登记。当 qa-ui-basic 第 4-5 步，或用户要求录制、整理、修改 UI 脚本时使用。
---

# UI 用例录制与脚本整理

## 进入条件与边界

已有 qa_ui_project 返回的 projectRef、项目地址和登录判断（saved 或 not-required）；缺任一项先回 qa-ui-basic 第 1-3 步，不跳过。
本技能只做「准备录制 → 现场录制 → 读日志 → 写脚本 → 关闭页面 → 整理说明 → finalize」，不改七步顺序，不接管回放和报告。
断言来源、业务/守卫断言、数据不变量、断言编辑和失败判定由 `qa-ui-assertion` 维护；写/改断言前加载该技能，本技能不重复展开断言规则。
不改被测业务操作流程：用户给的动作顺序、页面路径和业务规则照原样执行，只提升脚本的可验证性与可维护性。

## 测试环境授权与预期来源

- 用户已确认目标为测试环境：新增、编辑、删除、提交、审批、上传附件等页面操作全部允许，不再逐项确认；写操作仍要写进覆盖矩阵并真实执行。
- 生产/未知环境或会触发真实付款、外部通知、删除非测试数据等不可逆外部副作用的操作，仍需明确授权。
- 业务预期默认采用**页面规则（页面既有基线）**，来源标注为「页面规则」；用户需求/用例说明优先。页面规则与常识冲突时记录待确认，不擅自判缺陷。

录制前先定脚本结构：一个 test 一个业务场景，只读与写入分开，每个 test 写清初态、动作、业务结果断言和数据来源。
预期优先来自用户需求或用例说明；没有时以页面规则为默认来源并标注；页面规则无法判断的冲突再问，不边看页面边临时改标准。

## 0. 功能面盘点（录制前，必做）

进入页面后先只读盘点，再决定录哪些 case；不能只覆盖用户原话里点名的场景。
- 查询区：逐个读出筛选项；页面有展开/收起按钮时先展开，记录默认隐藏的筛选项（经营合同页默认只显示 4 项，展开后还有项目类型、合同签订日期）。
- 工具栏：查询、重置、合同发起/新建、导出、展开收起等，包括无文字、无 aria-label 的图标按钮；图标按钮先点击观察效果，再决定是否覆盖。
- 列表行：名称/编号链接、状态按钮、操作列（查看详情、审批、删除等），以及分页、排序、批量选择。
- 页面级：标签页、抽屉、弹窗、返回路径。

盘点结果写成覆盖矩阵并放入 caseDocument：

| 功能/控件 | 覆盖用例 | 说明 |
| --- | --- | --- |
| 归属部门 / 流程节点 / 项目类型筛选 | T6 / T7 | |
| 合同签订日期查询 | T8 | |
| 查询区展开/收起 | T9 | |
| 查看详情 | T10 | |
| 发起合同 | - | 测试环境允许写入；涉及后续审批时加载 qa-approval-workflow |
| 审批合同 | - | 测试环境允许审批；涉及审批时加载 qa-approval-workflow |

规则：
- 每个可见查询项、工具栏按钮、行操作、分页/展开控件都必须出现在矩阵中：有对应 case，或写明未覆盖原因；静默跳过视为违规。
- 无文字、无可访问名的控件先只读点击确认功能；最终定位器用容器+位置并注释（例如查询区右侧展开按钮）。
- 测试环境的发起、审批、删除、提交等写操作直接执行；仅生产/未知环境或不可逆外部副作用需要确认，未确认时列入未覆盖。
- 盘点决定 plan 和 case 列表；覆盖矩阵同时写进 caseDocument 的「## 覆盖范围」，finalize 前核对。
- 本次涉及审批流（提交后需要多角色审批或验证审批终态）时，单独加载 `qa-approval-workflow` 技能，审批人解析、账号切换和逐节点操作以该技能为准；本技能不展开审批步骤，普通录制不要加载它。

## 后台静默

- 登录、录制、回放默认使用无头浏览器，不打开前端浏览器或可见窗口。
- `qa_ui_prepare` 的 `headed` 默认不传；只有用户明确要求“看着执行/调试页面”时才传 `headed=true`。
- `qa_ui_login(auto)` 默认静默；需要人工验证码/MFA 时，先返回 manual-required，再按用户要求决定是否开可见窗口，不主动弹窗。
- 录制和回放的证据仍写入日志/报告，不以“没看到窗口”为由跳过断言。

## 1. 准备录制

调用 qa_ui_prepare：mode=record、projectRef、targetUrl；默认无头，不要传 headed=true（仅用户明确要求观察页面时例外）。
使用返回的 caseId、seedFile、caseFileName、caseDocument、caseFile 和 recordingDir；默认不手填 caseId，不覆盖同名资产。
仅用当前会话实际登记的官方 desktop-playwright-test 工具；未出现时停止并报告，不自建脚本或改用其他工具。

## 2. 现场录制与验证

1. generator_setup_page：plan 逐步写「动作 → 可观察预期 → 数据来源」；project=chromium；seedFile=返回值。
2. browser_snapshot 取 ref 后执行 browser_click（element、target=ref、intent）、browser_type（element、target=ref、text）、browser_fill_form（fields，每项 name/type/value/target）、browser_press_key（key）、browser_select_option（element、target=ref、values）。intent 用该步动作原文；DOM 变化或 ref 失效后重新 snapshot。
3. 每个业务步骤后立即验证：browser_verify_text_visible（text）、browser_verify_element_visible（role、accessibleName）、browser_verify_value（type、element、target、value）。验证不通过先查数据、角色权限和前置状态，不先录完再补断言。
4. 等待只用 browser_wait_for（text/textGone），不填 time 凑等待；等业务信号，不等遮罩消失或固定秒数。
5. generator_read_log（无参数），逐条核对动作与断言都已入日志；日志里的 assert 行可能只保留可访问名前缀，写脚本时用输入/计划中的完整值。日志没有的业务预期先现场验证，无法验证的写明来源和原因。
6. generator_write_test：fileName=caseFileName，code 为 CommonJS 脚本，只写日志中有证据的步骤与断言。
7. 成功或失败均调用 browser_close；关闭失败如实报告。

## 3. 四条质量线

### 3.1 断言规则

断言来源、业务/守卫断言、列表与筛选的数据不变量、web-first 写法、断言编辑同步、录制与断言失败判定，统一由 `qa-ui-assertion` 技能维护。

写断言前先加载 `qa-ui-assertion`，按其中规则生成 expect 和 caseDocument 断言；本技能只保留“每条断言必须有来源”的入口检查，不重复规则正文。

### 3.2 定位器

优先级：getByRole（role+name）→ getByLabel → getByText（业务文本）→ getByTestId → 容器内 role/name → CSS。
不得使用录制 ref 和自动生成 id；样式类只在无法用角色/标签/文本定位时使用，限定容器并注释原因。
nth 只用于同角色重复控件，先用容器或业务文本缩小范围；同一元素在多处使用抽成局部函数。
操作和断言共用同一业务定位器；不用 body 全文匹配，不依赖元素顺序。

### 3.3 数据隔离

读：用唯一业务编号/名称定位，不用第一行、最新一条或总数；筛选后断言命中记录，不假设排序。
写：唯一值（业务前缀 + 时间戳/随机后缀）并登记清理；创建后断言出现在列表；失败也尝试清理，清理失败如实报告。
每个 test 自建初态：beforeEach 导航、重置筛选和输入；不依赖前一个 test 的残留或执行顺序。
登录态只通过私有 storageState 继承；脚本、说明、日志不写账号密码、真实个人信息或生产敏感数据。
同一脚本连续跑两次结果一致；失败重跑不积累脏数据。

### 3.4 等待方式

只用 web-first 断言自动等待，不用 waitForTimeout、固定 sleep、轮询循环。
异步结果等业务信号：新行出现、按钮文案变化、toast、详情字段更新；不等 networkidle、遮罩消失或进度条。
必须显式等待时用 expect(...).toBeVisible({ timeout }) 并说明业务原因，不全局拉长超时。
不用 try/catch 吞超时后继续断言，不在条件分支里跳过断言。

## 4. 脚本结构与标准化输出

### 4.1 脚本

CommonJS + 两空格；文件内可有多个独立 test；共享前置用 beforeEach，登录不重复。
test 名称写「业务动作 + 预期结果」；步骤注释用录制 intent，不写实现细节。
不保留临时 ref、录制窗口依赖或上一个 test 的状态。

### 4.2 用例说明：元数据稿 + 含断言的 case 列表

caseDocument 必须包含 `qa-ui-case/v1` 元数据块；qa_ui_finalize 会校验并写入 .asset.json，缺失或字段不合规会拒绝登记。每个 case 必须有 `steps` 执行步骤；修改步骤后可在右侧栏「测试数据」中直接编辑，不必重新录制。
元数据块就是后续管理/分类用的元数据稿；正文用例表是从它展开的人读版本，两者必须一致。
`modulePath` 按被测系统实际左侧导航/菜单的层级填写（如 `["合同管理", "经营合同"]`），同一功能下的多份脚本保持同一路径；不要用页面路由、场景标签或猜测的层级代替。未填写时右侧目录按页面归组，仅用于兼容旧资产。

````markdown
# 用例说明

```json qa-ui-case
{
  "schema": "qa-ui-case/v1",
  "caseId": "<qa_ui_prepare 返回的 caseId>",
  "project": { "id": "<qa_ui_project 返回的 projectId>", "name": "<项目名称>" },
  "page": "/pms/OperationContract",
  "modulePath": ["合同管理", "经营合同"],
  "role": "管理员",
  "dataPolicy": "write-unique",
  "tags": ["合同", "新建"],
  "cases": [
    {
      "name": "新建合同后列表显示该合同",
      "type": "functional",
      "priority": "P1",
      "steps": [
        "打开新建合同页面",
        "填写合同名称和编号",
        "点击保存",
        "确认列表出现新合同"
      ],
      "assertions": [
        { "id": "A1", "kind": "business", "text": "新合同行可见", "source": "用户要求：新建后列表出现" },
        { "id": "A2", "kind": "business", "text": "行内包含合同编号", "source": "用户要求：列表展示编号" }
      ]
    }
  ]
}
```

## 用例与断言

| 用例 | 类型 | 优先级 | 断言 |
| --- | --- | --- | --- |
| 新建合同后列表显示该合同 | functional | P1 | A1 新合同行可见（用户要求）；A2 行内包含合同编号（用户要求） |

## 覆盖范围

| 功能/控件 | 覆盖用例 | 说明 |
| --- | --- | --- |
| 新建合同后列表显示该合同 | 本用例 | |
| 归属部门 / 流程节点 / 项目类型筛选 | - | 未覆盖：仍在折叠区，需展开后评估 |
| 合同签订日期查询 | - | 未覆盖：需展开查询区后评估 |
| 查询区展开/收起 | - | 未覆盖：图标按钮，需先只读点击确认功能 |
| 查看详情 | - | 未覆盖：名称链接，需纳入计划 |
| 发起合同 | - | 测试环境允许写入；涉及后续审批时加载 qa-approval-workflow |
| 审批合同 | - | 测试环境允许审批；涉及审批时加载 qa-approval-workflow |

## 证据与清理

- 日志：<recordingDir 下的官方日志>
- 录制目录：<recordingDir>
- 数据与清理：<唯一值规则、清理动作或不可清理原因>
````

字段规则见下表，未列字段不写；不要另造同义字段。

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| schema | 是 | 固定 `qa-ui-case/v1` |
| caseId | 是 | 与 qa_ui_prepare 返回一致 |
| project.id | 是 | 与 qa_ui_project 返回的 projectId 一致 |
| project.name | 否 | 默认用项目检查返回的名称 |
| page | 是 | 目标页面路径，含路由 hash |
| modulePath | 否 | 实际项目导航的层级路径，1-6 段非空字符串，每段不超过 60 字且不含 `/`；右侧测试数据目录按此分组 |
| role | 是 | 本批用例使用的角色 |
| dataPolicy | 是 | `read-only`、`write-unique`、`write-disposable`、`no-write` 之一 |
| tags | 否 | 非空字符串数组，建议 2-4 个模块/业务对象/场景标签；只用于搜索，不替代 modulePath |
| cases[].name | 是 | 与 spec 中 test 标题逐字一致；同文件不重复 |
| cases[].type | 是 | `functional`、`permission`、`boundary`、`exception`、`regression` |
| cases[].priority | 是 | `P0`-`P3` |
| cases[].steps | 是 | 1-50 条真实操作步骤，每条约 500 字内；按“动作 + 目标 + 输入”顺序写，不写实现细节或断言来源 |
| cases[].assertions[] | 是 | 至少一条；每条都要 text 和 source |
| assertions[].kind | 否 | `business` 或 `guard`，默认 business |
| assertions[].id | 否 | 短编号（A1/A2），便于正文引用 |

断言字段的取值和 business/guard 规则见 `qa-ui-assertion`；本表只定义元数据字段。

## 5. finalize 前自检

逐项确认，未通过先改再 finalize：
- 断言按 `qa-ui-assertion` 自检，且 spec、资产元数据、说明表三处一致；
- 元数据块 schema、caseId、project.id 与工具返回一致；
- modulePath 与实际导航层级一致，未用页面路由或标签代替；
- cases[].steps 覆盖真实操作顺序且与 spec 一致，没有把断言写成执行步骤；
- cases[].name 与 spec 的 test 标题一致；
- 正文用例表与元数据块一致；
- 「覆盖范围」覆盖全部可见筛选、工具栏按钮和行操作，未覆盖项有原因；
- 无 ref、自动 id、样式类（例外已注明）；
- 写入数据唯一并登记清理；
- 无 waitForTimeout、networkidle、轮询；
- 每个 test 自建初态，结构上不依赖前一个 test。

## 6. 失败与兜底

| 触发 | 一线处理 | 仍失败 |
| --- | --- | --- |
| 官方录制工具未登记或环境缺失 | 报告缺失路径或原始报错 | 停止；不安装依赖、不换工具、不声称已录制 |
| setup 或操作工具失败 | 重读 browser_snapshot 后重试一次，保留原始错误 | 无有效日志不 finalize，按未完成报告 |
| 现场验证不通过 | 查数据、角色权限、前置状态和步骤；按 `qa-ui-assertion` 判定录制或断言问题 | 不写未验证断言；记录未验证原因，必要时停止 |
| 日志缺失或工具报错 | 不写脚本、不 finalize | 重新录制；旧记录不冒充本次证据 |
| finalize 拒绝（语法/密码/空说明） | 修正后重新 finalize | 未 recorded-and-syntax-checked 不进回放 |

## 7. 禁止清单

- 不用实际值改断言、删断言、跳过测试来凑通过。
- 不把未真实操作的步骤写进脚本或 caseDocument；不手写 spec 冒充录制。
- 不读、不打印、不导出项目配置和凭据；密码不进入脚本、说明、报告或日志。
- 不覆盖或迁移旧资产，不改工具生成的文件名和路径。
- 不用 MCP test_run 替代返回的 CLI，不自动重放同一命令。
- 不宣称角色、权限、数据或用例已通过，除非有对应证据。

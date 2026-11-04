---
name: qa-ui-record
description: 录制并整理 UI 用例脚本：在 qa_ui_prepare(record) 后用官方 Playwright Test MCP 现场操作与断言，按断言来源、定位器、数据隔离、等待方式整理成可独立回放的 spec，再经 qa_ui_finalize 登记。当 qa-ui-basic 第 4-5 步，或用户要求录制、整理、修改 UI 脚本时使用。
---

# UI 用例录制与脚本整理

## 进入条件与边界

已有 qa_ui_project 返回的 projectRef、项目地址和登录判断（saved 或 not-required）；缺任一项先回 qa-ui-basic 第 1-3 步，不跳过。
本技能只做「准备录制 → 现场录制 → 读日志 → 写脚本 → 关闭页面 → 整理说明 → finalize」，不改七步顺序，不接管回放和报告。
不改被测业务操作流程：用户给的动作顺序、页面路径和业务规则照原样执行，只提升脚本的可验证性与可维护性。

录制前先定脚本结构：一个 test 一个业务场景，只读与写入分开，每个 test 写清初态、动作、业务结果断言和数据来源。
预期必须来自用户需求、用例说明或已声明基线；没有来源先问，不边看页面边定标准。

## 1. 准备录制

调用 qa_ui_prepare：mode=record、projectRef、targetUrl；需要可见窗口传 headed=true。
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

### 3.1 断言来源

每个 expect 对应 caseDocument 中一条「预期 + 来源」；来源写用户/需求/声明/基线，不写「页面显示」。
至少一个业务结果断言：记录出现在列表、状态变更、详情字段等于输入、错误提示出现且数据未写入。
禁止用实际值倒推预期；禁止断言 loading、骨架屏、样式类、请求码等中间态；动态值断言格式或正则，不断言具体时间、随机 ID、自增序号。
日志里的 assert 行可能把可访问名截成前缀（实测 10 个字符），最终断言用输入/计划中的完整业务值，不照抄前缀。
一个 expect 一个事实，用 web-first 断言（toBeVisible/toHaveText/toHaveCount/toHaveValue/toHaveURL），不用 expect(await ...)。
断言失败信息要能定位业务步骤：test 名称和步骤注释与 plan 对应。

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

## 4. 脚本结构与说明

CommonJS + 两空格；文件内可有多个独立 test；共享前置用 beforeEach，登录不重复。
test 名称写「业务动作 + 预期结果」；步骤注释用录制 intent，不写实现细节。
不保留临时 ref、录制窗口依赖或上一个 test 的状态。
caseDocument 写：项目、页面、角色、前置条件、测试输入与来源、真实步骤、日志路径、每项断言来源和清理动作。

## 5. finalize 前自检

逐项确认，未通过先改再 finalize：
- 每个 expect 有来源，caseDocument 已登记；
- 断言使用完整业务值，不是日志里的截断前缀；
- 无 ref、自动 id、样式类（例外已注明）；
- 写入数据唯一并登记清理；
- 无 waitForTimeout、networkidle、轮询；
- 每个 test 自建初态，结构上不依赖前一个 test；
- 断言失败信息能定位业务步骤。

## 6. 失败与兜底

| 触发 | 一线处理 | 仍失败 |
| --- | --- | --- |
| 官方录制工具未登记或环境缺失 | 报告缺失路径或原始报错 | 停止；不安装依赖、不换工具、不声称已录制 |
| setup 或操作工具失败 | 重读 browser_snapshot 后重试一次，保留原始错误 | 无有效日志不 finalize，按未完成报告 |
| 现场验证不通过 | 查数据、角色权限、前置状态和步骤 | 不写未验证断言；记录未验证原因，必要时停止 |
| 日志缺失或工具报错 | 不写脚本、不 finalize | 重新录制；旧记录不冒充本次证据 |
| finalize 拒绝（语法/密码/空说明） | 修正后重新 finalize | 未 recorded-and-syntax-checked 不进回放 |

## 7. 禁止清单

- 不用实际值改断言、删断言、跳过测试来凑通过。
- 不把未真实操作的步骤写进脚本或 caseDocument；不手写 spec 冒充录制。
- 不读、不打印、不导出项目配置和凭据；密码不进入脚本、说明、报告或日志。
- 不覆盖或迁移旧资产，不改工具生成的文件名和路径。
- 不用 MCP test_run 替代返回的 CLI，不自动重放同一命令。
- 不宣称角色、权限、数据或用例已通过，除非有对应证据。

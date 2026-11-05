---
name: qa-ui-intent
description: 识别 UI 测试请求的意图并做不改变原意的提示补全：区分录制、执行、盘点、仅设计文档和审批子集补全，补齐缺失参数与流程约束，输出原始请求、结构化意图、补全提示词和路由；当用户只给一句短语或提到审批用例补全时使用。
---

# UI 测试意图识别与提示补全

本技能只做意图识别、提示补全和路由，不调用 `qa_ui_project`、`qa_ui_prepare`、录制/回放工具，也不生成 case。补全完成后加载 `qa-ui-basic`，由它进入对应流程。

## 不改变原意

补全必须保留用户原始请求的完整原文，只在原文之外追加：

1. 对动作、对象、范围和交付物的显式解释；
2. 缺失参数的占位符或待确认项；
3. 当前 UI 测试流程必需的安全、授权、真实录制和登记约束；
4. 路由和停止条件。

不得：

- 把“录制”改成“执行”，或把“执行”改成“录制”；
- 把“审批范围”扩大成全页面覆盖；
- 把“只生成 case”改成执行完整多角色审批；
- 增加原话没有的对象、模块、角色、审批节点、业务预期或环境；
- 静默删掉原话中的限定词；
- 编造目标地址、项目、账号、密码或测试环境授权。

如果动作或范围存在会改变结论的歧义，只问一个最短问题；其余缺失项放进 `missing`，由流程前置步骤确认。

## 识别字段

| 字段 | 取值 |
| --- | --- |
| `action` | `record`、`execute`、`inventory`、`design-only` |
| `scope` | `full-page`、`approval-only`、`specified-page` |
| `deliverable` | `cases`（独立资产）、`execution-result`、`inventory`、`design-document` |
| `executionDepth` | `generate-only`、`full-approval-flow` |
| `original` | 用户原话逐字保留 |
| `missing` | 缺少的必要参数，如 `targetUrl`、`project`、`environmentAuthorization`、`roles` |
| `assumptions` | 为推进而采用的显式假设；不得写成事实 |
| `route` | 需要加载的技能和执行步骤 |

## 判定

- 出现“录制/生成用例/写脚本” → `record`；没有“回放/执行/验证”时不要再扩大成执行。
- 出现“审批流程/审批用例/审批补全”且动作是录制或补全 → `record` + `scope=approval-only`。
- 出现“执行/回放/跑一下/看结果” → `execute`；没有“录制/补用例”时不生成新 case。
- 出现“只盘点/看有哪些功能” → `inventory`。
- 出现“只输出文档/用例设计/不要录制” → `design-only`，不 prepare、不 finalize。
- “审批流程相关用例”默认 `generate-only`：只生成和登记审批 case，不默认跑完整多角色审批终态；只有原话明确要求执行/跑通/验证终态时才设为 `full-approval-flow`。

## 审批补全

当 `scope=approval-only` 时，补全只显式化审批意图，不新增业务规则或页面范围。补全后的范围限定为：

- 审批入口/按钮的可见性与权限；
- 提交、同意、驳回、确认、上传定稿；
- 当前节点、处理人和终态状态；
- 无权限或非当前处理人的阻断/提示。

非审批区域标为“本次范围外”，不写成未覆盖、失败或缺陷。产物使用新的 caseId 生成独立审批资产；不覆盖、不合并原资产。仍必须真实录制、有官方生成日志并 `qa_ui_finalize`；禁止手写 spec 或只输出设计文档。

审批业务细节由 `qa-approval-workflow` 提供；录制和登记机制由 `qa-ui-record` 提供，两者都不是本技能的替代。

## 输出契约

先输出下面结构，再按 `route` 加载 `qa-ui-basic` 继续：

```json
{
  "original": "用户原话逐字保留",
  "intent": "record-approval-subset",
  "action": "record",
  "scope": "approval-only",
  "deliverable": "cases",
  "executionDepth": "generate-only",
  "missing": ["targetUrl", "project", "environmentAuthorization", "roles"],
  "assumptions": [],
  "route": ["qa-ui-basic", "qa-ui-record", "qa-approval-workflow"],
  "completedPrompt": "原始请求 + 补全说明和约束"
}
```

`completedPrompt` 必须包含原始请求原文，并明确写出“以下补全不改变原始语义”。它只追加约束和待确认项，不覆盖原文。

## 示例

输入：

```text
帮我录制经营合同审批流程相关的测试用例
```

识别：

- `action=record`，`scope=approval-only`，`deliverable=cases`；
- `executionDepth=generate-only`：原话要求录制用例，没有要求执行完整审批；
- 缺失 `targetUrl`、`project`、`environmentAuthorization`、`roles`；不要编造。

补全提示词：

```text
用户原始请求：「帮我录制经营合同审批流程相关的测试用例」

以下补全不改变原始语义，只显式化原始请求的范围和流程约束：
- 任务：录制经营合同审批流程相关的 UI 用例。
- 范围：审批入口/权限、提交/同意/驳回/确认/上传定稿、节点推进/终态；不做全页面覆盖，非审批区域标本次范围外。
- 本次只生成并登记 case，不执行完整多角色审批终态；除非原话明确要求执行。
- 使用新的 caseId 生成独立审批资产，不覆盖或合并原资产。
- 必须真实录制并使用 qa_ui_finalize 登记；禁止手写 spec 或只输出设计文档。
- 需要补充：targetUrl、项目、测试环境授权、角色；未提供时先确认，不猜测。
```

路由：加载 `qa-ui-basic`，按审批子集录制流程执行；业务范围参考 `qa-approval-workflow`，录制和登记细节参考 `qa-ui-record`。

## 边界

- 本技能不执行工具、不创建目录、不登录、不录制、不 finalize。
- 补全结果与原话冲突时，停止并请用户确认，不能自行改写原意。
- 只补全提示词，不把补全内容写成已确认的需求或业务事实。

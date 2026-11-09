---
name: qa-ui-assertion
description: 核对只读 UI 候选的预期来源、业务断言、稳定定位与独立初态证据；排查断言失败时使用，不启动测试、不改变任务预期。
---

# UI 候选断言

## 来源与一致性

expected 在探索前冻结，每条 id/text/source 沿用任务约定。来源为用户要求 user、页面明确规则 rule 或已确认基线 baseline，保留可定位 reference。实际结果、截图或模型猜测不能倒推预期。

case.json 使用 qa-ui-case/v1。assertions.kind 为 business 或 guard；每条 expected 至少有一条 business 的 expectedId 引用，文字与脚本含义一致。guard 只检查导航、身份或初态，不能替代业务结果。steps.stepId 引用 actions.jsonl 的真实成功动作，不补造轨迹。

## 业务断言

- 查询与详情核对唯一业务名称/编号和字段关系，不用首行、最新一条或请求成功码推断正确。
- 筛选检查所有可见行符合条件；分页区分当前页与全部结果。不硬编码当天总数，不假定结果必然非空；固定隔离数据例外须有来源。
- 重置与筛选前基线比较；日期、状态逐行检查。动态值检查有来源的格式或关系。
- 不只检查 loading、骨架、样式或没有报错。

## 脚本与证据

一例一 test，采用 @playwright/test 的 web-first expect，稳定 role/name 或业务属性定位。无 first/nth、临时 ref、固定 sleep、skip 或 catch 吞错。新上下文先核对身份与可重复初态，附 qa-initial-state 截图；业务断言后附 qa-business-result 截图；隔离写任务还须保存并 attach qa-cleanup 清理证据。截图不替代断言，凭据不进入脚本或日志。

qa_ui_save_candidate 仅静态检查并冻结 revision。只有 qa_ui_run 的独立原生结果才能判断回放，准确版本验证通过才可 qa_ui_publish。冻结后不修改版本文件，修改草稿后保存新候选。已有正式用例自动修复尚未接入。

## 失败处理

先读原始错误、失败截图、任务约定和成功动作，区分前置身份/数据、定位器、步骤和产品行为。不能只凭 Expected/Received 的差异认定断言有错。不为通过改预期、删断言、缩小范围或改被测业务代码。

工具、环境或收尾未知时停止依赖链，保留 task/run 和证据。只生成候选的任务不启动验证，已有定向验证不重复启动。交付实际状态、证据、已确认原因与待确认项。

# 测试报告

测试报告是 UI 测试与接口测试共用的结果层：两种执行器写同一份 `qa-report/v1` 摘要，右侧边栏「测试报告」统一聚合展示，Agent 按 `qa-test-report` 技能交付结论。报告只读，不重跑、不修改脚本、不改写原始结果。

## 存放位置

| 类型 | 批次目录 | `kind` |
| --- | --- | --- |
| UI | `qa/ui/runs/<runId>/summary.json` | `ui` |
| 接口 | `qa/api/runs/<runId>/summary.json` | `api` |

UI 批次由 `resources/testing/ui/run.cjs` 写入；接口测试后续由对应执行器写入同结构文件。旧 UI 批次没有 `schema`/`kind` 时，报告服务按所在目录推断为 `ui`。

## 公共字段

```json
{
  "schema": "qa-report/v1",
  "kind": "ui",
  "runId": "批次编号",
  "status": "passed",
  "startedAt": "2026-11-04T06:00:00.000Z",
  "finishedAt": "2026-11-04T06:01:00.000Z",
  "targetUrl": "https://example.test/path",
  "project": { "id": "pms", "name": "项目管理系统" },
  "caseIds": ["case-a"],
  "testCount": 2,
  "counts": { "passed": 1, "failed": 1 },
  "cleanup": "deleted",
  "tracePolicy": "disabled-for-private-auth",
  "problems": [],
  "tests": [
    {
      "title": "业务动作 + 预期结果",
      "file": "相对路径",
      "line": 12,
      "status": "failed",
      "durationMs": 800,
      "errors": [{ "message": "断言错误摘要" }],
      "attachments": [{ "name": "failure.png", "contentType": "image/png" }]
    }
  ],
  "versions": { "node": "22.19.0", "playwright": "1.64.1", "files": [] },
  "limits": "报告边界说明"
}
```

必填字段为 `schema`、`kind`、`runId`、`status`、`startedAt`、`finishedAt`、`testCount`、`counts`、`tests`。其余字段按实际填写；接口测试可用 `tests[]` 表达接口场景，`file` 写脚本或场景相对路径。

## 状态与通过条件

- 批次状态只使用 `passed`、`failed`、`incomplete`、`cancelled`。
- 逐例状态保留 `passed`、`failed`、`timedOut`、`skipped`、`flaky`、`expected-failure`、`cancelled`、`interrupted`、`not-run`、`unknown`。
- 只有同时满足以下条件才是 `passed`：至少一条测试；所选脚本/场景都有结果；全部实际 `passed`；退出码为 0；无原生报告缺失、证据缺失、版本变化或清理失败。
- 缺少报告、统计为空或无法确认时为 `incomplete`，测试数记为未知，不能当成零用例通过。
- 取消不冒充断言失败；断言失败不能直接推定产品缺陷，根因不明写未知。

## 右侧栏

工作台第三张卡片「测试报告」进入：

- 读取当前项目 `qa/ui/runs` 与 `qa/api/runs`，按完成时间倒序聚合；顶部显示报告总数、通过/失败/其他批次数量。
- 支持「全部 / UI / 接口」筛选；每张卡片显示类型、状态、完成时间、用例数和逐例统计。
- 展开后才读取详情；显示目标、范围、耗时、清理、trace 策略、逐例状态/错误/证据名、摘要问题、版本和报告文件路径。
- 主进程只接受项目编号、报告类型和批次目录名；限制 50 份报告、单份摘要 2 MiB、详情 100 条，跳过隐藏目录、符号链接和损坏文件。
- 报告只读：不删除批次、不重跑、不修改原始摘要。报告正文仍可能含业务数据，按测试数据管理。

## Agent 交付

Agent 在 UI 或接口批次结束后加载 `qa-test-report`，按以下顺序交付：

1. 结论与统计：批次状态、通过/失败/跳过、是否满足通过条件。
2. 范围：项目、地址、角色、caseId/接口场景、runId。
3. 失败与异常：逐例状态、失败步骤、原始错误摘要、证据位置。
4. 清理与限制：私有登录态、测试数据或外部副作用的清理状态；未知和失败必须披露。
5. 证据与版本：summary/summary.md/manifest、原生结果、Node/Playwright 版本和清单覆盖范围。
6. 未覆盖：未执行场景、被测部署版本未知和依赖闭包边界。

## 安全

- 不写入账号、密码、token、cookie、私有登录态或完整敏感响应。
- 报告、截图和错误信息可能含业务数据；只把可公开的必要片段写进结论。
- 页面和模型都不能直接指定任意报告路径；报告服务从项目工作区解析固定目录并校验边界。

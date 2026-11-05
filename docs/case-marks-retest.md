# 用例标记与条件复测

测试数据面板把“自动运行结果”和“人工处理状态”分开。运行结果来自 `qa-report/v1`，只读；人工标记保存在项目工作区的 `qa/data/ui/cases/.case-state.json`，不修改 spec 或生成资产。这样重新 finalize 不会覆盖人工判断，删除资产后残留标记也不会进入列表。

## 流程状态

| 值 | 显示 | 含义 |
| --- | --- | --- |
| `pending` | 待人工验证 | 最近失败，需要人工判断是产品问题、数据问题还是脚本问题 |
| `retest` | 待复测 | 已处理或修复，下一次条件复测只跑这些用例 |
| `verified` | 复测通过 | 复测或人工确认已通过 |
| `confirmed` | 确认失败 | 人工确认真实缺陷，暂不进入自动复测 |

用例默认没有流程标记。最近一次运行结果仍单独显示在用例头部，不因为设置流程标记而改写报告。

### 自动转换

列表读取到比标记更新的运行结果时，只做两种转换：

- `pending` / `retest` + 新的 `passed` → `verified`
- `verified` + 新的 `failed` / `timedOut` → `pending`

`confirmed` 不变；`retest` 再次失败仍是 `retest`。其余判断保留人工操作。

## 面板操作

- 用例头部显示最近运行状态和流程标记。
- 展开用例后可设置流程标记；选中多条后可在批量栏统一设置。
- 顶部筛选支持全部状态、最近失败、待人工验证、待复测、复测通过、确认失败。
- “生成执行提示”按当前范围生成提示词并插入输入框，不自动发送：
  - **条件复测**：只选 `retest`、`pending`，以及没有流程标记但最近失败/超时的用例；`confirmed` 和 `verified` 不自动进入。
  - **全量复测**：选择全部标准化用例。
  - 两种范围是单选项，不能同时执行。

“条件复测”和“全量复测”不会合并成一个批次；生成提示词时只包含当前选择的一种范围。

## 精确到单条 test

一个 `.spec.cjs` 可以包含多个 `qa-ui-case` 用例，只传 `--cases` 会执行整份脚本。条件复测因此使用 Playwright `--grep`，按用例标题精确过滤：

```bash
execute.cjs --project pms --cases 合同 \
  --grep '.*\sT2 权限拒绝时列表为空$'
```

- `--cases` 仍用于选择脚本，`--grep` 只运行标题匹配的测试。
- 面板按脚本分组生成多条命令；每组只包含该脚本的目标测试标题。
- 标题中的正则字符由面板转义；提示词里用单引号参数，Agent 传入时应保持为一个参数。
- 没有使用 `--all` 的条件复测不符合要求；`--all` 只用于全量复测。

## 执行与刷新

1. 在面板设置流程标记；条件复测至少需要 `retest`、`pending` 或最近失败用例。
2. 选择“条件复测”或“全量复测”，点击“生成执行提示”。
3. 在输入框确认后发送；Agent 使用 `qa-ui-execute` 的 `execute.cjs` 执行。
4. 每组执行后读取 `summary.json`；通过的条件复测用例会在面板下次刷新时自动变为“复测通过”。

面板不会自动重跑失败批次，也不直接改写报告。条件复测失败时保留原流程标记，由人工继续处理。

## 边界

- 标记文件最多 1000 条，一次最多标记 100 条；写入使用同目录临时文件和原子替换，权限 `0600`。
- 只接受 `qa/data/ui/cases/*.asset.json` 中实际存在的用例；越界路径、符号链接、未知用例和非法状态拒绝。
- 状态文件损坏时明确报错，不静默覆盖原文件。
- 全量复测包含所有标准化用例；条件复测的“最近失败”按摘要中的 `failed` / `timedOut` 计算，不包含 `skipped`、`flaky` 或未运行。
- 自动状态转换只依据 `finishedAt` 晚于标记时间的运行结果；历史缺失时间不补零，也不猜测。
- 面板生成的是提示词，不是直接执行按钮；实际执行、认证和报告仍由 Agent 按 UI 测试技能完成。

## 验证

```bash
node --test tests/unit/test-data-service.test.js tests/unit/execute-cli.test.js
node --test --test-name-pattern="login-batch" tests/unit/ui-testing-runtime.test.js
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron --no-sandbox --disable-gpu tests/ui/test-data-catalog.check.cjs
```

页面检查覆盖标记保存、状态筛选、条件/全量提示词和横向布局；服务测试覆盖状态转换、路径校验和损坏文件；运行时测试覆盖 `--grep` 只执行单条测试。

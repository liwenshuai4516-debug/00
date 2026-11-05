---
name: qa-ui-execute
description: 只执行已有标准化 UI 用例：按 caseId 单项、批量或定时回放，生成原生报告与摘要。不录制、不盘点、不改脚本；当用户要求跑某些 case、回放、定时执行或看执行结果时使用。
---

# UI 用例独立执行

## 适用与边界

- 只执行 `qa/data/ui/cases/*.asset.json` 已登记、且 spec 与登记哈希一致的用例。
- 不进入录制、功能面盘点、用例编辑或 finalize；需要新增/修改用例时改用 `qa-ui-basic` / `qa-ui-record`。
- 一次命令跑选定 case，不重复执行同一批次；失败不自动重跑，不把失败改成通过。
- 测试环境默认允许执行、造数和必要写操作，不再询问授权；生产/未知环境仍需用户确认。
- 账号由项目配置/系统管理提供；多角色账号从用户管理读取，不向用户索要账号或密码。
- 权限、账号、造数不询问；测试环境直接执行，只有生产/未知环境或不可逆外部副作用才暂停。

## 后台静默

- CLI 默认无头登录并 headless 执行，不打开前端浏览器；正常执行不要传 `--headed`。
- `--headed` 只用于排查登录/页面问题，用完即恢复默认。
- 定时任务始终用默认无头模式；失败看 summary，不靠观察窗口。

## 快速命令

在仓库根目录执行：

```bash
resources/testing/ui/bin/node resources/testing/ui/execute.cjs \
  --project <项目编号或名称> \
  --cases <caseId1,caseId2>
```

批量跑当前项目全部匹配目标的用例：

```bash
resources/testing/ui/bin/node resources/testing/ui/execute.cjs --project <项目> --all
```

常用选项：

| 选项 | 作用 |
| --- | --- |
| `--project` | 必填，项目编号或名称（读 `config/projects.local.json`） |
| `--cases` | 逗号分隔的 caseId |
| `--all` | 当前项目、当前目标地址下的全部已登记用例；同项目有多个目标时需配合 `--url` |
| `--url` | 覆盖目标地址，必须与项目配置同源 |
| `--storage-state` | 复用已有登录态（文件），适合验证码/MFA/SSO |
| `--tenant` | 登录后租户名称，默认 `项目管理` |
| `--headed` | 登录窗口可见，仅调试 |

登录默认用项目配置账号密码无头自动登录；不打印凭据。遇到验证码、MFA、跨站登录或租户无法自动选择时，先用 `qa-ui-basic`/应用登录生成 storageState，再传 `--storage-state`。

## 执行步骤（Agent）

1. 确认项目和 caseId：从测试数据目录或面板取已登记 case；不要临时拼 caseId。
2. 只调用一次执行命令；stdout 最后一行是 JSON：
   ```json
   {"status":"passed","summaryFile":".../summary.json","testCount":3,"counts":{"passed":3},"exitCode":0,"cleanup":"deleted","problems":[]}
   ```
3. 默认只读 `summaryFile` 的 `status`、`testCount`、`counts`、`problems`、`tests`；不要展开 `stdout.log`、`results.json` 或源码，除非需要定位失败。
4. 报告：加载 `qa-test-report`，按统一 `qa-report/v1` 状态、通过条件和证据顺序交付；UI 批次额外说明 runId、summary 路径和 tracePolicy。退出码非 0 或 `status` 非 `passed` 时不得说通过。
5. 不做自动重跑；需要新批次时重新执行命令。用例脚本已变更时 CLI 会拒绝，先回到录制/ finalize 流程。

## 定时执行

用系统 cron/launchd 直接调 CLI，不经过 Agent 和 MCP，token 成本为零。示例：

```cron
0 9 * * * cd /path/to/17-00 && resources/testing/ui/bin/node resources/testing/ui/execute.cjs --project pms --cases caseA,caseB >> qa/ui/execute.log 2>&1
```

定时任务建议使用 `--storage-state` 或确保项目凭据长期有效；登录失效时命令以非 0 退出，保留日志，不自动重试。`qa/ui/runs/` 下每次生成独立批次；按需清理旧批次。

## 失败处理

| 现象 | 处理 |
| --- | --- |
| 找不到项目/配置 | 检查 `config/projects.local.json` 的编号或名称；不要打印配置内容 |
| case 不属于项目或目标地址不一致 | 确认 caseId 与 `--url`；不要跨项目混跑 |
| 脚本与登记哈希不一致 | 回到 `qa-ui-basic`/`qa-ui-record` 重新 finalize |
| 自动登录失败 | 用 `--storage-state`，或先在应用完成登录；不要反复提交凭据 |
| 批次 incomplete/证据缺失 | 读 summary 的 `problems`/`tests`；保留失败报告，不宣称通过 |

## 与工作流的关系

`qa-ui-basic` 的步骤 1–3 + 6–7 是执行能力；本 skill 把它们封装成一条 CLI 调用。只执行时优先加载本 skill，不加载录制、盘点和报告全流程，减少 token 与无关工具调用。

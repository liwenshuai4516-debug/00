---
name: qa-ui-execute
description: 按 caseId 或项目执行已发布的 UI 正式版本，读取原生报告和摘要。不探索、不生成候选、不修改资产、不自动修复；用户要求回归、回放已有用例或查看执行结果时使用。用户明确要求“执行并修复”时先按本技能执行，再转 qa-ui-basic 的修复流程。
---

# UI 正式用例执行

## 输入与范围

- 仅执行 `qa/ui/cases/<caseId>/asset.json` 的 `currentRevision`；该版本须有 `validatedRunId`，且 `case.spec.cjs`、`case.json` 与登记哈希一致。
- 一例一 test。按 caseId 选择，不按标题正则筛选，不读取旧平铺资产，不迁移旧数据。
- 只读任务要求 `dataStrategy=read-only`；用户明确授权的隔离写任务要求 `isolated-write` 且 `cleanup=in-test`，并按任务记录的写授权执行。普通回归不修改预期、版本、正式引用或已有结果；发现数据未清理时报告残留，不做自动重放。
- 使用项目已配置账号后台登录，每批新建私有状态和回放上下文；不动态发现业务账号、不切换用户、不读取 `.env` 或让模型查看真实配置。
- 目录和登录成功不等于业务身份正确；脚本必须核对任务声明的身份、初态与业务预期。

## 独立 CLI

使用客户端的绝对执行器路径：开发仓库为 `resources/testing/ui`，安装包为 `process.resourcesPath/testing/ui`；CLI 自动识别随包 `lib` 并据项目登记取得真实工作目录，启动命令的目录不决定资产归属。模拟资源布局已检查，真实安装包与其他平台尚未验收。

```bash
/path/to/client/resources/testing/ui/bin/node /path/to/client/resources/testing/ui/execute.cjs \
  --project <项目编号或唯一名称> --cases <caseId1,caseId2>
```

执行所选项目的全部正式用例：

```bash
/path/to/client/resources/testing/ui/bin/node /path/to/client/resources/testing/ui/execute.cjs --project <项目编号> --all
```

- `--cases` 与 `--all` 二选一；同批必须具有同一目标地址、角色和身份标识。不一致时停止，按已确认范围拆分；不能覆盖目标或猜账号。
- `--all` 忽略尚未发布的候选及旧平铺文件。显式选择候选、错误项目、被改动的版本或链接路径时报错。
- `--config <绝对路径>` 可指定项目配置，默认客户端 `config/projects.local.json`；不要把文件内容读入模型。
- 不支持旧标题筛选、动态账号发现、外部登录态、可见窗口或目标覆盖参数。面板按项目和 caseId 生成当前正式版本的执行命令。
- 不调用模型或 browser-use；CLI 和 `qa_ui_run` 共用执行实现、工作区锁、后台登录、取消及报告逻辑。生产会话已接入四工具；普通回归只调用 qa_ui_run 的 regression 模式。

## 执行与交付

1. 确认用户选择的项目、caseId 和执行范围，不扩大为全量测试。
2. 执行一次命令。stdout 最后一行 JSON 包含 `runId`、`status`、`revisions`、`summaryFile`、`testCount`、`counts`、`exitCode`、`cleanup`、`problems`。退出码 0 且 status 为 passed 才能报告通过。
3. 读取摘要，按需核对原生 `results.json`、HTML 和 `manifest.json`。报告准确版本、逐例状态、失败、清理和限制；报告交付遵循 `qa-test-report`。
4. 取消使用原进程的 SIGINT/SIGTERM，等待执行器终值和收尾。已发信号不等于取消完成；收尾未知会保留工作区锁，不能删除锁后重跑。
5. 首次异常停止依赖链，保留 run/task 和证据。没有新恢复依据不得原样重跑、切换账号、改预期或重新创建等价批次；写入结果未知先只读核实，确认本次对象状态后再决定是否继续。

每次实际回归生成 `qa/ui/runs/<runId>/`。正常失败和取消也保留报告，清理私有登录态；准备或登录失败可能只有 task.json，以其中的状态和原因报告，不能伪造摘要。强制杀死进程或系统崩溃不保证收尾。

## 受阻处理

| 情况 | 下一步 |
| --- | --- |
| 项目名称重复或目录不符 | 使用明确项目编号，核对项目登记；不打印凭据 |
| 尚无正式版本 | 返回候选验证和发布流程，不能用候选冒充正式用例 |
| 版本哈希变化 | 保留现场，创建新候选；不重算哈希掩盖变化 |
| 混合目标或身份 | 按确认的范围拆分 case，不改已有任务约定 |
| 验证码、MFA、认证受阻或 IndexedDB | 返回 blocked 原因；当前不支持人工接管或外部状态绕过 |
| 失败、incomplete 或状态未知 | 依据原报告定位原因，列出最小恢复条件；不自动修复或重试。用户明确授权修复时，保留失败批次并转 qa-ui-basic 的“执行并修复”流程 |

定时调度可调用同一 CLI；本技能不创建计划任务。登录失效时以非 0 退出，不自动重试。

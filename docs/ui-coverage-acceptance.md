# 本轮 UI 功能清单验收

日期：2026-11-10，Asia/Shanghai（UTC+08:00）。实现入口为 `src/main/capabilities/ui-testing/coverage.mjs`，由已有工作流锁和 `qa_ui_coverage` 接通。业务规程只在 [本轮清单规程](../resources/testing/ui/skills/qa-ui-basic/references/coverage.md)维护。

## 验证范围

```bash
node --test tests/unit/ui-coverage.test.js tests/unit/permission-gate.test.js
NODE_OPTIONS="--require $PWD/tests/helpers/pi-test-isolation.cjs" node --test tests/unit/ui-testing-runtime.test.js tests/unit/ui-readonly-workflow.test.js tests/unit/ui-packaged-layout.test.js tests/unit/prompt-content.test.js
```

第一组 14 项通过，覆盖真实候选保存后的转换统计、多个 case 对同一功能去重、修订去重、历史复用、受阻及待确认项留存、零分母、部分收尾、版本冻结、删除资产后的历史读取、错误预期映射、手动占位稿拒绝、哈希变化、验证结果缺失、项目/链接边界、取消、共享锁和并发保存。验证状态负例使用显式摘要夹具，不冒充实际回放结果。

增加提交前草稿变化校验后，第一组再次定向通过。探索提示词还通过 `resources/testing/ui/browser-use/.venv/bin/python -B tests/helpers/browser-use-prompt.check.py` 的 3 项离线检查，核对实际输入组装、缺文件失败与随包相对路径；该检查不启动真实浏览器或模型。

第二组首次 3 项通过、4 项因环境权限失败：提示词与真实 SDK 的资源登记/禁用/替换通过；本地监听和 Chromium 启动被拒绝。经一次权限调整，仅恢复四项受阻检查：

```bash
NODE_OPTIONS="--require $PWD/tests/helpers/pi-test-isolation.cjs" node --test --test-name-pattern '生产入口|打包资源布局|auto-login|内置运行时核验' tests/unit/ui-testing-runtime.test.js tests/unit/ui-readonly-workflow.test.js tests/unit/ui-packaged-layout.test.js
```

恢复检查 4 项通过，无失败或跳过。生产工厂使用临时官方 SDK 会话，确认五工具登记一次及禁用行为；通过真实本地 Chromium 回放、验证和发布后，保存本轮汇总并核对转换率、准确版本的 passed 与发布状态。随包布局检查从临时 lib 加载新增统计模块并完成原回放链路，未修改生成的运行副本。未读取真实账号、模型认证或请求付费模型。

## 异常与恢复

| 项目 | 记录 |
| --- | --- |
| 任务与结论 | 本轮清单接入；2026-11-10 UTC+08:00。集成检查错误日志时间为 15:01:35；其余异常精确时刻未记录。依赖链在错误后停止；四项集成检查在一次权限调整后通过 |
| 调用链路 | 实现请求 → 原生文件/命令工具 → node:test → 隔离 SDK / 本地服务 / Chromium；未使用执行技能，未调用外部业务或模型服务。仓库内 SKILL.md 作为待维护的业务源码读取，不用于执行真实测试任务 |
| 工具与原始错误 | functions.exec 首次编排字符串未闭合：SyntaxError，未执行命令；初始夹具缺运行时目录：ERR_INVALID_ARG_TYPE，5 项均未进入统计；文档补丁匹配不存在的行：apply_patch verification failed，未写入该批次；集成组退出 1：listen EPERM 127.0.0.1、Chromium bootstrap_check_in Permission denied (1100) |
| 原因与证据 | 前三项为本次编排/夹具/补丁前置错误，修正后验证通过；集成日志明确给出本地监听与系统进程权限拒绝，不推断为网络或业务失败。原工具会话：70507；恢复会话：59422 |
| 已执行处置 | 编排修正后执行一次；夹具按实际 resolveUiTestingRuntime 参数补齐后一次恢复通过；补丁核对实际标题和落盘差异后一次修正成功；停止原集成进程并读取全部错误，调整权限后仅恢复受阻四项一次，退出 0。未换模型、重建浏览器任务或读取真实配置绕过 |
| 保留现场 | 初次集成目录保留于系统临时目录：ui-readonly-TkVdFm、qa-ui-packaged-n9BjJa、ui-runtime-PcQLyQ；完整绝对目录前缀为 /private/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T。本次无未知业务写入；初始化失败的临时单元夹具已按其清理钩子移除 |
| 影响与边界 | 定向单元、隔离 SDK、受控浏览器及模拟随包布局已验证；真实模型能否持续登记全部发现、实际业务清单完整性、强制结束后的未保存内容与真实安装包仍未验收。右侧报告面板不展示本轮清单，本轮产物通过文件链接交付 |

验证通过不表示浏览器探索、功能事实确认和业务语义核对已成为客户端自动服务。主 Agent 仍按提示词负责队列、事实核实、范围判断和保存时机；工具负责确定性引用检查、留档和统计。

# DeepSeek Harness「代码工作视图」复用评估

评估日期：2026-11-05。对象为本机安装的 DeepSeek Harness `0.2.1-rc.5`（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内 `dsh/`，只读解包分析）。只读源码与包内 README，未运行该开关的前后界面对比，未改动本项目源码。前一轮对话界面复用评估见 [DSH 对话界面复用评估](dsh-ui-reuse-assessment.md)。

## 结论

1. **界面组件不能直接复用。** 该开关关联的三块界面都建立在 React 18、Cordis 插件、slot 组合和 DSH 会话投影之上，依赖未随安装包单独发布的 `ui-primitives`、`ui-slots`、`client-store`；本项目渲染层是原生 DOM/ESM、无打包器，没有对接边界。
2. **Host 侧的「每轮改动」记录逻辑可以移植。** `dsh-workspace-changes` 是约 1100 行纯 Node + git 逻辑（MIT），不依赖 React，主要成本在适配本项目的主进程服务、Pi 工具钩子和 IPC，而不是理解算法。
3. **「运行轨迹」和「Agent 预设」不建议按 DSH 形态复刻。** 轨迹是八千行级的独立视图，收益与本项目已有的内联「处理过程」重叠；预设是 Cordis 插件组合，本项目与 Pi SDK 都没有对应语义，只能另做产品设计。

## 一、这个开关实际控制什么

设置项为 `ui-settings` 配置表单中的 `developerTools.enabled`，中文文案「显示代码工作视图」，**默认 `true`**（新安装和缺省值都启用完整界面）。切换成功后会上报 `code_work_view_toggle`，并作为 `code_work_view_enabled` 埋点属性。关闭后影响三处：

| 能力 | 关闭后 | 源码位置 |
| --- | --- | --- |
| 运行轨迹标签页 | 对话视图环中隐藏 `trajectory` 标签页 | `dsh-client-ui-conversation` 的 `viewTabs()` |
| 本轮改动文件卡片与 review tab | 不展示卡片、不请求改动摘要；显式交付卡片与正文文件链接保留 | `dsh-client-ui-deliverables` 的 `showCodeDiff` |
| Agent 预设 | 只保留 standard、creator 和自定义预设，隐藏需要编码工具的 `ptc`、`minimal` | `dsh-client-ui-agent-preset` 的 `requiresCodingTools()` |

关闭时还会清空尚未应用的预设选择，并把已保存的 `ptc`/`minimal` 默认值回退为 standard；已有会话保留原预设。**注意**：预设切换本身在关闭状态下仍然存在，开关控制的是「完整预设名单」，不是「有没有预设」。这正是本项目无法照搬的部分——本项目根本没有预设名单。

## 二、三项能力的实现构成

| 能力 | 包与体量 | 依赖 |
| --- | --- | --- |
| 运行轨迹 | `dsh-client-ui-trajectory`，392 KB / 8246 行 React | 会话窗口投影、虚拟化、时间概览、检查器、图片缓存 |
| 本轮改动 | Host `dsh-workspace-changes` 1097 行 + 客户端 `dsh-client-ui-deliverables` 111 KB | git、`diff`、`fs`/`subprocess` 服务、会话事件总线、右侧 Sidebar |
| Agent 预设 | `dsh-agent-preset` + `dsh-agent-preset-registry` | Cordis 插件组合、preset 设置命名空间、会话重建 |

`dsh-workspace-changes` 的做法值得单独记录：每轮 `turn/start` 用临时 index 和 `write-tree` 给 git 工作树拍基线；文件工具编辑前把目标整文件复制到会话临时目录，轮末再复制一次；轮末用 `diff-tree --numstat -M` 与 `agent/turn-stopping` 汇总，只向会话日志追加一条 `workspace/changes` 事件。摘要和逐文件对比留在 Host 内存，Session 释放即丢弃，Host 重启后历史轮次没有卡片和对比。无 git 时退化为只列文件工具改动；二进制、超过 2 MiB、逐行对比超时（默认 100 ms）都有降级。

## 三、复用判断

| 能力 | 直接复用组件 | 可移植部分 | 结论 |
| --- | --- | --- | --- |
| 开关本身 | 否（React 表单） | 「一个开关统一门控开发者能力」的形态 | 半天内可自建 |
| 本轮改动记录 | 否 | git 快照、编辑前后捕获、numstat、超时降级 | 值得移植，5–8 人日 |
| 改动卡片与 review | 否 | 卡片信息结构、行数徽标、review 交互 | 用原生 DOM 重写 2–3 人日 |
| 运行轨迹 | 否 | 轮次/工具/耗时/token 的记录模型 | 可做精简版，3–5 人日 |
| Agent 预设 | 否 | 仅「预设即能力组合」的概念 | 不建议，属新产品设计 |

## 四、本项目现状与差距

已有、可直接借力的部分：

- Pi 原生事件已投影到页面（`output-event-adapter.js`）：工具调用、结果、`durationMs`、usage、`stopReason`、`nestedCalls`。
- 内联「处理过程」已按请求组织工具卡片、思考和计时；轮次导航轨（`turn-rail.js`）按用户消息定位。
- 文件差异渲染已存在（`proposal-diff.js`，LCS 逐行），右侧栏有文件浏览、文件预览和工作目录边界校验。
- 主进程已有 `runIdleOperation` 串行入口、会话级状态存储和受限 IPC/preload。

差距：

- 主进程**完全没有 git 依赖**，也没有「每轮基线/改动摘要」的数据模型和落盘位置；Pi 会话只有消息历史。
- 右侧栏是 QA 工作台（项目环境、测试数据、报告、文件、浏览器），没有 DSH 那种通用 tab 系统；改动审阅更适合复用文件预览的 diff 模式，而不是新造 tab。
- 没有 Agent 预设；Pi SDK 也没有 preset 语义，只有模型、原生工具和 `customTools`。项目约定还不覆盖原生工具登记，预设若要改工具集就会与该约定冲突。
- `proposal-diff.js` 的 LCS 是 O(n×m) 内存，整文件对比大文件会爆；需要换 Myers 实现或加行数/字节上限与超时降级。

## 五、建议落地

### P0：开关 + 每轮改动（推荐先做，5–8 人日）

1. 通用设置新增「代码工作视图」开关（默认值由产品定：QA 用户建议默认关），持久化后用同一状态门控卡片和审阅入口。
2. 新增主进程 `workspace-changes-service`：轮次开始用 `GIT_INDEX_FILE` 临时 index 拍基线，轮末 `write-tree` + `diff-tree --numstat -M`；文件工具通过 Pi 官方 `tool_call` 钩子在执行前捕获 write/edit 目标（`permission-gate.mjs` 已在用同一钩子），无 git 时只列文件工具改动。
3. IPC 暴露 `summary(sessionId, requestSeq)` 与 `diff(sessionId, requestSeq, index)`，只回传投影字段；路径、大小、超时在主进程校验。
4. UI：最终回复后插入「本轮改动」卡片（N 个文件、+N −M、二进制/过大状态），点击在右侧栏以 diff 视图打开，复用现有 Markdown 转义与文件预览边界。大文件用替换行降级，不做 5000 行以上的逐行渲染。
5. 摘要放会话内存或 `session-state-store`；放内存与 DSH 行为一致，放存储则重启后仍可看，按需要选。

已知边界：bash 对仓库外文件、被忽略文件的改动不在覆盖内（DSH 同样如此）；子代理会话不记录；切换工作目录后历史摘要按原目录解释。

### P1：精简轨迹（可选，3–5 人日）

不做时间概览、分页和虚拟化，只把现有适配器的事件按请求汇总成一张表（轮次、工具名、目标、状态、耗时、token），入口放右侧栏或对话头部。若 P0 的改动卡片已能满足审计需求，这一步可以不做。

### P2：Agent 预设（不建议）

需要同时定义模型、提示词、技能、权限和工具集的组合，并处理切换时的会话重建与默认值回退；与「保持 Pi 原生工具登记」的既有约定冲突，5–10 人日换不来对 QA 主流程的明确收益。

### 更便宜的替代

若只想快速看到「本轮改了哪些文件」，也可以直接从 edit/write 的调用参数聚合，不拍快照：1–2 人日即可，但会把 bash 改动漏掉，也无法反映同一文件多次编辑后的最终状态。适合先验证使用频率，再决定是否升级到快照方案。

## 六、验证边界

以上为只读源码与 README 分析：未运行开关前后对比，未实现或验证本项目改造，工作量按现有代码结构估算，不含真机验收与回归测试。DSH 版本为 `0.2.1-rc.5`，更高版本的行为可能变化。

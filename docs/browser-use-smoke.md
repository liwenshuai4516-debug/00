# browser-use 接入小验证

验证日期：2026-11-06，Asia/Shanghai。范围对应 [实施方案](browser-use-playwright-plan.md)第 4 节和阶段 1。

**结论：独立验证入口已接入，阶段 1 未通过。** 首次离线检查在 browser-use 浏览器初始化阶段返回 `RuntimeError`，已停止该链路，未重试、未调用真实模型。不能据此认定 browser-use 与当前 Chromium 不兼容，也不能进入正式工具、旧入口替换或版本发布阶段。

## 入口和边界

- `tooling/testing/ui/browser-use-smoke.mjs`：受控本地页面、现有后台登录导出、探针编排和独立 Playwright 回放检查。
- `resources/testing/ui/browser-use/bridge.cjs`：Node → Python JSON Lines；核对 taskId、终值、退出码和浏览器收尾；取消 5 秒后仍未退出则终止进程组，结果不冒充正常取消。
- 同目录 `explore.py`：公开 `Browser`、`Agent`、`ChatOpenAI`、`Tools` 和回调接口；记录动作前目标、业务行祖先、动作结果与证据引用。仅允许本地页面的导航、点击、结束。
- 探针未注册到正式 Pi 工具、IPC 或界面。既有 UI 测试流程未替换，真实项目配置、账号、会话与 `.env` 未读取。
- 选择真实模型后，通过 Pi 1.4.0 的公开 `ModelRuntime.create()`、`getModel()`、`getAuth()` 取得最少参数，经 stdin 内存交接。不直接解析认证文件，不支持未验证的 OAuth、订阅和其他 API，不自动换模型。
- 自动登录使用临时账号和本地服务，导出的状态权限为 `0600`。完整结果与浏览器文件位于已忽略的 `qa/ui/browser-use-smoke/`，其中 `private/` 不应分发。

## 版本和准备方式

当前开发平台为 macOS arm64；此次安装使用 Python **3.13.13**、browser-use **0.13.14**。这是一组待完成兼容性验证的候选版本，不代表安装包运行时已经可发布。`requirements.lock` 固定本次 107 个 Python 包及分发哈希，未改变 npm 依赖。

来源为 PyPI `browser-use` 0.13.14 元数据及所安装版本的公开参数签名；Pi 依据安装包的公开导出及 `.d.ts`，未调用 `getCompatibilityRequestConfig()` 等内部兼容接口。

```sh
uv venv --python 3.13.13 resources/testing/ui/browser-use/.venv
uv pip sync --python resources/testing/ui/browser-use/.venv/bin/python resources/testing/ui/browser-use/requirements.lock --require-hashes
node --test tests/unit/browser-use-bridge.test.js
resources/testing/ui/browser-use/.venv/bin/python tests/helpers/browser-use-probe.check.py
```

探针预设复用现有 Playwright **1.64.1** 的 Chromium **156.0.8078.4**（revision **1248**），不自动安装另一份浏览器。现有 `resources/testing/ui/node_modules` 和该 Chromium 须预先准备好。

以下是故障排清后的验证入口；本轮停止后没有再次执行：

```sh
# 离线取消、注入错误、后台登录与独立回放检查
node tooling/testing/ui/browser-use-smoke.mjs

# 已获用户授权的模型；命令本身不包含凭据
node tooling/testing/ui/browser-use-smoke.mjs --model qwen3.8-flash-next/qwen3.8-flash-next
```

真实模式也先做离线前置检查；前置失败便不请求模型。本地场景要求：身份 `smoke-reviewer`，两个同名 Detail 按钮中只点击 Beta 行一次，并观察异步结果 `Beta · ready`；回放使用新的 Playwright 浏览器和相同导出状态。预期来自探针定义，不取自模型的成功陈述。

## 本次实际结果

| 检查 | 事实与结论 |
| --- | --- |
| Python / browser-use 安装与锁定 | 安装和按锁同步成功；107 个包一致；尚未证明浏览器初始化成功 |
| Node 进程协议单测 | 9 项通过：成功确认、非零退出、缺终值、收尾未知、taskId 错误、终值后多余消息、正常取消协议、超时、不响应取消的有界终止。使用模拟进程，不等于真实浏览器取消通过 |
| Python 模拟行为检查 | 6 项通过：空动作与多动作响应拒绝、重复调用阻止、用量保留、初始化错误终止、取消后收尾、收尾失败标记未知。使用模拟浏览器与模型，未重跑故障浏览器链路 |
| 现有后台登录 | 临时本地账号成功登录，现有 `login.cjs` 返回 saved；导出文件权限 `0600` |
| 真实 browser-use 初始化 | 失败：`RuntimeError`，0 次模型调用、0 个探索动作；进程退出码 1 |
| 同名按钮与异步观察、稳定目标轨迹 | 未执行，受初始化失败阻塞 |
| browser-use 中的真实身份、Playwright 独立回放 | 未执行；导出成功不等于两端交接通过 |
| 真实取消和注入模型错误停止 | 未执行：取消探针尚未达到 browser-ready，注入错误探针随后被阻断 |
| 指定真实模型 | 用户已授权 `qwen3.8-flash-next`；仅核对模型配置元数据：API 为 openai-completions，input 为 text。未取出真实认证或发出推理请求，不宣称结构化输出兼容 |
| 语法与差异检查 | Node / Python 语法检查通过；未用语法检查替代运行时检查 |

## 内部行为核对与后续门槛

核对对象为该锁定版本所安装源码的公开参数与实现；没有修改 `node_modules` 或 Python 安装包。

| 行为 | 默认值或实现事实 | 本探针处理 / 尚缺验证 |
| --- | --- | --- |
| OpenAI 兼容客户端重试 | `ChatOpenAI.max_retries=5` | 明确传 0；真实供应商尚未调用 |
| 决策与动作失败 | `max_failures=5`、`final_response_after_failure=True` | 设为 1 / False；`on_step_end` 发现错误即终止；真实负例尚未运行 |
| 多动作 | `max_actions_per_step=5` | 设为 1；适配器拒绝空动作及多动作响应，避免进入 SDK 空动作二次请求 |
| 额外模型处理 | `use_judge=True`、planning 和 message_compaction 默认开启 | 关闭这些额外处理；最多 8 决策步、每次调用 45 秒、探针工作预算 180 秒 |
| 启动失败内部重试 | `LocalBrowserWatchdog._launch_browser(max_retries=3)` 在部分 profile 错误时改临时目录重试；未找到公开关闭参数 | 正式接入前须解决；本轮是否触发此分支未记录，不能声称无重试 |
| 连接故障纠偏 | Agent 错误处理存在 reconnect 分支 | 尚未验证能否通过公开接口满足首次异常停止，不能承诺关闭全部内部恢复 |
| 截图 | `_prepare_context()` 即使 use_vision=False 也请求截图，历史流程写截图文件 | 本轮未走到 Agent；正式接入前解决逐步持久化，不能只关 GIF 和会话导出就宣称最小采集 |
| 视频 / 会话 / 云同步 | 各有独立配置 | 不启用视频、GIF、会话文本导出；禁用遥测与云同步；SDK 自己的截图仍须单独处理 |
| 登录态 | StorageStateWatchdog 实现 cookies、localStorage / sessionStorage 恢复 | 真实交接尚未通过；未见 IndexedDB 恢复逻辑，依赖 IndexedDB 的项目暂不能列为支持 |

不覆盖 Pi 原生重试设置，不用私有对象补丁关闭 browser-use 行为。只有真实初始化、身份交接、同名目标及异步结果、异常停止、实际取消全部验证后，才可推进阶段 2。

## 错误报告

### 浏览器初始化链路

- **任务与时间**：阶段 1 离线小验证；2026-11-06 15:29:17–15:29:29（Asia/Shanghai）。失败步骤为 Python `Browser.start()`；已停止后续探针、模型请求和回放。
- **调用链路**：用户目标 → `tooling/testing/ui/browser-use-smoke.mjs` → `functions.exec` / `exec_command`（启动），`write_stdin`（查询原进程）→ Node `fork(login.cjs)`（成功）→ `bridge.cjs` / Python `explore.py` → browser-use `Browser.start()`（失败）→ 当前 Chromium。未使用技能；没有加载任何 `SKILL.md`。原工具进程 session_id 为 `4154`；探针 taskId 为 `cancel-probe`。
- **预期与实际**：预期 browser-ready 后请求取消并确认退出；实际只收到 `done(status=failed, reason=RuntimeError, modelCalls=0, actions=0, cleanupConfirmed=true)`，退出码 1。首次包装仅保留异常类型，未记录原始异常正文及调用栈，不能编造具体根因。
- **证据**：本机 `qa/ui/browser-use-smoke/run-ukoMbM/summary.json` 和 `cancel-probe/process-result.json`；浏览器产物保留在其 private 目录。该摘要保留原始验证版本的回执，不以之后的代码修改覆盖原结果。
- **已确认原因 / 缺证据**：browser-use 初始化抛出 RuntimeError；启动、CDP 连接还是状态恢复中的具体原因待确认。尚无证据断言 Chromium 版本、权限、网络或 profile 路径导致故障。
- **已执行处置**：实际浏览器链路只启动 1 次，没有自动恢复验证。只读核对 SDK 初始化与关闭实现、既有产物和进程列表；结束后未发现匹配的探索或 Chrome for Testing 活动进程。SDK 本次内部尝试次数未记录。补充异常栈位置诊断，并加强中途初始化失败的子进程检查；这些修改完成静态及模拟行为检查，未再启动真实浏览器。
- **影响与恢复**：仅本地临时站点登录和临时文件写入；没有真实业务写入或真实模型费用。原始结果保留。最小恢复步骤是先取得初始化原始异常与 Chromium 退出原因，确认已修复前置条件，再对该初始化做一次有界恢复验证；仍失败则停止。完成后才继续取消、轨迹和授权模型检查，不能整批盲跑。

### 首次源码搜索

2026-11-06（Asia/Shanghai，秒级时间未记录），`exec_command` 中的 zsh 路径通配符 `src/main/services/ui-testing*` 未匹配，退出码 1，关键错误为 `no matches found`。未使用技能。已停止该条搜索，依据文件枚举取得真实路径后，使用 `src/main/capabilities/ui-testing` 做一次只读核对成功；没有业务写入、没有浏览器重试，影响仅为首次搜索不完整。

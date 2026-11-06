# browser-use 接入小验证

验证日期：2026-11-06，Asia/Shanghai。范围对应 [实施方案](browser-use-playwright-plan.md)第 4 节和阶段 1。

**当前结论：独立验证入口已接入，阶段 1 仍未通过。** 首次初始化的 `RuntimeError` 经续跑诊断确认与 macOS 系统 SOCKS 代理有关；增加本机地址绕过后，一次有界恢复验证改为 `BrowserStartEvent` 30 秒超时。已停止浏览器链路，没有真实模型请求，不进入阶段 2。具体调用与原始结果见文末错误报告。

## 入口和边界

- `tooling/testing/ui/browser-use-smoke.mjs`：受控本地页面、现有后台登录导出、探针编排和独立 Playwright 回放检查。
- `resources/testing/ui/browser-use/bridge.cjs`：Node → Python JSON Lines；核对 taskId、终值、退出码和浏览器收尾；取消 5 秒后仍未退出则终止进程组，结果不冒充正常取消。
- 同目录 `explore.py`：公开 `Browser`、`Agent`、`ChatOpenAI`、`Tools` 和回调接口；记录动作前目标、业务行祖先、动作结果与证据引用。仅允许本地页面的导航、点击、结束。
- Python 子进程将已解析的环境／系统代理保留在内存环境中，再为 `127.0.0.1`、`localhost`、`::1` 设置绕过，防止本机 CDP 被送到系统 SOCKS 代理。不修改 macOS 代理设置，也不写出代理地址。初始化失败保留脱敏错误、栈位置和子事件状态；不序列化事件参数或处理结果。
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

以下是故障排清后的完整验证入口；续跑仅做定向诊断和一次初始化恢复，没有再次执行完整入口：

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
| Python 模拟行为检查 | 当前 8 项通过：空动作与多动作响应拒绝、重复调用阻止、用量保留、初始化错误终止、取消后收尾、收尾失败标记未知，以及系统 SOCKS 代理下本机绕过／外网代理保留和诊断认证脱敏。初始化负例也验证事件诊断不含处理结果。未连接真实模型或网站 |
| 现有后台登录 | 临时本地账号成功登录，现有 `login.cjs` 返回 saved；导出文件权限 `0600` |
| 真实 browser-use 初始化 | 首次和定向诊断为 SOCKS 依赖错误；绕过修正后的一次恢复验证为 `BrowserStartEvent` 30 秒超时。各次均 0 次模型调用、0 个探索动作、退出码 1，清理回执 confirmed |
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

### 续跑：代理诊断与一次恢复验证

用户明确要求继续执行后，沿用原报告的恢复条件，只针对初始化，不重跑登录、错误探针、模型或回放。时间均为 2026-11-06，Asia/Shanghai；起止依据本机任务目录创建时间与结果文件写入时间。

| 项目 | 事实 |
| --- | --- |
| 任务与结论 | 15:50:36–15:50:42 定向诊断定位 SOCKS 代理错误；15:53:03–15:53:40 一次恢复验证仍失败，已停止此链路及阶段 2 |
| 调用链路 | 用户继续 → `functions.exec` / `exec_command` 的临时 Node 驱动 → 已有 `bridge.cjs` → `explore.py` → `Browser.start()` → 当前 Chromium / 本机 CDP；原进程使用 `write_stdin` 有限查询。未使用技能，未加载 `SKILL.md` |
| 工具与参数 | 驱动直接读取助手先前生成的临时登录态，复用原 Chromium；mode=cancel-probe，URL 为该临时状态的本机 origin。没有重新访问真实项目配置或认证。诊断工具 session_id=38054、taskId=initialization-diagnosis；恢复工具 session_id=21841、taskId=initialization-recovery |
| 诊断原文 | `Failed to establish CDP connection to browser: python-socks is required to use a SOCKS proxy`；栈定位到 `BrowserSession.connect()`；退出码 1，modelCalls=0，actions=0，cleanupConfirmed=true |
| 原因核对 | 环境中没有 proxy 变量，但标准库从 macOS 读到 http / https / socks 配置；websockets 对本机 URI 选到了 socks5h。没有输出代理地址或凭据。缺少 python-socks 是已确认的直接失败条件，不能据此认定 Chromium 不兼容 |
| 修复与验证依据 | 子进程内保留已解析代理，添加本机 bypass；模拟代理和真实标准库／websockets 路由解析证明本机直连、远端仍用原代理。已改变的是本机 CDP 代理选择；不通过加装 SOCKS 依赖把本机流量继续发往代理 |
| 一次恢复的实际结果 | `Event handler ... BrowserSession.on_BrowserStartEvent ... timed out after 30.0s and interrupted any processing of 4 child events`；退出码 1，modelCalls=0，actions=0，cleanupConfirmed=true。该次未再出现原 SOCKS 依赖错误，但仍未达到 browser-ready，不能宣称初始化修复成功 |
| 证据 | `qa/ui/browser-use-smoke/diagnose-ZkeT8W/process-result.json`、`qa/ui/browser-use-smoke/recovery-t11zC7/process-result.json`；原始产物继续保留在已忽略目录，不覆盖首次结果 |
| 已执行处置与次数 | 本次 1 次定向诊断、修复明确代理条件后 1 次恢复验证，累计实际初始化调用 3 次（含首次）。SDK 内部尝试次数未记录。恢复仍失败后停止，没有加长超时、另换浏览器、重建同等会话或重跑整批。只读检查结束后未见匹配的探索 / Chrome for Testing 活动进程 |
| 超时根因与缺证据 | 只能确认启动事件处理器超时及 4 个子事件被中断，具体卡住的子事件和处理器待确认。现有结果没有该次事件明细，不断言网络、Chromium 或登录态是根因。新增的事件状态采集尚未对真实超时运行，只在模拟负例中核对格式和内容边界 |
| 影响与恢复 | 没有真实模型费用或真实业务写入；认证交接、同名按钮、异步结果、实际取消和回放仍未完成。后续应先取得启动子事件及处理器状态，定位并修复明确前置条件，再做有界验证；不能仅调整超时后重跑整套小验证 |

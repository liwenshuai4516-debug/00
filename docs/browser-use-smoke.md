# browser-use 接入小验证

验证日期：2026-11-06，Asia/Shanghai。范围对应 [实施方案](browser-use-playwright-plan.md)第 4 节和阶段 1。

**当前结论：阶段 1 的受控功能小验证已通过，正式接入仍有内部恢复与采集边界待解决。** 用户确认所选内网 Qwen 应直连后，仅为该模型主机添加子进程代理例外；一次定向恢复验证成功，以 3 次模型调用完成导航、Beta 行点击和异步结果确认，保留稳定目标及截图，浏览器已关闭。此前实际取消、注入错误停止和独立 Playwright 回放也已通过。未替换正式入口、未进入阶段 2；SDK 启动重试、重连和默认逐步截图等限制见下文。旧错误和失败请求的费用未知状态继续保留，不因本次成功改写。

## 入口和边界

- `tooling/testing/ui/browser-use-smoke.mjs`：受控本地页面、现有后台登录导出、探针编排和独立 Playwright 回放检查。
- `resources/testing/ui/browser-use/bridge.cjs`：Node → Python JSON Lines；核对 taskId、终值、退出码和浏览器收尾；取消 5 秒后仍未退出则终止进程组，结果不冒充正常取消。
- 同目录 `explore.py`：公开 `Browser`、`Agent`、`ChatOpenAI`、`Tools` 和回调接口；记录动作前目标、业务行祖先、动作结果与证据引用。仅允许本地页面的导航、点击、结束。
- Python 子进程将已解析的环境／系统代理保留在内存环境中，再为 `127.0.0.1`、`localhost`、`::1` 设置绕过，防止本机 CDP 被送到系统 SOCKS 代理。不修改 macOS 代理设置，也不写出代理地址。初始化失败保留脱敏错误、栈位置和子事件状态；不序列化事件参数或处理结果。
- 用户另行确认 `qwen3.8-flash-next/qwen3.8-flash-next` 对应的内网模型应直连；CLI 仅为这个引用传入 `directModelHost`，Python 为其实际认证解析后的 endpoint 主机追加 NO_PROXY 例外。其他模型及外网继续使用已有代理，没有按所有内网地址推断直连。
- 模型调用失败保留脱敏异常链、可用状态码与 SDK 步骤错误，禁止重交；`modelCalls` 是适配器的调用尝试数（包含注入负例），不等于服务器已接收请求数，计费用量缺失时仍为未知。
- 探针未注册到正式 Pi 工具、IPC 或界面。既有 UI 测试流程未替换，真实项目配置、账号、会话与 `.env` 未读取。
- 选择真实模型后，通过 Pi 1.4.0 的公开 `ModelRuntime.create()`、`getModel()`、`getAuth()` 取得最少参数，经 stdin 内存交接。不直接解析认证文件，不支持未验证的 OAuth、订阅和其他 API，不自动换模型。
- 自动登录使用临时账号和本地服务，导出的状态权限为 `0600`。探针结果、选定截图与浏览器 profile 位于已忽略的 `qa/ui/browser-use-smoke/`，其中 `private/` 不应分发。SDK 还自行向临时目录的 `browser_use_agent_*` 写逐步截图；bridge 已将子进程 TMPDIR 指向本任务 private，实际两张 SDK 截图也都在该目录内。file_system_path 不覆盖它的截图目录；路径隔离已确认，但关闭逐步采集及重复持久化仍未解决。

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

完整入口和定向入口如下。`--check` 用于执行一个明确阶段，摘要 `scope` 区分阶段；某个阶段 passed 不代表正式接入全部条件通过。模型异常的定向恢复须先满足文末条件，不能直接重复请求：

```sh
# 离线取消、注入错误、后台登录与独立回放检查
node tooling/testing/ui/browser-use-smoke.mjs

# 已获用户授权的模型；命令本身不包含凭据
node tooling/testing/ui/browser-use-smoke.mjs --model qwen3.8-flash-next/qwen3.8-flash-next

# 独立的本地回放检查，不请求模型
node tooling/testing/ui/browser-use-smoke.mjs --check replay

# 定向初始化取消 / 注入错误检查，不请求模型
node tooling/testing/ui/browser-use-smoke.mjs --check init
node tooling/testing/ui/browser-use-smoke.mjs --check error

# 模型故障定位并允许恢复后，仅验证探索
node tooling/testing/ui/browser-use-smoke.mjs --check explore --model qwen3.8-flash-next/qwen3.8-flash-next
```

真实模式也先做离线前置检查；前置失败便不请求模型。本地场景要求：身份 `smoke-reviewer`，两个同名 Detail 按钮中只点击 Beta 行一次，并观察异步结果 `Beta · ready`；回放使用新的 Playwright 浏览器和相同导出状态。预期来自探针定义，不取自模型的成功陈述。

## 本次实际结果

| 检查 | 事实与结论 |
| --- | --- |
| Python / browser-use 安装与锁定 | 安装和按锁同步成功；107 个包一致；最近定向初始化成功 |
| Node 进程协议单测 | 9 项通过：成功确认、非零退出、缺终值、收尾未知、taskId 错误、终值后多余消息、正常取消协议、超时、不响应取消的有界终止。使用模拟进程，不等于真实浏览器取消通过 |
| Python 模拟行为检查 | 当前 10 项通过，包含模型异常链脱敏且不重交，以及选定模型直连但保留其他代理／既有例外。均使用模拟调用，不替代真实供应商验证 |
| CLI 范围检查 | 非法 scope、explore 缺模型、参数缺值均在创建任务／浏览器前拒绝；独立 replay 的正常入口实际通过 |
| 现有后台登录 | 临时本地账号成功登录，现有 `login.cjs` 返回 saved；导出文件权限 `0600` |
| 真实 browser-use 初始化 | 旧错误见历史报告；最近定向诊断成功到达 browser-ready 并正常取消，后续完整检查的三个 Python 探针也均到达 browser-ready。旧超时暂未复现，不能宣称已确认其根因 |
| AI 同名按钮与异步观察、稳定目标轨迹 | 最新定向 explore 通过：3 个决策分别为 navigate、click、done；实际仅点击 Beta 一次。动作前临时 index=6 对应 role=button、name=Detail，其祖先 TR 的 data-row=Beta；保存动作结果及 before-2 / before-3 截图。done 前 DOM 确认异步结果可见，不仅相信模型自报 |
| browser-use 中的真实身份、Playwright 独立回放 | 最新 explore 的点击和结束前均从 DOM 观察到 smoke-reviewer；独立 replay 已用新 Playwright 浏览器确认相同身份、只点 Beta 并等待 Beta · ready。两个检查分别执行，不把手写回放路径冒充 AI 探索生成用例，也没有生成或发布正式 case |
| 真实取消和注入模型错误停止 | 已通过：初始化后 cancel 返回 cancelled、零退出和浏览器收尾确认；注入错误只尝试一次、零动作、退出 1 且收尾确认。注入负例没有调用真实模型 |
| 指定真实模型 | 官方 ModelRuntime 认证仅在内存交接。API=openai-completions、input=text、reasoning=false。已验证 ChatOpenAI 默认 strict JSON schema、use_vision=False 能完成该受控目标，3 次成功调用返回 total_tokens 合计 17886；未返回金额，不推算费用。此前失败调用是否到达供应商和费用仍未知；不能扩大为全部任务或其他模型兼容 |
| 语法与差异检查 | Node / Python 语法检查通过；未用语法检查替代运行时检查 |

## 内部行为核对与后续门槛

核对对象为该锁定版本所安装源码的公开参数与实现；没有修改 `node_modules` 或 Python 安装包。

| 行为 | 默认值或实现事实 | 本探针处理 / 尚缺验证 |
| --- | --- | --- |
| OpenAI 兼容客户端重试 | `ChatOpenAI.max_retries=5` | 明确传 0；失败探针均在首个调用尝试后停止。最新成功检查是 3 个不同决策步骤，不是同一失败请求的重试 |
| 决策与动作失败 | `max_failures=5`、`final_response_after_failure=True` | 设为 1 / False；`on_step_end` 发现错误即终止；真实浏览器＋注入模型错误负例通过，所选模型错误也在零动作时终止 |
| 多动作 | `max_actions_per_step=5` | 设为 1；适配器拒绝空动作及多动作响应，避免进入 SDK 空动作二次请求 |
| 额外模型处理 | `use_judge=True`、planning 和 message_compaction 默认开启 | 关闭这些额外处理；最多 8 决策步、每次调用 45 秒、探针工作预算 180 秒 |
| 启动失败内部重试 | `LocalBrowserWatchdog._launch_browser(max_retries=3)` 在部分 profile 错误时改临时目录重试；未找到公开关闭参数 | 正式接入前须解决；本轮是否触发此分支未记录，不能声称无重试 |
| 连接故障纠偏 | BrowserSession 私有断线回调直接创建最多 3 次的自动重连任务；Agent 错误处理还会等待它 | Browser 构造参数和 BrowserProfile 无公开关闭开关。BrowserReconnectingEvent 派发后未等待处理器便执行 reconnect，不能靠异步监听保证零重连；不改私有回调 |
| 截图 | `_prepare_context()` 即使 use_vision=False 也请求截图，历史流程写截图文件 | bridge 的 TMPDIR 已使实际 SDK 截图落在任务 private 中，file_system_path 只控制 Agent 文件区。没有公开开关停止默认逐步截图；不能把路径隔离等同于最小采集 |
| 视频 / 会话 / 云同步 | 各有独立配置 | 不启用视频、GIF、会话文本导出；禁用遥测与云同步；SDK 自己的截图仍须单独处理 |
| 登录态 | StorageStateWatchdog 实现 cookies、localStorage / sessionStorage 恢复 | 本次 cookies + localStorage 的身份交接已通过；未见 IndexedDB 恢复逻辑，sessionStorage 未单独实际验证，不扩大到其他项目认证 |

不覆盖 Pi 原生重试设置，不用私有对象补丁关闭 browser-use 行为。受控场景中的真实初始化、身份交接、同名目标及异步结果、异常停止和实际取消均已有通过记录；正式接入前仍须解决上表的内部启动恢复、重连和最小采集约束，本轮不推进阶段 2。

后续只读核对确认 0.13.14 仍是 PyPI 最新版，不能承诺通过普通升级获得这些开关。当前版本的公开接口缺口、源码依据和可评审的最小依赖变更要求见 [运行时缺口](browser-use-runtime-gaps.md)。没有为弥补缺口修改安装包、注入私有回调或再发起模型请求。

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

### 再次续跑：初始化恢复，首次模型适配失败

| 项目 | 事实 |
| --- | --- |
| 任务与时间 | 用户再次要求继续；2026-11-06 16:01:20–16:01:28（Asia/Shanghai）定向初始化诊断成功；16:02:39–16:03:06 完整小验证在首次模型调用尝试失败，已停止模型链路 |
| 调用链路 | 用户继续 → `functions.exec` / `exec_command` 临时 Node 驱动 → `bridge.cjs` → Python / browser-use 初始化（成功、取消完成）；随后 `tooling/testing/ui/browser-use-smoke.mjs --model qwen3.8-flash-next/qwen3.8-flash-next` → 本地后台登录（成功）→ 取消与错误负例（成功）→ Pi ModelRuntime / Python ChatOpenAI / 所选模型调用尝试（失败）。使用 `write_stdin` 查询原进程，无技能或 SKILL.md |
| 工具与编号 | 定向诊断 session_id=69254、taskId=startup-event-diagnosis；完整检查 session_id=86460，失败探针 taskId=explore。完整入口在初始化已有成功新证据后执行，不是以相同失败条件重启 |
| 初始化新证据 | browser-ready 后取消返回 `done(status=cancelled, cleanupConfirmed=true)`、退出 0。未调整 30 秒超时，旧超时没有复现；原因仍未确认，不能把暂时恢复写成已根治 |
| 失败预期与实际 | 预期 Qwen 完成 DOM 观察与导航决策；实际首轮适配器尝试后 `step_end` 报 `step-failed-chain-stopped`，外层 RuntimeError、stage=agent-run、退出 1、modelCalls=1、actions=0、usage=[]、cleanupConfirmed=true。没有保存任何成功动作或成功轨迹 |
| 原因与缺证据 | 已确认失败发生在首轮模型适配调用尝试；该次探针未保留供应商异常及步骤错误，只留下外层停止栈。HTTP 状态、服务端是否接收、用量与费用待确认，不能据此断言权限、额度、网络或结构化输出不支持 |
| 已执行处置 | 首次模型异常后暂停，没有自动换模型、切换输出模式或重发。只读核对所选模型元数据与公开 ChatOpenAI 参数，未找到足以判定原因的配置证据。补齐脱敏模型异常链、状态码和步骤错误的采集，并用模拟异常验证不重交；原始回执保持不变 |
| 独立检查 | 16:07:52–16:07:54 以新增 `--check replay` 单独验证本地登录态与手写 Playwright 路径，通过；session_id=3881。此入口不加载模型，不启动 Python，不依赖失败的 AI 探索结果，不作为 AI 用例发布证据 |
| 证据 | `qa/ui/browser-use-smoke/events-C46CtP/process-result.json`、`run-QAGcmD/summary.json`、`run-QAGcmD/explore/process-result.json`、`run-iPDuPO/summary.json`；所有完整本机产物仍被忽略，不提交认证或浏览器 profile |
| 影响与恢复 | 没有真实业务写入；所选模型调用是否产生费用未知。阶段 1 仍未通过，阶段 2 未执行。该次恢复条件是取得具体模型错误及请求结果；后续定向诊断见下节。不要重跑已通过的取消、错误负例和回放，不以重新请求掩盖未知结果 |

### 最新续跑：模型代理连接失败已定位

| 项目 | 事实 |
| --- | --- |
| 任务与结论 | 用户要求继续后，使用已补齐错误采集的探针，仅运行指定 Qwen 的 explore 诊断；2026-11-06 16:18:26–16:18:39（Asia/Shanghai）。本地登录和浏览器初始化成功，首轮模型请求在代理连接阶段失败；已停止模型链路和阶段 2 |
| 调用链路 | 用户继续 → `functions.exec` / `exec_command` → `node tooling/testing/ui/browser-use-smoke.mjs --check explore --model qwen3.8-flash-next/qwen3.8-flash-next` → 本地后台登录（成功）→ Pi ModelRuntime 认证内存交接（成功）→ `bridge.cjs` / `explore.py` / browser-use（初始化成功）→ ChatOpenAI / OpenAI Python / HTTPX 代理连接（失败）→ 供应商是否收到请求待确认。使用 `write_stdin` 查询原进程；未使用技能，未加载 SKILL.md |
| 工具与编号 | `exec_command` 返回 session_id=21556，沿用该编号查询 1 次，进程退出码 1；探针 taskId=explore。没有另起相同任务 |
| 预期与实际 | 预期完成本地页面观察、Beta 行点击和异步结果确认；实际 browser-ready 后在 step 1 结束，modelCalls=1、actions=0、usage=[]、cleanupConfirmed=true。只有调用尝试计数，不能认定服务端接收或计费 |
| 原始错误 | `ModelProviderError(statusCode=502, Connection error.) → APIConnectionError(Connection error.) → ProxyError(504 Gateway Timeout) → ProxyError(504 Gateway Timeout)`；SDK 步骤错误为 `Connection error.` |
| 已确认原因与证据 | 本次直接失败条件为代理连接返回 504。只读核对安装包 `browser_use/llm/openai/chat.py` 的 APIConnectionError 分支和 `llm/exceptions.py`：该分支未传入状态码，ModelProviderError 默认填 502，因此 502 不是已确认的供应商 HTTP 响应。本机标准库解析存在 http / https / socks 代理项，均为 http URL，无既有 bypass；探针只为本机地址添加 bypass，外网仍走已有代理。未输出代理地址或认证值 |
| 尚缺证据 | 代理为什么超时、到模型服务的上游是否可达、供应商是否收到请求与计费用量均待确认；没有证据认定认证、额度、JSON schema 或模型能力有问题。此次错误也不能追溯证明首次失败原因相同 |
| 已执行处置 | 本轮仅 1 次定向诊断，0 次自动恢复验证；随后只读核对脱敏结果、代理类型和已安装客户端错误转换逻辑。未切模型、改输出模式、绕过代理或重复请求。没有代理恢复或明确配置修正的新证据，按仓库异常规则停止 |
| 产物与影响 | `qa/ui/browser-use-smoke/run-p4SCxN/summary.json` 及 `explore/process-result.json` 保留原始回执并继续忽略。仅写入本地临时登录态与浏览器文件；无真实业务写入，浏览器已关闭。AI 轨迹、Python 登录身份观察和模型兼容结论仍未完成；既有独立回放结果保持原边界 |
| 最小恢复条件 | 先恢复已有代理到所选模型地址的连接，并提供配置已修正或代理已恢复的可核实证据；不需要提供密钥。满足该条件后，仅运行一次同一 `--check explore --model ...`，检查业务结果、稳定目标轨迹及收尾；若仍失败立即停止。当前不自动重发，也不换网络路径规避此次错误 |

### 用户确认直连后：一次恢复验证通过

| 项目 | 事实 |
| --- | --- |
| 新证据与授权 | 用户再次要求继续。官方 ModelRuntime 模型元数据及 DNS 只读核对表明 endpoint 解析为内网地址；独立 Python 子进程核对，探针配置前后 proxy_bypass 都为 false，不能认定探针丢失系统绕过规则。用户明确答复“该内网模型应直连，可在探针子进程内修正”，据此修正预期连接方式；没有擅自更改系统代理 |
| 修正范围 | CLI 只对已授权的 Qwen provider/model 传入实际 endpoint 主机；Python 在原本机例外及既有 NO_PROXY 之外添加该主机。未修改认证、供应商地址、输出格式或其他模型路由；离线检查证明该模型及既有例外绕过代理、其他地址仍保留 HTTPS 代理 |
| 调用链路 | 用户确认 → `functions.exec` / `exec_command` → Python 行为检查（10 项通过）、Node 语法与 Git 差异检查（通过）→ `browser-use-smoke.mjs --check explore --model qwen3.8-flash-next/qwen3.8-flash-next` → 现有本地登录 → bridge / Python / browser-use → 内网 Qwen 直连 → 3 个正常决策 → 浏览器关闭（全部成功）。未使用技能，未加载 SKILL.md |
| 时间与编号 | 2026-11-06 16:30:40–16:31:02（Asia/Shanghai）；session_id=61244，沿用原编号查询 1 次，退出 0，taskId=explore。此次为明确修正路由前置条件后的 1 次有界恢复验证，没有第二次自动重跑 |
| 预期与实际 | summary.status=passed、scope=explore；loginExport / explore / stableTarget 通过，modelCalls=3、actions=3、cleanupConfirmed=true。服务器检查只有一次 Beta 请求；DOM 证据确认身份及异步结果，动作前记录保留 Beta 业务行和同名 Detail 按钮 |
| 证据与计量 | `qa/ui/browser-use-smoke/run-DSDI57/summary.json`、`explore/actions.jsonl`、`explore/evidence/before-2.png`、`before-3.png`；成功调用用量分别为 5627、6183、6076 total_tokens，合计 17886。历史失败请求是否计费仍未知，未覆盖旧结果 |
| 影响与剩余工作 | 本地受控场景成功，无真实项目业务写入；模型实际产生成功请求，金额未返回。此次未重跑已通过的取消、错误负例及手写回放，未生成正式候选、未发布 case、未改变旧 UI 流程。正式接入仍须处理已记录的 SDK 内部恢复和截图限制 |

### 本轮只读诊断中的限制

2026-11-06（Asia/Shanghai，具体时分未记录），用户继续 → `functions.exec` / `exec_command` → Python `psutil.net_connections(kind="tcp")` 预期取得全机监听列表，实际因 `proc_pidinfo` 权限被 macOS 拒绝，退出 1，关键错误为 `psutil.AccessDenied(pid=82265)`。未使用技能；只调用 1 次，无任务编号。已停止该检查，没有提权、重放或换接口尝试获取同等受限列表；没有写入。它没有取得代理监听者或连接恢复证据，不能据此认定代理进程故障。后续仅独立读取系统代理类型、进程名称、已知日志目录及模型地址分类；不依赖该受限结果，最终依据用户确认的预期路由实施修正。

同轮 `rg --files` 搜索 `Library/Logs` 与 `Library/Application Support` 的代理日志返回部分路径，退出 2；命令使用 `--no-messages`，具体遍历错误未记录，不能推断全部目录均已搜索或具体权限原因。已停止该广域搜索，没有重跑；随后仅检查返回的已知目录，旧 Clash 日志不含该模型主机，也不能用于判断本次代理是否恢复。无业务写入，影响仅为日志搜索不完整；若未来必须取得被遗漏的日志，应先确认准确位置及访问条件。本次验证成功不依赖这些缺失日志。

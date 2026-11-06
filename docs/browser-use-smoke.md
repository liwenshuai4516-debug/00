# browser-use 接入小验证

验证日期：2026-11-06，Asia/Shanghai。范围对应 [实施方案](browser-use-playwright-plan.md)第 4 节和阶段 1。

**当前结论：阶段 1 小验证及三个运行时控制已在补丁版通过。** 用户批准维护最小依赖补丁后，已构建并锁定 browser-use **0.13.14+swqa.1**：严格模式启动只尝试 1 次、关闭自动重连和默认逐步截图。实际断线、取消、模型错误停止和 Qwen 核心场景均有通过记录；最新探索仅保存两个关键节点的手动证据。一次探索因暴露了范围外动作而停止，收窄公开工具列表后的一次恢复验证通过。未替换正式入口、未进入阶段 2；历史失败与计费未知状态继续保留。

## 入口和边界

- `tooling/testing/ui/browser-use-smoke.mjs`：受控本地页面、现有后台登录导出、探针编排和独立 Playwright 回放检查。
- `resources/testing/ui/browser-use/bridge.cjs`：Node → Python JSON Lines；核对 taskId、终值、退出码和浏览器收尾；取消 5 秒后仍未退出则终止进程组，结果不冒充正常取消。
- 同目录 `explore.py`：公开 `Browser`、`Agent`、`ChatOpenAI`、`Tools` 和回调接口；记录动作前目标、业务行祖先、动作结果与证据引用。仅允许本地页面的导航、点击、结束。
- 补丁版以公开 BrowserProfile.launch_max_attempts=1、auto_reconnect=False 和 Agent.capture_screenshots=False 启用严格行为。BrowserErrorEvent 触发进行中工作的取消与收尾；Tools 的公开排除参数使模型动作 schema 也只包含 navigate / click / done。运行时代码不深层导入私有方法；依赖组件测试会核对其内部实现。
- Python 子进程将已解析的环境／系统代理保留在内存环境中，再为 `127.0.0.1`、`localhost`、`::1` 设置绕过，防止本机 CDP 被送到系统 SOCKS 代理。不修改 macOS 代理设置，也不写出代理地址。初始化失败保留脱敏错误、栈位置和子事件状态；不序列化事件参数或处理结果。
- 用户另行确认 `qwen3.8-flash-next/qwen3.8-flash-next` 对应的内网模型应直连；CLI 仅为这个引用传入 `directModelHost`，Python 为其实际认证解析后的 endpoint 主机追加 NO_PROXY 例外。其他模型及外网继续使用已有代理，没有按所有内网地址推断直连。
- 模型调用失败保留脱敏异常链、可用状态码与 SDK 步骤错误，禁止重交；`modelCalls` 是适配器的调用尝试数（包含注入负例），不等于服务器已接收请求数，计费用量缺失时仍为未知。
- 探针未注册到正式 Pi 工具、IPC 或界面。既有 UI 测试流程未替换，真实项目配置、账号、会话与 `.env` 未读取。
- 选择真实模型后，通过 Pi 1.4.0 的公开 `ModelRuntime.create()`、`getModel()`、`getAuth()` 取得最少参数，经 stdin 内存交接。不直接解析认证文件，不支持未验证的 OAuth、订阅和其他 API，不自动换模型。
- 自动登录使用临时账号和本地服务，导出的状态权限为 `0600`。探针结果、选定截图与浏览器 profile 位于已忽略的 `qa/ui/browser-use-smoke/`，其中 `private/` 不应分发。bridge 将子进程 TMPDIR 指向本任务 private；补丁版关闭默认逐步截图，SDK 截图目录实际为空，仅通过公开 take_screenshot() 在点击和结束前采集两张证据。

## 版本和准备方式

当前开发平台为 macOS arm64；此次安装使用 Python **3.13.13**、browser-use **0.13.14+swqa.1**（基于官方 0.13.14 的下游补丁版）。受控范围已验证，不代表安装包运行时已经可发布。requirements.lock 固定 107 个 Python 包及分发哈希；只替换 browser-use 为预先构建的本地 wheel，其余 106 个包不变，未改变 npm 依赖。

源码来自 PyPI browser-use 0.13.14 sdist，源码与补丁及构建结果哈希见 upstream.json；构建依赖另行锁定，wheel 两次独立构建哈希一致。安装方式和维护责任见 [补丁运行时](browser-use-runtime-gaps.md)。Pi 依据安装包的公开导出及 .d.ts，未调用 getCompatibilityRequestConfig() 等内部兼容接口。

```sh
uv venv --python 3.13.13 resources/testing/ui/browser-use/.venv
resources/testing/ui/browser-use/.venv/bin/python resources/testing/ui/browser-use/build-runtime.py
uv pip sync --python resources/testing/ui/browser-use/.venv/bin/python resources/testing/ui/browser-use/requirements.lock --require-hashes
node --test tests/unit/browser-use-bridge.test.js
resources/testing/ui/browser-use/.venv/bin/python tests/helpers/browser-use-runtime.check.py
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
node tooling/testing/ui/browser-use-smoke.mjs --check disconnect

# 模型故障定位并允许恢复后，仅验证探索
node tooling/testing/ui/browser-use-smoke.mjs --check explore --model qwen3.8-flash-next/qwen3.8-flash-next
```

真实模式也先做离线前置检查；前置失败便不请求模型。本地场景要求：身份 `smoke-reviewer`，两个同名 Detail 按钮中只点击 Beta 行一次，并观察异步结果 `Beta · ready`；回放使用新的 Playwright 浏览器和相同导出状态。预期来自探针定义，不取自模型的成功陈述。

## 本次实际结果

| 检查 | 事实与结论 |
| --- | --- |
| Python / browser-use 安装与锁定 | 安装和按锁同步成功；107 个包一致；最近定向初始化成功 |
| Node 进程协议单测 | 9 项通过：成功确认、非零退出、缺终值、收尾未知、taskId 错误、终值后多余消息、正常取消协议、超时、不响应取消的有界终止。使用模拟进程，不等于真实浏览器取消通过 |
| Python 模拟行为检查 | 探针共 11 项通过（10 项整组通过，新增动作 schema 检查单独通过）。依赖组件共 8 项通过（首次 7 项正常，截图历史检查因测试数据漏传 history 报错，补齐后该项定向通过）。包含严格启动次数、断线不创建任务、默认行为保留、状态截图请求与持久化关闭；不把组件模拟等同于真实故障 profile 验收 |
| CLI 范围检查 | 非法 scope、explore 缺模型、参数缺值均在创建任务／浏览器前拒绝；独立 replay 的正常入口实际通过 |
| 现有后台登录 | 临时本地账号成功登录，现有 `login.cjs` 返回 saved；导出文件权限 `0600` |
| 真实 browser-use 初始化 | 旧错误见历史报告；最近定向诊断成功到达 browser-ready 并正常取消，后续完整检查的三个 Python 探针也均到达 browser-ready。旧超时暂未复现，不能宣称已确认其根因 |
| AI 同名按钮与异步观察、稳定目标轨迹 | 最新定向 explore 通过：3 个决策分别为 navigate、click、done；实际仅点击 Beta 一次。动作前临时 index=6 对应 role=button、name=Detail，其祖先 TR 的 data-row=Beta；保存动作结果及 before-2 / before-3 截图。done 前 DOM 确认异步结果可见，不仅相信模型自报 |
| browser-use 中的真实身份、Playwright 独立回放 | 最新 explore 的点击和结束前均从 DOM 观察到 smoke-reviewer；独立 replay 已用新 Playwright 浏览器确认相同身份、只点 Beta 并等待 Beta · ready。两个检查分别执行，不把手写回放路径冒充 AI 探索生成用例，也没有生成或发布正式 case |
| 真实取消和注入模型错误停止 | 已通过：初始化后 cancel 返回 cancelled、零退出和浏览器收尾确认；注入错误只尝试一次、零动作、退出 1 且收尾确认。注入负例没有调用真实模型 |
| 指定真实模型 | 官方 ModelRuntime 认证仅在内存交接。API=openai-completions、input=text、reasoning=false。补丁版、strict JSON schema、text-only 和三种动作的最新探索成功，3 次调用返回 total_tokens 合计 18297。其前一次范围拦截运行消耗 11594 total_tokens；金额未返回。此前连接失败请求是否计费仍未知；不能扩大为其他模型或全部场景兼容 |
| 语法与差异检查 | Node / Python 语法检查通过；未用语法检查替代运行时检查 |

## 内部行为核对与后续门槛

核对对象为上游固定源码及经用户批准构建的补丁版；依赖通过包管理器正常安装，未手改 node_modules 或 site-packages。

| 行为 | 默认值或实现事实 | 本探针处理 / 尚缺验证 |
| --- | --- | --- |
| OpenAI 兼容客户端重试 | `ChatOpenAI.max_retries=5` | 明确传 0；失败探针均在首个调用尝试后停止。最新成功检查是 3 个不同决策步骤，不是同一失败请求的重试 |
| 决策与动作失败 | `max_failures=5`、`final_response_after_failure=True` | 设为 1 / False；`on_step_end` 发现错误即终止；真实浏览器＋注入模型错误负例通过，所选模型错误也在零动作时终止 |
| 多动作 | `max_actions_per_step=5` | 设为 1；适配器拒绝空动作及多动作响应，避免进入 SDK 空动作二次请求 |
| 额外模型处理 | `use_judge=True`、planning 和 message_compaction 默认开启 | 关闭这些额外处理；最多 8 决策步、每次调用 45 秒、探针工作预算 180 秒 |
| 启动失败内部重试 | 上游默认最多 3 次 | 补丁公开 launch_max_attempts，探针设为 1。模拟 profile 错误时只尝试一次、不创建备用目录并保留原错误；默认恢复行为单独验证保留 |
| 连接故障纠偏 | 上游断线自动创建重连任务，Agent 还可能等待恢复 | 补丁公开 auto_reconnect，探针设为 False；关闭实际 CDP 后零重连、零模型调用／动作，收到 ConnectionClosed 即停止并确认浏览器收尾 |
| 截图 | 上游即使 use_vision=False 也默认逐步采集并持久化 | 补丁公开 capture_screenshots，探针设为 False 且 use_vision=False；仅在 click / done 前手动采集，最新 SDK 截图目录为空，关键证据存在 |
| 视频 / 会话 / 云同步 | 各有独立配置 | 不启用视频、GIF、会话文本导出；禁用遥测与云同步，默认逐步截图也已单独关闭 |
| 登录态 | StorageStateWatchdog 实现 cookies、localStorage / sessionStorage 恢复 | 本次 cookies + localStorage 的身份交接已通过；未见 IndexedDB 恢复逻辑，sessionStorage 未单独实际验证，不扩大到其他项目认证 |

不覆盖 Pi 原生重试设置，不用私有对象 monkey patch。受控场景中的真实初始化、身份交接、同名目标及异步结果、异常停止、取消和三个新增运行时控制均已有通过记录。后续可以按方案进入阶段 2；本轮只交付补丁运行时和独立探针，未更改正式入口。

官方 0.13.14 没有这些开关；新增能力及其维护责任属于本仓库批准的补丁版，详见 [补丁运行时](browser-use-runtime-gaps.md)，不把它写成上游官方承诺。

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

### 补丁版构建与本轮验证

用户明确允许维护最小依赖补丁后实施；时间为 2026-11-06，Asia/Shanghai。未使用技能，未加载任何 SKILL.md。实际工具为 functions.exec / exec_command 和 write_stdin；下载采用 Python urllib，构建／同步采用 uv 与 Git，未直接编辑已安装包。

| 检查 | 时间、编号与结果 |
| --- | --- |
| 固定来源与构建 | 校验上游 sdist 后，在隔离源码上应用 patch。上游、patch、wheel 哈希见 upstream.json；6 个构建依赖固定并带哈希。两次独立构建相同，规范化补丁的空白上下文后另一次从新源码构建也匹配同一 wheel 哈希；未以修改 wheel 绕过校验 |
| 正常安装 | uv pip sync --require-hashes 仅替换 browser-use 为 0.13.14+swqa.1，其他 106 个运行依赖不变。uv pip check 检查 107 个包兼容 |
| 组件与探针 | 依赖组件 8 项、探针 11 项已通过；分组和测试数据错误的修正方式见本节后文。未例行重跑无关测试 |
| 实际断线负例 | 17:05:58–17:06:04；session_id=2521，taskId=disconnect-probe，scope=disconnect，summary.status=passed。受控关闭实际 CDP；探针保留 failed / ConnectionClosed / 退出 1，CLI 依据该预期负例确认零重连、零调用、零动作和收尾成功，不把探针失败写成业务成功 |
| 实际取消 | 17:07:17–17:07:21；session_id=20410，taskId=cancel-probe，scope=init，passed。新补丁版正常启动后取消，零退出并确认收尾 |
| 模型错误负例 | 17:08:09–17:08:13；session_id=91409，taskId=error-probe，scope=error，passed。只注入一次错误、零动作、退出 1、确认收尾；未请求真实模型 |
| Qwen 首次补丁版探索 | 17:09:35–17:09:48；session_id=89794，taskId=explore，scope=explore，failed。具体错误与恢复依据见下文；停止后未立即重交 |
| 一次定向恢复 | 17:13:45–17:14:05；session_id=29290，taskId=explore，scope=explore，passed。3 次正常决策、3 条动作记录、reconnectAttempts=0、cleanupConfirmed=true；仅 Beta 一次请求，身份及异步结果可见。默认截图目录为空，before-2.png / before-3.png 均存在 |

对应原始目录依次为 qa/ui/browser-use-smoke/run-paNirF、run-Ng4ufe、run-E3me90、run-kHjkj0、run-tZd15C；各有 summary.json，失败／负例另有 process-result.json，探索保留 actions.jsonl。产物、私有登录态和 profile 均继续忽略，不提交 wheel、构建目录或认证。此次未重跑与新补丁无关的独立手写 Playwright 回放，也未把旧回放当成新生成候选的验证。

### 本轮异常与恢复依据

| 项目 | 事实与处置 |
| --- | --- |
| 补丁生成定位保护 | 2026-11-06（Asia/Shanghai，具体时分未记录），exec_command 的临时 Python 生成器在替换 agent/service.py 的截图判断时发现相同片段出现 2 次，AssertionError、退出 1。生成立即停止；部分修改仅在被忽略的临时源码，未写出完整 patch、未安装或启动浏览器。依据源码将定位限定为 Store screenshot and get path 历史持久化块后，仅做一次定向生成，成功产出 6 文件补丁；构建脚本随后从干净上游源码检查／应用该 patch 并通过哈希校验。无凭据或业务写入，原临时源码保留 |
| 组件测试数据错误 | exec_command / Python tests/helpers/browser-use-runtime.check.py 首次运行 8 项，截图历史检查的两组子例因 AgentHistoryList 缺少必填 history 字段报 ValidationError，退出 1；这是测试构造错误，不是预期负例。已核对公开模型契约并补传 history=[]，只重跑该检查 1 次（截图开启／关闭两组），通过；其余 7 项的原通过记录保留。无模型或浏览器写入，不据此判断依赖不兼容 |
| 补丁格式检查 | git diff --cached --check 报 patch 上下文的 space before tab；2026-11-06（Asia/Shanghai，具体时分未记录）。原因是 unified diff 必需的上下文空格位于上游 Tab 缩进之前，不是补丁引入的源码缩进。已停止提交，增加仅限 patches/*.patch 的 whitespace=-space-before-tab 属性，保留其他空白检查；再次检查通过。patch 的实际可应用性和 wheel 哈希另由干净构建验证，没有修改源码或跳过构建校验 |
| Qwen 探索失败链路 | 用户批准 → functions.exec / exec_command → CLI 本地登录（成功）→ 官方 Pi ModelRuntime 内存认证 → bridge / Python / 补丁版 browser-use → Qwen（2 次有用量返回）→ 第一轮导航成功 → 第二轮 before 回调拒绝范围外动作（失败）→ on_step_end 停链路 → 浏览器关闭。session_id=89794，taskId=explore；原错误 unsupported-probe-action，外层 RuntimeError，退出 1；modelCalls=2、actions=1、reconnectAttempts=0、cleanupConfirmed=true |
| 已确认原因与缺证据 | 运行时回调只接受 navigate / click / done，但 Agent 仍暴露完整默认工具 schema，允许模型选择随后会被拦截的动作。该范围不一致已确认；原记录没有保存被拒动作名和参数，不能编造具体动作、不能认定与关闭截图存在因果关系。没有执行第二个动作或业务点击，11594 total_tokens 有返回，金额未知 |
| 修正与一次恢复 | 使用 Tools 的公开 exclude_actions 参数排除其他全部默认动作，保留运行时回调守卫；新离线检查验证 schema 正好包含三种允许动作，后续错误也只记录安全的动作名。已改变的是模型可选择的动作集合，没有换模型、改预期或放宽操作范围。该明确修正后仅执行一次 --check explore；session_id=29290，原始结果 run-tZd15C/summary.json 为 passed，3 次调用共 18297 total_tokens。没有第二次自动恢复 |
| 影响与后续 | 原失败与成功结果分别保留；均只针对临时本地页面，没有真实业务写入。无须补发旧请求或清理未知写入。三个获批运行时开关已在声明的组件／实际场景范围通过；后续按方案接通正式任务和工具仍是独立工作，不宣称所有异常、所有模型或真实项目都已验收 |

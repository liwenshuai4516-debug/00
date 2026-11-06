# browser-use 正式接入前的运行时缺口

更新日期：2026-11-06，Asia/Shanghai。上游为 browser-use 0.13.14；用户已允许维护最小依赖补丁版，当前运行时为 **0.13.14+swqa.1**。补丁以仓库内 patch 保存，构建时应用到校验过的上游源码，再通过包管理器正常安装；未手改 site-packages，未注入运行时 monkey patch。正式工具和界面尚未接入。

## 本轮结论

三个公开开关已经实现并验证，默认值保留上游行为。探针显式使用严格设置，实际断线时零重连、零模型调用、零动作并确认收尾；Qwen 完成场景，SDK 默认逐步截图目录为空，仅保存两个关键节点的手动证据。完整结果与本轮异常处置见 [验证报告](browser-use-smoke.md)。

运行时代码通过公开 BrowserProfile、Agent 参数、事件订阅和 take_screenshot() 使用新增能力；仅依赖组件测试会直接核对其内部方法。以下“无开关”的源码依据描述未打补丁的上游版本，不再代表当前补丁版。

## 公开接口与实现依据

以下位置均相对已安装包的 browser_use/，行号针对锁定版本；仅用于解释实现事实，运行时代码不深层导入这些内部方法。

| 缺口 | 源码依据 | 为什么现有参数不够 |
| --- | --- | --- |
| 本地启动重试 | browser/watchdogs/local_browser_watchdog.py:93 的 _launch_browser 默认 max_retries=3；:180 起在部分 profile 错误后改临时目录重启；:56 的调用未提供次数 | Browser 构造参数及 BrowserProfile 没有启动次数开关。传入新 profile 不会关闭内部重试；改其私有方法不符合当前方案 |
| 自动重连 | browser/session.py:1997 安装私有断线回调；:2385 创建自动重连任务；:2291 默认最多 3 次；:2309 派发 BrowserReconnectingEvent 后直接在 :2318 await reconnect | 事件派发没有等待监听器完成，因此“听到事件就取消”存在竞态。max_failures=1 约束 Agent 决策失败，无法禁用浏览器连接层恢复；改私有回调或仅设等待时长不能证明零重连 |
| 默认逐步截图 | agent/service.py:1098 固定 include_screenshot=True；:1757 将截图持久化；:449–450 从 tempfile.gettempdir() 创建 agent_directory | use_vision=False 只控制模型视觉输入，generate_gif=False 与 save_conversation_path=None 也不关闭采集。没有公开的默认截图开关 |

使用公开 cdp_url 连接宿主自行启动的 Chromium，可以避开 SDK 本地启动分支，但仍不能关闭自动重连和 Agent 默认截图。它也会新增启动及收尾实现，不能当作三个缺口都已解决，因此本轮没有增加第二套浏览器启动器。

## 截图路径核实与报告更正

bridge.cjs:12 已设置子进程 TMPDIR 为任务的 private/，:13 设置任务独立的 BROWSER_USE_CONFIG_DIR。实际运行 run-DSDI57 中，SDK 的 step_2.png、step_3.png 位于：

```text
explore/private/browser_use_agent_06aed903-3b58-7c9f-8000-ca9f2d0aa781_1793953843/screenshots/
```

选定的动作前证据另存为 explore/evidence/before-2.png 与 before-3.png。此前“SDK 写系统临时目录”的描述遗漏了已有 TMPDIR 覆盖，现已更正。上述历史运行支持任务目录隔离，当时仍有重复采集；当前补丁版已关闭默认逐步截图。没有删除历史文件或把既有产物重新解释成新验证。

## 已实现的最小依赖变更

补丁为 resources/testing/ui/browser-use/patches/strict-runtime.patch，修改上游 6 个文件（包含版本元数据），不改变 npm 依赖和其余 106 个运行时包的版本／哈希。公开接口如下，它们属于本仓库补丁版，并非官方 0.13.14 已有能力。

| 公开接口 | 探针设置与行为 | 实际验证 |
| --- | --- | --- |
| BrowserProfile.launch_max_attempts（默认 3，最小 1） | 设为 1；首次失败保留原错误，不改目录重启 | 组件模拟 profile 错误只启动 1 次且不创建备用目录；上游默认恢复行为保留。实际正常启动与取消通过；没有用真实故障 profile 破坏浏览器 |
| BrowserProfile.auto_reconnect（默认 True） | 设为 False；断线只发 ConnectionClosed 错误，宿主取消进行中的工作并收尾；Agent 不等待自动重连 | 组件确认不创建重连任务；真实 CDP 关闭后 reconnectAttempts=0、modelCalls=0、actions=0、cleanupConfirmed=true。没有用付费模型制造断线 |
| Agent.capture_screenshots（默认 True） | 设为 False，且必须 use_vision=False；默认状态请求和历史持久化都关闭截图；探针只在 click / done 前主动采集 | 组件确认请求参数为 False，甚至传入已有截图也不持久化；真实 Qwen 检查确认 SDK 截图目录为空，关键证据 before-2.png / before-3.png 存在 |

## 可复现构建与维护

upstream.json 固定源码 URL、源码 SHA-256、补丁 SHA-256、补丁版本与 wheel SHA-256；build-requirements.lock 固定 hatchling 及其余 5 个构建依赖和哈希。build-runtime.py 在独立临时目录验证源码、检查并应用 patch，通过正常构建后端生成 wheel；SOURCE_DATE_EPOCH 固定。两次独立构建的 wheel 哈希一致，构建脚本仅在哈希匹配后复制到被忽略的 dist/。

```sh
uv venv --python 3.13.13 resources/testing/ui/browser-use/.venv
resources/testing/ui/browser-use/.venv/bin/python resources/testing/ui/browser-use/build-runtime.py
uv pip sync --python resources/testing/ui/browser-use/.venv/bin/python resources/testing/ui/browser-use/requirements.lock --require-hashes
resources/testing/ui/browser-use/.venv/bin/python tests/helpers/browser-use-runtime.check.py
resources/testing/ui/browser-use/.venv/bin/python tests/helpers/browser-use-probe.check.py
```

从仓库根目录执行；构建要求本机已有 uv、Git 和 Python 3.13，源码下载与依赖准备需要网络。wheel 不提交，不是启动时在线构建；开发者或后续客户端构建阶段预先生成。构建、哈希校验或同步失败即停止，不降级到官方包继续运行；探针也检查实际安装版本。变更补丁时须更新 patch / wheel 哈希并重新验证；升级上游时重新核对源码及行为，不自动套用旧补丁。MIT 来源和固定版本见 upstream.json；本轮不承诺跨平台发布准备完成。

## 当前交付边界

用户已明确批准依赖来源调整，原三个阻塞已在补丁版的受控范围内解决。维护、验证和供应链锁定由本仓库承担，不将补丁版能力写成上游官方承诺。此次未接入正式 Pi 工具、候选版本、发布门槛和界面，不把受控小验证写成真实项目验收。后续可按方案进入阶段 2，扩大动作范围时仍须验证相应行为。

本轮两次可选文件读取分别尝试 agent/README.md 和 browser/event_bus.py，均以 No such file or directory、退出 1 结束。发生时间为 2026-11-06（Asia/Shanghai，具体时分未记录）；链路为用户继续 → functions.exec / exec_command → 本地 sed 只读读取，未使用技能。已停止这些读取，没有按原路径重试或据此判断接口存在；后续结论仅依据已确认存在的源码、公开构造签名和实际产物。没有写入或模型影响；若需要补充上游文档，应先取得准确文档位置。这些路径错误不构成新浏览器故障。

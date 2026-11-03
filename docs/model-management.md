# 模型与供应商

按 Pi `v1.4.0` 的 [Custom Providers](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/custom-provider.md) 与 [Models](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md) 接入。兼容已有协议的接口使用 `models.json`；动态模型发现、特殊认证和自定义流式协议使用 Provider 扩展。沿用 Electron、原生 DOM、现有设置分类及主题配色。

## 配置与使用

设置 → 模型与供应商：

1. “打开 models.json”打开官方目录的配置文件；首次不存在时创建空 `providers`，不覆盖已有文件。目录由 `getAgentDir()` 决定，默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定。
2. 在文本编辑器中保存，然后点击“重新读取模型”。页面提供兼容接口的折叠示例。字段、环境变量引用与命令取值均遵循官方格式，建议用 `$YOUR_API_KEY` 引用已有环境变量。
3. 聊天输入框右下角选择当前模型。目录使用官方 `ModelRuntime.getAvailable()`，按供应商分组，以供应商和模型 ID 区分同名模型。
4. “设为新对话默认”通过官方 `SettingsManager` 保存当前选择；思考强度只调整当前对话。

Provider 扩展放入官方资源目录或受信任项目，通过扩展工厂的 `registerProvider` 登记；异步工厂在启动选择模型前完成。修改扩展后在聊天中执行 `/reload`。普通“重新读取模型”只刷新模型运行时，不重新执行扩展工厂。特殊协议实现、原生 Provider、虚拟模型及认证契约见官方文档，不再额外维护桌面私有格式。此页不提供自建 OAuth 登录流程；已有 Pi 环境变量、`auth.json` 与 `models.json` 认证由官方运行时解析。

新对话选择优先级为：官方设置中的默认供应商和模型 → `.env` 的 `PI_PROVIDER`/`PI_MODEL` → SDK 自动选择。两个环境字段可以同时留空。恢复对话优先使用历史或可信空会话登记中的供应商与模型，默认设置不会覆盖它们。`.env` 的 `PI_BASE_URL` 仅作为未在 `models.json` 登记供应商的地址后备；官方配置和 Provider 扩展可覆盖该后备。

页面只接收官方配置路径、模型编号、名称及必要会话信息，不读取或回填配置原文与密钥。文件路径由主进程固定生成。重读、切换、设默认及思考强度共用现有操作互斥；切换报错后重新读取 SDK 的实际选择。配置损坏时仍可通过设置打开文件修正。

## 旧实现移除

已删除应用私有的配置档案、复制/隐藏快照、命名密钥、OAuth 流程、目录探测和参数补全，以及对应存储、IPC、组件与专项测试。旧的 `model-settings.json`、`model-credentials.json` 和 `model-catalogs` 不再读取，不自动迁移或删除用户文件；`.env` 与正式聊天历史不改写。

历史中由旧实现生成的 `desktop-profile-*` 是私有供应商 ID。若官方目录中未登记该 ID，恢复会明确报模型不可用，不自动换成默认模型。需要在官方配置中登记历史使用的供应商 ID 和模型，或新建对话；不保留旧配置服务来暗中恢复凭据。

## 代码位置

- `src/main/pi-agent.mjs`：官方运行时、扩展模型登记、启动与历史选择。
- `src/main/services/model-provider-service.js`：官方配置文件入口，首次安全创建。
- `src/main/services/session-service.js`：可用模型、切换、刷新、默认和思考强度。
- `src/main/ipc/model-ipc.js`、`src/preload/preload.js`：有限接口与共用互斥。
- `src/renderer/components/settings/model-providers.js`：设置页；`components/model-selector.js`：当前模型选择。
- `src/renderer/styles/model-settings.css`：设置外框与模型页样式。

## 验证

```bash
node --require ./tests/helpers/pi-test-isolation.cjs --test \
  tests/unit/custom-providers.test.js tests/unit/model-provider-service.test.js \
  tests/unit/model-config.test.js tests/unit/model-ipc.test.js \
  tests/unit/model-list.test.js tests/unit/model-switch.test.js \
  tests/unit/model-thinking.test.js tests/unit/model-restore.test.js \
  tests/unit/pi-agent-init.test.js tests/unit/session-info.test.js \
  tests/unit/agent-ipc.test.js tests/unit/registration-sync.test.js \
  tests/unit/composer-registration.test.js tests/unit/empty-session-rebuild.test.js \
  tests/unit/unsent-session-service.test.js tests/unit/pi-native-runtime.test.js
node_modules/.bin/electron tests/ui/model-providers.check.cjs
node_modules/.bin/electron tests/ui/sidebar-layout.check.cjs
node_modules/.bin/electron tests/ui/theme-settings.check.cjs
```

SDK 专项使用临时配置、会话与本地 HTTP/SSE 服务，覆盖官方配置优先级、跨供应商同名模型、历史恢复、异步 Provider 扩展、重读、坏配置、增量回复、原生 write 工具落盘和 SDK 取消结果。页面专项覆盖新入口、旧接口移除、操作互斥、错误后实际选择、配置修复、迟到响应和深色/樱粉下的宽窄布局。自动测试不读取真实 `.env`、个人资源或聊天历史，不请求外部模型。

2026-11-03 经用户明确授权，另在临时官方 `models.json` 中登记 `acceptance-custom`，使用 `.env` 中已有的 `deepseek/deepseek-flash` 模型信息和进程内认证，真实请求收到 5 段文本增量。未将密钥写入配置，未读取正式历史或修改正式 Pi 配置。随后使用下述脚本再次通过自定义供应商完成真实流式回复、read/write/edit/bash 临时文件操作、主动停止与子进程退出。以上结果不代表所有供应商、OAuth 或协议均已验收。需再次授权真实请求时，可手动运行 `node_modules/.bin/electron scripts/verify-pi-live.cjs` 检查同一路径及原生工具；不属于默认自动测试。

本次相关的 83 项单元/SDK 检查通过；Electron 模型页 20、侧栏 37、主题 42、上下文 19、未发送会话 19、关闭 14、扩展桌面 16、归档 17、置顶 19、项目重命名 16 项通过。页面结果使用模拟或临时业务数据，与上述真实模型验证分别记录。

# 客户端内置 UI 测试

首期闭环：Agent 使用官方 Playwright Test MCP 操作页面、读取生成日志、保存 CommonJS case 和业务断言，再经 Pi 原生 bash 调用官方 CLI 回放，输出 JSON、HTML、trace 和失败截图。被测工作目录只保存 case 和执行证据，不需要安装 Node、Playwright 或浏览器。

## 代码分工

| 目录或文件 | 职责 |
| --- | --- |
| `src/main/capabilities/ui-testing/runtime-paths.js` | 开发环境和打包后的资源定位 |
| `src/main/capabilities/ui-testing/extension.mjs` | `qa_ui_prepare`、官方 MCP 登记和生成日志保存 |
| `resources/testing/ui/` | 固定版本依赖、Playwright 配置、环境检查和 `qa-ui-basic` 技能 |
| `tooling/testing/ui/prepare-runtime.cjs` | 准备当前平台的 Node 与匹配浏览器 |

`bootstrap.js` 将运行环境交给 `pi-agent.mjs` 和官方资源加载器。仅提供运行环境时登记一次 `builtin:desktop-ui-testing`，允许 Pi 官方配置禁用或替换；资源和 MCP 生命周期由 Pi 1.4.0 管理。不覆盖默认工具，不增加宿主关键词路由。

开发路径为 `resources/testing/ui`；打包后读取 `process.resourcesPath/testing/ui`。Node、浏览器、node_modules、运行证据不提交 Git。发布时必须把对应平台的完整运行环境复制到该资源目录；当前验证不代表安装包已完成构建、签名或分发验收。

## 使用

重启客户端或重载 Pi 资源后，在被测工作目录的新会话中明确选择 `/skill:qa-ui-basic`，提供页面 URL、操作和预期。例如：

> 使用 qa-ui-basic，caseId 为 add-todo，访问我的待办页面，新增“回归测试”。断言列表恰有一条、文本精确匹配、默认未完成、输入框为空。保存 case 后回放并给出原始结果和报告路径。

`qa_ui_prepare` 的 `record` 模式拒绝覆盖同名资产；`run` 模式要求已有 `.spec.cjs`，每次创建独立 run。`prepared` 只表示准备完成。

工具返回的 `caseFile` 是绝对路径，供读取和交付；`caseFileName` 是工作目录相对路径，必须用于官方 `generator_write_test.fileName`，其公开实现不接受绝对路径。页面操作参数以当前官方工具 schema 为准，包括 `target` 和必要的 `intent`。

录制完成先关闭页面，再执行返回的 `replayCommand`。正式回放不用 MCP `test_run`，因为该入口禁用配置报告器。CLI 退出码、原始 errors 和唯一测试的最终状态共同决定结论；跳过、取消、未运行或报告缺失不能判通过。当前回放命令使用 POSIX shell，Windows 尚未适配。

## 验证与边界

运行 `node --test tests/unit/ui-testing-runtime.test.js`。浏览器集成项需要先准备内置运行环境，否则明确跳过；资源加载项始终运行。

临时目录检查覆盖：

- 真实 Pi SDK 中无运行环境、启用、官方禁用时的工具与技能登记。
- 真实官方 MCP 的页面准备、点击、生成日志、脚本写入、页面关闭和 CLI 回放。
- 空格、中文、单引号路径和带单引号 URL 的参数传递；只执行目标 case，排除 seed 和其他文件。
- 本地待办页面四项断言通过、故意错误断言失败、独立批次、JSON/HTML、trace 和失败截图。

测试不请求模型、不使用真实凭据、不访问业务站点。生成日志保存钩子使用真实 MCP 结果显式投递事件检查；不冒充真实模型调用链验收。Agent 是否能根据自然语言自主选择技能、操作业务页面并设计有效断言，以及 Electron 打包后运行，仍需分别验收。

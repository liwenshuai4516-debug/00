# Pi 1.4.0 原生接入

资源与工具优先遵循固定版本的 [Pi SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)。Electron 继续负责模型选择、会话绑定、输入保存和窗口交互。

## 资源位置

运行入口使用官方 `getAgentDir()`：默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定。设置、信任记录和内置 MCP 使用同一目录。旧 `<userData>/pi-resources` 内容保留，未自动搬迁；已有资源需要放入所选的官方目录。

由 `SettingsManager.create` 和 `DefaultResourceLoader` 处理：

- 用户 `settings.json` 中的资源路径、过滤和 `packages`。
- 用户与受信任项目的技能、模板、扩展、主题。
- 个人和项目 `.agents/skills`，包括官方祖先目录及仓库边界规则。
- `SYSTEM.md`、`APPEND_SYSTEM.md` 与上下文文件。

技能保留官方独立 Markdown、便携 `SKILL.md` 目录与链接支持；参考文件、脚本和资产按实际 Pi 工具使用。警告、冲突与加载失败通过主进程诊断提示，名称冲突遵循官方先发现者保留规则。应用内置技能通过显式路径追加，不抢占其他来源的名称。

## 工具与文件状态

不传入自定义工具允许名单或替代 read。默认启用 read、bash、edit、write，尊重 `defaultTools`；扩展工具也遵循 Pi 登记及启用语义。edit 的参数为 `path` 和 `edits: [{ oldText, newText }]`。

原生 edit/write 和命令可直接改动文件，成功后不再等待草稿保存。工作目录是相对路径基准，不限制绝对路径或命令的访问范围。旧草稿的存储、审阅和历史记录仍可使用，其限制不适用于原生工具。

模型与凭据仍由现有模型服务通过 SDK 的 model/modelRuntime 显式提供；会话仍通过 sessionManager 使用应用的真实目录绑定与历史。Pi 设置中的模型或会话默认值不会覆盖这些宿主显式参数。

## 信任与扩展

项目信任按官方顺序处理：用户扩展 project_trust 事件、最近保存的目录决定、全局默认策略、桌面确认。拒绝时由官方 loader 跳过受保护的项目资源；上下文文件不属于此保护范围。信任不会限制工具、扩展或安装器的进程权限。

内置 codemode、tool-search 和 MCP 通过公开工厂登记，支持其官方 builtin 配置和替换行为。会话调用 bindExtensions 启动运行时；切换或关闭时等待 session_shutdown 与设置保存后再 dispose。输入保存失败或会话清理失败时保留窗口。

`/reload` 调用官方 session.reload，不请求模型，并与聊天发送及其他主进程操作互斥。扩展 ctx.reload 接入同一重载函数。加载诊断和运行事件错误分别报告。

当前扩展运行在 SDK 的非终端 json 模式，hasUI=false。通用工具、事件和命令可用；TUI 自定义组件、对话框、完整命令会话控制、Pi 主题到 Electron 配色的映射尚需专门适配。不能把文件加载成功当成所有桌面交互都受支持。

## 包与验收范围

配置中的本地包已按官方标准目录或可选 pi 清单加载；不要求 pi-package 画廊关键词。当前未新增安装、更新、删除界面，远程包与安装过程未验收。

离线检查使用临时配置、目录和会话，屏蔽真实个人技能目录，不请求模型。覆盖技能格式/链接/冲突、项目允许/拒绝、祖先目录边界、模板参数、系统提示词、原生读写/命令、扩展启动/重载/关闭，以及本地 stdio MCP 工具与子进程退出。

真实桌面仍需人工核对信任弹窗、自动技能选择、停止、模型登录/推理和关闭行为；保留的历史提示词快照不会被静默重写。已有快照若引用旧工具，以桌面追加的实际工具说明为准。

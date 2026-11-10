# Agent 提示词维护

## 维护入口与生效范围

| 内容 | 入口 | 生效范围 |
| --- | --- | --- |
| 通用任务推进、工具结果、安全与续跑语义 | [agent-system-prompt.mjs](../src/main/prompts/agent-system-prompt.mjs) | 会话初始化时追加，不替代 Pi 原生系统提示词及官方资源发现 |
| 默认测试职责与技能路由 | [test-agent-prompt.mjs](../src/main/prompts/test-agent-prompt.mjs) | 没有已保存配置时作为默认值；已有自定义配置优先，新对话保存业务提示词快照 |
| 用例粒度、覆盖与审批关联 | [UI 用例规则](ui-case-rules.md) | 详细规则在对应技能维护，不复制到默认提示词 |
| UI 主 Agent 执行流程 | [qa-ui-basic/SKILL.md](../resources/testing/ui/skills/qa-ui-basic/SKILL.md) | 明确阶段继续条件，调用探索前读取规则文件 |
| 正式回归与审批测试执行 | [qa-ui-execute/SKILL.md](../resources/testing/ui/skills/qa-ui-execute/SKILL.md) | 正式版本回归；审批任务按项目流程与已确认人员账号映射执行，仍以实际工具能力为前提 |
| 功能探索提示词 | [prompt/exploration-control.md](../resources/testing/ui/prompt/exploration-control.md) | 统一维护优先探索、自由发现、覆盖维度、审批技能条件加载、功能核实与去重回写及停止规则；当前阶段和独立目标写入 contract.goal |
| 当前任务的探索约定 | 当前工作区 `qa/ui/tasks/<taskId>/task.json` 的 contract | qa_ui_explore 保存本次约定；不覆盖其他任务或已冻结预期 |
| browser-use 提示词加载 | [explore.py](../resources/testing/ui/browser-use/explore.py) | 每次探索按入口相对位置读取 prompt/exploration-control.md，与 goal、冻结 contract 组装为 Agent 的 task |
| 系统提示词运行日志 | [prompt-diagnostics.mjs](../src/main/resources/prompt-diagnostics.mjs)，由 createPiAgent 绑定 | 每次实际 agent_start 打印当轮有效系统提示词与动态配置，日志副本脱敏；不改写模型输入 |
| 自动恢复与新对话交接 | [看门狗](agent-watchdog.md) | 按已实现的启用、取消和恢复条件运行，提示词本身不启动看门狗 |

修改源码默认值不会覆盖已保存的自定义业务提示词，也不会热改旧会话的业务提示词快照。已保存配置的用户需在「设置 → 提示词」按需更新，并新建对话；通用桌面提示词在下次会话初始化时读取。运行中的会话不会因文件修改立即更新。

内置 UI 工具是否存在由扩展登记与禁用状态决定，子智能体也不因继承测试职责就获得父级 UI 工具。提示词只做条件路由，真实能力、权限、参数及成功状态以实际工具和技能为准；不建立第二套能力清单或绕过 Pi 的加载规则。

UI 探索提示词集中放在 `resources/testing/ui/prompt/`，沿用现有工具参数，没有新增设置项或资源发现入口。修改规则后，主 Agent 调用前按技能引用重新读取；browser-use 在下一次探索时自动读取 UTF-8 正文，不缓存到后续任务，也不改变已启动的探索。文件缺失、不可读或为空时任务失败，不使用旧路径或内嵌后备。开发资源位置为 resources/testing/ui/prompt/exploration-control.md，发布需完整复制到 process.resourcesPath/testing/ui/prompt/exploration-control.md，不依赖被测工作区的 cwd。

主 Agent 按提示词先处理指定功能，再继续其他功能的只读自由探索；初始清单是优先顺序，不是功能白名单。单次工具仍核对已匹配项目、身份、控件和输入；主 Agent 从真实轨迹提取新入口，按独立目标声明后续任务，无需再次确认只读功能范围。工具自身不会在 completed 后启动下一目标；队列、总预算与停止依据由主 Agent 维护。新发现默认只探索，不自动生成、执行或发布额外用例，不扩大写入授权。完整流程以 qa-ui-basic 为准，用例拆分与语义覆盖仍以 qa-ui-case-design 为准。

探索中发现明确审批线索时，主 Agent 按探索提示词加载实际测试工作区已登记的 qa-approval-workflow，将本次适用的只读要点与来源放入后续 contract；普通功能不加载。成功且清理确认的探索后，主 Agent 核实并去重，将有证据的新检查点和项目专属功能索引回写至当前生效的探索提示词，详细依据保存在原任务 discoveries.md。条件路由与文件回写属于主 Agent 提示词约定，工具不提供自动持久化服务；文件不可写或并发版本变化时保留发现并报告待处理。安装包资源不能假定可写，本次没有新增可写运行副本或跨版本迁移机制。

## 查看每轮实际系统提示词与动态配置

会话创建后在每次实际 `agent_start` 打印一次主进程 `console.info` 日志；新会话首轮、恢复会话的下一轮和子会话均按各自 session 记录。只创建空会话、执行被扩展消费的命令或 `/reload` 不生成运行记录；同轮工具调用后的多次响应不重复打印。重载沿用该会话订阅，替换会话重新绑定，SDK dispose 释放旧订阅。

开发时从 `npm start` 的终端查看，使用 `[Pi 桌面] 本轮完整系统提示词` 搜索。打印格式为 `round=<UUID> session=<实际会话编号> <原文字符数> 字符`，随后是“系统提示词开始/结束”与“动态配置开始/结束”分隔块。不添加独立日志文件、不转发到页面或写入会话历史；安装包中的日志查看方式由进程启动方式决定，本次未新增文件日志或界面入口。

系统提示词直接读取 SDK 的 `session.systemPrompt`，包含当时的原生提示词、已生效的业务职责快照、桌面语言/行为边界/最终回答协议、项目上下文、技能目录和扩展修改。没有另建一套摘要或硬编码角色，不覆盖 SYSTEM.md/APPEND_SYSTEM.md 与历史快照；技能目录不等于技能正文已读取。此日志记录运行开始时的有效状态，不代表后续 `context_with_system`、供应商请求转换或工具轮次中更新后的最终网络载荷，也不打印用户消息、工具结果、内部思考或请求头。

动态配置记录当时的北京时间（固定 Asia/Shanghai、UTC+08:00）、操作系统用户名（项目没有独立用户登录体系，不冒充业务账号）、实际会话目录的末级名称、MCP 接入是否已加载及当前已登记工具的名称/暴露方式。连接器启用按实际 `mcp_servers_change` 处理器判断；未配置任何服务也可能已启用，工具登记不代表服务连接或认证成功，未查询的连接状态明确标注。日志不会为诊断主动连接 MCP、请求模型或读取认证配置。

真实运行路径包含会话工作目录、进程 cwd、实际 Node/Electron 可执行文件、当前 Agent 模块入口、Pi 资源目录和会话存储目录；不把启动 cwd 当成会话目录。日志仅处理副本：遮蔽已持有的启动 API Key 和常见的密码、令牌、Authorization/Cookie、URL 凭据及私钥格式，原文字符数仍按脱敏前 JS 字符串长度计。未标识的敏感业务正文无法由格式匹配保证识别，项目指引与自定义提示词仍不应保存凭据；日志诊断失败只报告未确认，不改变原运行结果。

定向验证（临时配置、真实 SDK、离线模型流，不访问真实认证或外部服务）：

```bash
node --test tests/unit/prompt-diagnostics.test.js
```

核对北京时间跨日、路径与会话归属、MCP 接入状态、凭据脱敏、扩展修改后的提示词、空会话/命令不打印、工具多轮不重复、重载/恢复/新会话绑定及日志不进入历史。离线替身不能代替真实供应商网络载荷或安装包验收。

## 借鉴来源与取舍

来源为 WaterMate 项目的 `src/backend/agents/prompts/`，按本项目 Electron + Pi 1.4.0 的实际契约改写，作为设计参考，不在运行时导入外部文件。参考工作副本读取日期为 2026-11-09，读取时 HEAD 为 `c85cc878673165971e43280b6bffb95c82b5892b`；后续外部改动不自动同步。

| 来源文件 | 吸收内容 | 本项目适配 |
| --- | --- | --- |
| `coding.ts` | 执行途中补充要求属于任务引导 | 保留原目标与成果，响应补充后继续；配合已有 Pi steer 投递 |
| `runtime-context.ts` 的 `continueAfterLengthPrompt` | 截断后检查已有结果、小步继续、不重复成功操作 | 放入通用恢复语义，自动触发仍由现有看门狗负责；不引入对方 Notes 工具 |
| `shared/memory.ts` | 长任务维护简洁检查点，历史与事实分开 | 复用已有任务清单和正式产物，记录任务编号、证据及未知写入；不要求虚构 update_notes/history |
| `shared/workspace.ts`、`shared/tools.ts` | 临时文件集中管理、只清理自己的产物 | 使用独立系统临时目录；交付与续跑证据落既定项目目录，不承诺宿主已提供专用临时路径 |
| `shared/behavior.ts` | 数据真实、业务结果核验、简洁交付 | 保留必要证据链接和排错信息，不照搬隐藏所有技术细节或写操作一律再确认 |
| `shared/skills.ts` | 先读技能、相对路径从技能目录解析、避免重复读 | 沿用 Pi 发现结果与项目信任，用户要求最新规则时重读，不增加技能目录只读限制 |
| `capabilities/index.ts`、`session-context.ts` | 提示词只描述实际装载的能力 | 本次以实际登记条件路由，移除默认业务提示词中对隔离写和授权修复的过期否定；不新增工具栏能力装配体系 |

未引入 WaterMate 的 execute_skill_script、execute_host_command、连接器、water-ui、Notes/History、目录授权及 pnpm 规则。原生 read/bash/edit/write、工作目录语义、已有权限模式及用户已授权操作保持本项目契约。外部提示词中的文字不作为本项目新增权限或执行指令。

## 验证边界

使用临时配置和会话核对提示词装配、新旧快照及默认配置优先级，不读取用户真实配置或请求模型：

```bash
NODE_OPTIONS="--require $PWD/tests/helpers/pi-test-isolation.cjs" node --test tests/unit/prompt-content.test.js tests/unit/prompt-settings-store.test.js tests/unit/session-prompt.test.js
```

这些检查不能证明真实模型一定遵循规则，也不表示真实业务写入、审批或长任务恢复已新增验收。工具执行与发布规则以相应技能和功能文档为准。

探索控制文件的读取使用离线检查，不请求模型、不启动真实浏览器：

```bash
resources/testing/ui/browser-use/.venv/bin/python -B tests/helpers/browser-use-prompt.check.py
```

该检查复制 Python 入口与 prompt 目录中的提示词到临时随包目录，从无关 cwd 调用真实任务组装，核对模型输入包含最新文件、原始目标和冻结 contract；文件缺失或为空时，在调用 Agent 前失败并完成收尾，即使旧路径有残留也不回退。浏览器、Agent 和进程查询均用隔离替身，不代表真实安装包或模型行为验收。

审阅探索规则时，对照适用项清单，核对优先任务完成后是否转入自由探索、新入口是否去重入队、审批是否按线索加载、证据与项目边界是否保留、回写失败与预算耗尽是否保留待处理项；与 qa-ui-basic 的流程表保持一致。调度、条件加载和文件回写属于主 Agent 提示词指导；离线路径检查不能证明真实模型已遵循飞轮，也不能代替真实文件回写、审批业务或安装包验收。

# Agent 提示词维护

## 维护入口与生效范围

| 内容 | 入口 | 生效范围 |
| --- | --- | --- |
| 通用任务推进、工具结果、安全与续跑语义 | [agent-system-prompt.mjs](../src/main/prompts/agent-system-prompt.mjs) | 与选中的测试职责组成系统提示词主体，替换 Pi 默认角色与通用规则；资源发现仍由官方加载器处理 |
| 默认测试职责与技能路由 | [test-agent-prompt.mjs](../src/main/prompts/test-agent-prompt.mjs) | 没有已保存配置时作为默认值；已有自定义配置优先，新对话保存业务提示词快照 |
| 用例粒度、覆盖与审批关联 | [UI 用例规则](ui-case-rules.md) | 详细规则在对应技能维护，不复制到默认提示词 |
| UI 主 Agent 执行流程 | [qa-ui-basic/SKILL.md](../resources/testing/ui/skills/qa-ui-basic/SKILL.md) | 明确阶段继续条件，调用探索前读取规则文件 |
| 正式回归与审批测试执行 | [qa-ui-execute/SKILL.md](../resources/testing/ui/skills/qa-ui-execute/SKILL.md) | 正式版本回归；审批任务按项目流程与已确认人员账号映射执行，仍以实际工具能力为前提 |
| 功能探索提示词 | [prompt/exploration-control.md](../resources/testing/ui/prompt/exploration-control.md) | 统一维护优先探索、自由发现、覆盖维度、审批技能条件加载、功能核实与去重回写及停止规则；当前阶段和独立目标写入 contract.goal |
| 当前任务的探索约定 | 当前工作区 `qa/ui/tasks/<taskId>/task.json` 的 contract | qa_ui_explore 保存本次约定；不覆盖其他任务或已冻结预期 |
| 本轮功能清单与转换汇总 | [本轮清单规程](../resources/testing/ui/skills/qa-ui-basic/references/coverage.md) | 主 Agent 通过 qa_ui_coverage 持续保存并冻结 qa/ui/rounds 准确版本；不由 browser-use 写入或计算 |
| browser-use 提示词加载 | [explore.py](../resources/testing/ui/browser-use/explore.py) | 每次探索按入口相对位置读取 prompt/exploration-control.md，与 goal、冻结 contract 组装为 Agent 的 task |
| 系统提示词启动日志 | [prompt-diagnostics.mjs](../src/main/resources/prompt-diagnostics.mjs)，由 createPiAgent 和 desktop runtime 接通 | 会话创建且扩展绑定完成后打印一次初始提示词（技能目录正文省略，只留可用数量）与动态配置；不订阅运行期诊断事件，日志副本脱敏；不改写模型输入 |
| 自动恢复与新对话交接 | [看门狗](agent-watchdog.md) | 按已实现的启用、取消和恢复条件运行，提示词本身不启动看门狗 |

修改源码默认值不会覆盖已保存的自定义业务提示词，也不会热改旧会话的业务提示词快照。已保存配置的用户需在「设置 → 提示词」按需更新，并新建对话；通用桌面提示词在下次会话初始化时读取。运行中的会话不会因文件修改立即更新。

系统提示词组装为：当前会话选中的测试职责 → AGENT_SYSTEM_PROMPT → 官方加载器发现的 SYSTEM.md 正文 → APPEND_SYSTEM.md → 项目指引、技能目录及扩展段。前两项通过公开 systemPromptOverride 成为主体，不再自动注入 Pi 的英文编码助手角色、默认工具介绍、通用规则和文档指引；真实工具及参数仍由 SDK 登记并传给模型。SYSTEM.md 与 APPEND_SYSTEM.md 分别保留项目文件优先于全局文件的发现规则，不叠加同名的全局与项目文件。

测试职责的选择顺序保持为已有会话快照、当前保存的设置、源码 TEST_AGENT_PROMPT（子会话可继承父级职责）。本次只改变组装位置，不迁移或覆写已有快照；重启客户端后重新打开会话使用新的组装方式，修改默认正文则仍只影响随后创建的新会话。

内置 UI 工具是否存在由扩展登记与禁用状态决定，子智能体也不因继承测试职责就获得父级 UI 工具。提示词只做条件路由，真实能力、权限、参数及成功状态以实际工具和技能为准；不建立第二套能力清单或绕过 Pi 的加载规则。

UI 探索提示词集中放在 `resources/testing/ui/prompt/`，沿用现有工具参数，没有新增设置项或资源发现入口。修改规则后，主 Agent 调用前按技能引用重新读取；browser-use 在下一次探索时自动读取 UTF-8 正文，不缓存到后续任务，也不改变已启动的探索。文件缺失、不可读或为空时任务失败，不使用旧路径或内嵌后备。开发资源位置为 resources/testing/ui/prompt/exploration-control.md，发布需完整复制到 process.resourcesPath/testing/ui/prompt/exploration-control.md，不依赖被测工作区的 cwd。

主 Agent 按提示词先处理指定功能，再继续其他功能的只读自由探索；初始清单是优先顺序，不是功能白名单。单次工具仍核对已匹配项目、身份、控件和输入；主 Agent 从真实轨迹提取新入口，按独立目标声明后续任务，无需再次确认只读功能范围。工具自身不会在 completed 后启动下一目标；队列、总预算与停止依据由主 Agent 维护。新发现默认只探索，不自动生成、执行或发布额外用例，不扩大写入授权。完整流程以 qa-ui-basic 为准，用例拆分与语义覆盖仍以 qa-ui-case-design 为准。

探索中发现明确审批线索时，主 Agent 按探索提示词动态读取 approval-control.md，再加载实际测试工作区已登记的 qa-approval-workflow，将本次适用的只读要点与来源放入后续 contract；普通功能不加载。成功且清理确认的探索后，主 Agent 核实并去重，将有证据的新检查点和项目专属功能索引回写至当前生效的探索提示词，详细依据保存在原任务 discoveries.md。条件路由与文件回写属于主 Agent 提示词约定，工具不提供自动持久化服务；文件不可写或并发版本变化时保留发现并报告待处理。安装包资源不能假定可写，本次没有新增可写运行副本或跨版本迁移机制。

## 查看会话启动时的系统提示词

会话创建完成（扩展已绑定、技能与工具已登记）后打印一次主进程 `console.info` 初始系统提示词日志；主会话与子会话按各自 session 分别记录，恢复会话重新创建时再记录一次。扩展命令替换会话也在绑定完成后打印。运行期间不再打印轮次标记、工具调用、工具返回或技能加载日志，资源重载不重复打印初始提示词。这里只移除控制台诊断订阅，SDK 的工具执行、技能动态加载和页面工具过程展示保持原有链路。

开发时从 `npm start` 的终端查看，使用 `[Pi 桌面] 初始系统提示词` 搜索。打印格式为 `session=<实际会话编号> role=<main|subagent> <原文字符数> 字符`，随后是“系统提示词开始/结束”与“动态配置开始/结束”分隔块。不添加独立日志文件、不转发到页面或写入会话历史；安装包中的日志查看方式由进程启动方式决定，本次未新增文件日志或界面入口。

系统提示词直接读取 SDK 的 `session.systemPrompt`，包含已生效的业务职责快照、桌面语言/行为边界/最终回答协议、自定义 SYSTEM.md/APPEND_SYSTEM.md、项目上下文、技能目录和扩展修改。其中 Pi 生成的 `<skills>` 可用技能目录只保留“可用技能 N 个”的统计行，不再打印整个目录正文；其余正文原样记录，没有另建一套摘要。Pi 默认英文角色已由配置正文替换，历史快照正文不改写；技能目录不等于技能正文已读取。此日志记录会话创建完成时的有效状态，不包含运行期 `before_agent_start` 等对提示词的追加或改写；也不代表后续 `context_with_system`、供应商请求转换或工具轮次中更新后的最终网络载荷，也不打印用户消息、工具结果、内部思考或请求头。

动态配置记录当时的北京时间（固定 Asia/Shanghai、UTC+08:00）、操作系统用户名（项目没有独立用户登录体系，不冒充业务账号）、实际会话目录的末级名称、MCP 接入是否已加载及当前已登记工具的名称/暴露方式。连接器启用按实际 `mcp_servers_change` 处理器判断；未配置任何服务也可能已启用，工具登记不代表服务连接或认证成功，未查询的连接状态明确标注。日志不会为诊断主动连接 MCP、请求模型或读取认证配置。

真实运行路径包含会话工作目录、进程 cwd、实际 Node/Electron 可执行文件、当前 Agent 模块入口、Pi 资源目录和会话存储目录；不把启动 cwd 当成会话目录。日志仅处理副本：遮蔽已持有的启动 API Key 和常见的密码、令牌、Authorization/Cookie、URL 凭据及私钥格式，原文字符数仍按脱敏前 JS 字符串长度计。未标识的敏感业务正文无法由格式匹配保证识别，项目指引与自定义提示词仍不应保存凭据；日志诊断失败只报告未确认，不改变原运行结果。

技能目录省略只作用于日志副本，模型仍收到完整 `<available_skills>` 目录（真实 SDK 检查同时断言两者）。日志仅省略 SDK 已组装的技能目录正文，不另建技能清单；资源重载后登记刷新，已开始的运行不因文件修改热更新。

定向验证（临时配置、真实 SDK、离线模型流，不访问真实认证或外部服务）：

```bash
node --test tests/unit/prompt-diagnostics.test.js
```

核对北京时间跨日、路径与会话归属、MCP 接入状态、凭据脱敏、初始提示词与扩展运行期改写的边界、技能目录正文不进入日志且仍发送给模型、原生 read 执行与 `/skill:` 动态展开成功且不产生运行期诊断。空会话创建即打印初始提示词，命令、工具多轮与重载不追加运行期日志或重复整段提示词，恢复/新会话/扩展替换均在扩展绑定后各自打印，日志不进入历史。离线替身不能代替真实供应商网络载荷或安装包验收。

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

日志仅在会话创建且扩展绑定完成后打印初始提示词，已移除运行期诊断订阅。定向验证使用 `NODE_OPTIONS="--require $PWD/tests/helpers/pi-test-isolation.cjs" node --test tests/unit/prompt-diagnostics.test.js tests/unit/session-prompt.test.js tests/unit/subagents.test.js tests/unit/pi-desktop-runtime.test.js`，覆盖创建即打印一次、运行与 `/reload` 不重复、工具成功执行与技能动态展开且不追加控制台日志、恢复/新会话/扩展替换的绑定顺序、子会话独立记录、失败只报告未确认。使用真实 SDK 和临时资源，不请求模型；真实启动后的终端输出与安装包仍需人工核对。

2026-11-10 系统提示词主体切换的定向验证：先在真实 SDK 隔离会话复现配置正文不在开头的断言失败，再通过公开 systemPromptOverride 修复。session-prompt、prompt-diagnostics、prompt-content、permission-trust 共 8 项通过，未请求模型；覆盖中文配置正文成为主体、默认英文角色与 read 通用规则不再注入、全局/项目 SYSTEM.md 和 APPEND_SYSTEM.md 的发现优先级、AGENTS.md 与技能保留、新旧会话及空会话恢复、资源重载、扩展最终提示词及日志脱敏。模型流为离线夹具，真实供应商行为与重新启动后的人工验收未执行。

补充执行 prompt-settings-store、prompt-ipc、subagents、workspace-changes-registration，并随新增默认 read 规则断言定向运行 prompt-diagnostics，11 项通过；扣除重复项，本次共 16 项定向测试通过。均使用临时资源和离线模型，不读取真实用户配置或请求模型。

本次源码定位中有两处候选路径不存在（tests/unit/pi-resources.test.js、src/renderer/components/settings/settings-templates.js），只读检索返回 No such file or directory，相关检索已停止；按实际文件索引定位到 session-prompt.test.js 和 src/renderer/index.html 后继续。发生于 2026-11-10 UTC+08:00，精确时间未记录；调用链为用户修改要求 → 原生命令工具 functions.exec/exec_command → 本地文件检索，未使用执行技能或下游服务。未重试原失败路径、无文件写入或未知业务结果，不影响上述验证结论。

探索控制文件的读取使用离线检查，不请求模型、不启动真实浏览器：

```bash
resources/testing/ui/browser-use/.venv/bin/python -B tests/helpers/browser-use-prompt.check.py
```

该检查复制 Python 入口与 prompt 目录中的提示词到临时随包目录，从无关 cwd 调用真实任务组装，核对模型输入包含最新文件、原始目标和冻结 contract；文件缺失或为空时，在调用 Agent 前失败并完成收尾，即使旧路径有残留也不回退。浏览器、Agent 和进程查询均用隔离替身，不代表真实安装包或模型行为验收。

审阅探索规则时，对照适用项清单，核对优先任务完成后是否转入自由探索、新入口是否去重入队、审批是否按线索加载、证据与项目边界是否保留、回写失败与预算耗尽是否保留待处理项；与 qa-ui-basic 的流程表保持一致。调度、条件加载和文件回写属于主 Agent 提示词指导；离线路径检查不能证明真实模型已遵循飞轮，也不能代替真实文件回写、审批业务或安装包验收。

## 审批提示词动态加载

审批授权继承、人员映射、逐节点执行、附件、未知结果核对、完整链候选与交付统一在 [approval-control.md](../resources/testing/ui/prompt/approval-control.md) 维护。qa-ui-basic、qa-ui-execute、qa-ui-case-design、探索提示词与报告技能仅保存条件路由，不在默认系统提示词预加载审批正文。用户明确要求审批或命中审批语义时，主 Agent 调用 qa_ui_approval instructions，工具每次从实际 runtime.directory/prompt 读取当前正文；已启动节点/冻结计划不被热改。

实际项目 qa-approval-workflow 负责业务流程和人员事实，不复制到客户端通用提示词。只读 browser-use 继续报告线索，由主 Agent 调度专用审批工具；它不自动展开整个审批链。实际路径、状态、输入输出及继续/停止条件见 [运行说明](ui-testing-runtime.md#审批执行边界)。提示词验收不等于真实模型或业务审批验收。

采购合同补充按 [approval-control.md](../resources/testing/ui/prompt/approval-control.md) 中项目限定的已确认口径执行：准确定位流程对照表，会签按用户最新确认采用串行、全部通过，继承已有凭据/残留确认，并按归档与终态章节冻结断言。凭据正文不进入提示词，宿主注入状态与用户已授权分开核对；旧用例或冻结计划需生成新修订，不能把历史记录条数当成新规则。

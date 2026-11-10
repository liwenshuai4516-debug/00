# Agent 提示词维护

## 维护入口与生效范围

| 内容 | 入口 | 生效范围 |
| --- | --- | --- |
| 通用任务推进、工具结果、安全与续跑语义 | [agent-system-prompt.mjs](../src/main/prompts/agent-system-prompt.mjs) | 会话初始化时追加，不替代 Pi 原生系统提示词及官方资源发现 |
| 默认测试职责与技能路由 | [test-agent-prompt.mjs](../src/main/prompts/test-agent-prompt.mjs) | 没有已保存配置时作为默认值；已有自定义配置优先，新对话保存业务提示词快照 |
| 用例粒度、覆盖与审批关联 | [UI 用例规则](ui-case-rules.md) | 详细规则在对应技能维护，不复制到默认提示词 |
| UI 主 Agent 执行流程 | [qa-ui-basic/SKILL.md](../resources/testing/ui/skills/qa-ui-basic/SKILL.md) | 明确阶段继续条件，调用探索前读取规则文件 |
| 功能探索范围与控制规则 | [exploration-control.md](../resources/testing/ui/exploration-control.md) | 统一维护范围、深度、去重与停止规则；主 Agent 将本次具体范围写入 contract.goal |
| 当前任务的探索约定 | 当前工作区 `qa/ui/tasks/<taskId>/task.json` 的 contract | qa_ui_explore 保存本次约定；不覆盖其他任务或已冻结预期 |
| browser-use 提示词加载 | [explore.py](../resources/testing/ui/browser-use/explore.py) | 每次探索按入口相对位置读取 exploration-control.md，与 goal、冻结 contract 组装为 Agent 的 task |
| 自动恢复与新对话交接 | [看门狗](agent-watchdog.md) | 按已实现的启用、取消和恢复条件运行，提示词本身不启动看门狗 |

修改源码默认值不会覆盖已保存的自定义业务提示词，也不会热改旧会话的业务提示词快照。已保存配置的用户需在「设置 → 提示词」按需更新，并新建对话；通用桌面提示词在下次会话初始化时读取。运行中的会话不会因文件修改立即更新。

内置 UI 工具是否存在由扩展登记与禁用状态决定，子智能体也不因继承测试职责就获得父级 UI 工具。提示词只做条件路由，真实能力、权限、参数及成功状态以实际工具和技能为准；不建立第二套能力清单或绕过 Pi 的加载规则。

UI 探索控制沿用现有工具参数，没有新增设置项或资源发现入口。修改规则文件后，主 Agent 调用前按技能引用重新读取；browser-use 在下一次探索时自动读取 UTF-8 正文，不缓存到后续任务，也不改变已启动的探索。文件缺失、不可读或为空时任务失败，不使用内嵌后备。开发资源位置为 resources/testing/ui/exploration-control.md，发布需复制到 process.resourcesPath/testing/ui/exploration-control.md，不依赖被测工作区的 cwd。范围与深度属于模型指导，实际导航、控件及输入约束仍由现有动作守卫校验；不表示已新增模块级路径拦截。完整流程以 qa-ui-basic 为准，用例拆分与语义覆盖仍以 qa-ui-case-design 为准。

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

该检查复制 Python 入口与提示词到临时随包目录，从无关 cwd 调用真实任务组装，核对模型输入包含最新文件、原始目标和冻结 contract；文件缺失或为空时，在调用 Agent 前失败并完成收尾。浏览器、Agent 和进程查询均用隔离替身，不代表真实安装包或模型行为验收。

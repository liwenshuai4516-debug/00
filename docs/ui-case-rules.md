# UI 用例生成规则维护

生成规则统一维护在内置技能 [qa-ui-case-design](../resources/testing/ui/skills/qa-ui-case-design/SKILL.md)，与 qa-ui-basic、qa-ui-assertion、qa-ui-execute 位于同一个 skills 目录。覆盖清单、拆分示例、独立性、预期来源、阶段数量及交付核对以该技能为准，本说明不复制规则正文。

## 维护位置与生效范围

| 规则 | 维护入口 | 生效范围 |
| --- | --- | --- |
| 通用 UI 用例生成规则 | resources/testing/ui/skills/qa-ui-case-design/SKILL.md | 设计、生成新用例或检查粒度时加载 |
| 任务角色与技能路由 | 应用「设置 → 提示词」的默认业务提示词 | 保存后新对话；已有对话保留原提示词快照 |
| 被测项目专属规则、数据准备及业务口径 | 被测项目实际工作目录的 AGENTS.md，较长规则放在明确引用的文档 | 按 Pi 项目指引加载；在当前任务要求 Agent 读取最新规则 |
| UI 工具操作、探索与候选约束 | 客户端 resources/testing/ui/skills/qa-ui-basic/SKILL.md；断言检查在 qa-ui-assertion/SKILL.md | 客户端内置技能，属于应用维护；不在单次任务中修改它来迁就测试结果 |
| 功能发现与探索顺序 | [prompt/exploration-control.md](../resources/testing/ui/prompt/exploration-control.md)，由 qa-ui-basic 引用 | 优先探索指定功能，再继续自由探索；按证据核实、去重回写新功能，按项目范围复用；新发现不自动扩大正式用例或写入授权 |
| 当前观察目标、输入条件、预期及来源 | 当前任务的覆盖清单与各探索 contract | 单次任务 expected 在探索前冻结；不限制后续功能发现 |
| 本轮清单、功能与检查项编号、候选映射和转换统计 | [qa-ui-basic/references/coverage.md](../resources/testing/ui/skills/qa-ui-basic/references/coverage.md) | 覆盖清单持久化为 qa/ui/rounds 准确版本；qa_ui_coverage 校验统计，语义覆盖仍按用例设计规则核对 |
| 审批链、节点、处理人及可选开关 | 实际测试工作区 .pi/skills/qa-approval-workflow/SKILL.md 及其 references | 出现明确审批线索时按探索提示词动态加载；属于本次用例设计范围时再与 qa-ui-case-design 关联生成 case |

内置默认提示词在 `src/main/prompts/test-agent-prompt.mjs`，只保留生成规则的技能路由。已保存的自定义提示词和旧会话快照不会被源码更新覆盖；其中若复制了旧规则，需手动改为引用 qa-ui-case-design，避免多处维护不同版本。

## 加载方式

UI 扩展通过官方 resources_discover 登记该技能，由 Pi 处理资源发现、过滤和冲突。qa-ui-basic 在生成前加载它，qa-ui-assertion 在检查新候选时引用它；仅回归或修复既有脚本不触发重新设计。禁用内置 UI 扩展时不登记该技能。

也可以在应用新对话中使用 `/skill:qa-ui-case-design` 并附上设计目标。客户端更新后新建对话以加载新技能目录；规则修改后的当前会话应明确要求重新读取文件，不依赖此前加载的旧正文。加载和结构验证不能代替真实模型行为或业务用例回放验收。

审批技能属于项目资源，不随内置 UI 技能分发；跨项目使用需在实际工作区安装完整 qa-approval-workflow 目录（含 references），并按 Pi 项目信任规则加载。生成规则按技能名称关联，不新增客户端私有扫描或绕过信任。未安装时保留审批待确认项，不能宣称已经读取该流程；已设计但不具备执行条件的审批 case 不计为可执行正式资产。

## 审批执行入口更新

出现审批线索时先由 qa_ui_approval instructions 动态读取 [审批提示词](../resources/testing/ui/prompt/approval-control.md)，再加载被测工作区的 qa-approval-workflow。业务事实由项目技能提供，节点拆分仍由 qa-ui-case-design 维护；执行授权与人员映射不再在多个技能重复维护。新工具支持按人员隔离执行完整链，终态及成功轨迹齐全后自动准备一条 E2E 草稿，随后沿 save_candidate/validate/publish 流程处理。单节点、权限和反向分支保持独立检查项，缺数据时保留执行缺口；一条完整链不能折算成多个节点用例。实际步骤、产物和失败规则见 [运行说明](ui-testing-runtime.md)。

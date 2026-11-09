# UI 用例生成规则维护

生成规则统一维护在内置技能 [qa-ui-case-design](../resources/testing/ui/skills/qa-ui-case-design/SKILL.md)，与 qa-ui-basic、qa-ui-assertion、qa-ui-execute 位于同一个 skills 目录。覆盖清单、拆分示例、独立性、预期来源、阶段数量及交付核对以该技能为准，本说明不复制规则正文。

## 维护位置与生效范围

| 规则 | 维护入口 | 生效范围 |
| --- | --- | --- |
| 通用 UI 用例生成规则 | resources/testing/ui/skills/qa-ui-case-design/SKILL.md | 设计、生成新用例或检查粒度时加载 |
| 任务角色与技能路由 | 应用「设置 → 提示词」的默认业务提示词 | 保存后新对话；已有对话保留原提示词快照 |
| 被测项目专属规则、数据准备及业务口径 | 被测项目实际工作目录的 AGENTS.md，较长规则放在明确引用的文档 | 按 Pi 项目指引加载；在当前任务要求 Agent 读取最新规则 |
| UI 工具操作、探索与候选约束 | 客户端 resources/testing/ui/skills/qa-ui-basic/SKILL.md；断言检查在 qa-ui-assertion/SKILL.md | 客户端内置技能，属于应用维护；不在单次任务中修改它来迁就测试结果 |
| 本次页面范围、输入条件、预期及来源 | 当前任务的覆盖清单与各探索 contract | 当前测试任务；expected 在探索前冻结 |

内置默认提示词在 `src/main/prompts/test-agent-prompt.mjs`，只保留生成规则的技能路由。已保存的自定义提示词和旧会话快照不会被源码更新覆盖；其中若复制了旧规则，需手动改为引用 qa-ui-case-design，避免多处维护不同版本。

## 加载方式

UI 扩展通过官方 resources_discover 登记该技能，由 Pi 处理资源发现、过滤和冲突。qa-ui-basic 在生成前加载它，qa-ui-assertion 在检查新候选时引用它；仅回归或修复既有脚本不触发重新设计。禁用内置 UI 扩展时不登记该技能。

也可以在应用新对话中使用 `/skill:qa-ui-case-design` 并附上设计目标。客户端更新后新建对话以加载新技能目录；规则修改后的当前会话应明确要求重新读取文件，不依赖此前加载的旧正文。加载和结构验证不能代替真实模型行为或业务用例回放验收。

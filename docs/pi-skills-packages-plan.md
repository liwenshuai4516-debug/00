# Pi 技能与包扩展接入计划书

- 适用版本：`@earendil-works/pi-coding-agent@1.4.0`（npm 别名 `@mariozechner/pi-coding-agent`）
- 规范依据：SDK 随包文档 `docs/skills.md`、`docs/extensions.md`、`docs/packages.md`、`docs/security.md`、`docs/sdk.md`、`docs/settings.md`
- 计划状态：待评审，尚未实施

## 1. 目标

为桌面客户端接入 Pi 的三层扩展能力，使其行为与 Pi CLI 一致，同时保持现有工作目录边界与密钥隔离不被破坏。

| 编号 | 目标 | 可观测结果 |
| --- | --- | --- |
| G1 | 技能按 Agent Skills 规范生效 | 系统提示词出现 `<available_skills>`，模型可读取并遵循 `SKILL.md` |
| G2 | 扩展能力生效 | 扩展注册的工具出现在会话工具集并可直接调用 |
| G3 | 包安装能力 | 用户可安装/卸载/更新 npm、git、本地包，其技能与扩展随之生效 |
| G4 | 不引入信任越界 | 任意外部工作目录中的 `.pi/extensions`、`.pi/skills` 一律不加载 |
| G5 | 失败可见 | 技能/扩展的加载诊断进入界面与日志，不出现"配了但静默不生效" |

## 2. 范围与非目标

**范围内**：资源加载链路改造、技能提示词注入、技能文件读取工具、扩展加载与错误上报、包管理服务与界面、离线自动检查。

**非目标（明确不做）**：

1. 不迁移到 Pi 的 TUI / RPC 模式，仍由本项目渲染层承载对话。
2. 不开放项目级资源自动发现（`.pi/*`），改用宿主白名单注入。
3. 不做扩展市场的内容审核与在线分发，只做已安装包的本地管理。
4. 不引入 `codemode`、`tool_search`、MCP 内置扩展；如后续需要，另立计划。
5. 不改动现有模型的凭据存储与请求链路。

## 3. 现状核实

### 3.1 事实基准（均为本次源码核实，勿凭记忆修改）

| 事实 | 证据位置 |
| --- | --- |
| 资源加载器把五类资源全部关闭 | `src/main/pi-agent.mjs:80-91` |
| `agentDir` 指向用户真实 Pi 目录 | `src/main/pi-agent.mjs:82`（`getAgentDir()`） |
| 工具以纯名称白名单传入 | `src/main/pi-agent.mjs:137`（`tools`） |
| 未调用 `bindExtensions()`，`session_start` 不触发 | `src/main/pi-agent.mjs:131-140` |
| 全部工具名不含 `read` / `bash` | `src/main/tools/*.mjs` |
| 读取工具受工作目录边界约束 | `src/main/tools/read-text-file.mjs:22` → `workspace/path-policy.mjs` |
| `noSkills: true` 时 `additionalSkillPaths` 仍会加载 | `resource-loader.js:424` |
| `noExtensions: true` 时 `additionalExtensionPaths` 仍会加载 | `resource-loader.js:409` |
| `<skills>` 段仅在工具集含 `read`/`bash` 时生成 | `dist/core/system-prompt.js:100-108` |
| `tools` 纯名称列表会成为允许名单，扩展工具被过滤 | `agent-session.js:1141`、`agent-session.js:2875` |
| 纯 `+name`/`-name` 修饰符形式不产生允许名单 | `dist/core/sdk.js`（`allowedToolNames` 赋值分支） |
| `prompt()` 自动展开 `/skill:name` | `agent-session.js:1661`、`agent-session.js:1727` |
| `packageManager.resolve()` 在加载期不自动安装缺失包 | `resource-loader.js:369`（未传 `onMissing`） |
| 项目信任受保护资源清单 | `docs/security.md:35-45` |

### 3.2 五个阻塞项

**B1 全关状态**：`noExtensions`、`noSkills` 等五开关为 `true`，任何资源都不会加载；且 `agentDir` 指向用户真实 `~/.pi/agent`，一旦放开即读取用户全局配置，等于把应用行为交给外部目录。

**B2 技能清单进不了提示词**：SDK 只在活动工具含 `read` 或 `bash` 时生成 `<skills>` 段。本项目工具名为 `read_workspace_text_file` 等，条件恒假，`skills` 段恒为 `undefined`。**即使打开 `noSkills` 也完全无效且无任何报错**，这是最容易被误判为"已接入"的陷阱。

**B3 技能文件读不到**：`formatSkillsForPrompt` 写入的 `<location>` 是绝对路径，而唯一的读取工具被 `resolveWorkspacePath` 限制在工作目录内。技能目录位于 `userData` 下，模型拿到路径也无法读取。

**B4 扩展工具被白名单过滤**：`tools: [...]` 传纯名称时为允许名单，扩展工具名在会话创建前不可知，必然被过滤；表现为"扩展加载成功但工具不出现"。

**B5 扩展生命周期未接**：未调用 `bindExtensions()`，扩展的 `session_start`、`resources_discover` 不触发，依赖启动钩子的扩展（连接、资源注册）静默失效。

## 4. 设计决策

| 编号 | 决策 | 理由 | 规范依据 |
| --- | --- | --- | --- |
| D1 | 采用**宿主白名单注入**：保持 `noSkills`/`noExtensions` 为 `true`，资源只经 `additional*Paths` 显式注入 | 关闭自动发现即不可能加载用户工作目录下的可执行代码；同时不触发项目信任流程 | `resource-loader.js` 中 `additional*Paths` 不受开关影响的既有行为；`security.md` 信任边界说明 |
| D2 | 应用私有配置根取代 `getAgentDir()`：`<userData>/pi-agent` | 与用户自己的 Pi 配置完全隔离，包安装、settings.json 均落在应用私有目录 | `sdk.md` 的 `agentDir` 选项 |
| D3 | 技能清单由宿主自行渲染并追加到 `appendSystemPrompt`，不依赖 SDK 自动生成 | 绕开 B2 的 `read`/`bash` 判定，且渲染内容与官方 `formatSkillsForPrompt` 同源 | `skills.md` 的启动广告机制；`formatSkillsForPrompt` 签名只接受 `read`\|`bash`\|`indirect` |
| D4 | 新增只读工具 `read_skill_file`，仅允许读取已登记技能根目录 | 解决 B3，且不放松既有的工作目录写入边界 | `extensions.md` 工具契约；本项目路径策略 |
| D5 | P2 起把工具选择改为"空默认 + `+name` 修饰符"，并改用文件型 settings | 消除允许名单对扩展工具的过滤；文件型 settings 才能持久化 `defaultTools` 供 P3 的包管理复用 | `agent-session.js` 允许名单逻辑；`settings.md` 的 `defaultTools` 语义 |
| D6 | 扩展加载后显式调用 `bindExtensions({ mode: "json", onError })` | 桌面宿主无 TUI，`mode: "json"` 对应无界面宿主；同时把扩展错误引到主进程日志 | `extensions.md` 的 UI 与模式约定；`agent-session.d.ts:166-173` |
| D7 | 阶段内技能/扩展变更以"新会话生效"为准，不追求热更新；P3 才引入 `session.reload()` | 技能清单在会话创建时固化，热更新会与历史会话的工具快照冲突 | `extensions.md` 生命周期与 reload 语义 |

**明确记录的实现约束**：D3 选择"预扫描 + 构造期注入"，不使用 `appendSystemPromptOverride` 闭包读 `loader.getSkills()`。后者虽然能让 P3 热更新自然生效，但依赖 reload 内部"skills 先于 appendSystemPrompt 解析"的顺序，属隐式契约。P3 若确需热更新，再单独评估该方案并为顺序假设补断言。

## 5. 实施阶段

### P0 资源基座（无用户可见变化）

**交付内容**

1. 新增 `src/main/resources/resource-paths.mjs`：解析并确保目录存在 —— `<userData>/pi-agent`（agentDir）、`<userData>/pi/skills`（应用技能根）、`<userData>/pi/extensions`（应用扩展根）、`<userData>/pi/packages`（包安装根）。
2. 新增 `src/main/services/resource-settings.js`：读写 `<userData>/pi-resources.json`，字段 `skillsEnabled`、`extensionsEnabled`、`skillRoots[]`、`extensionRoots[]`、`trustedPackages[]`；默认全部 `false`，与当前行为等价。
3. `createPiAgent` 增加第 9 个可选参数 `resourceOptions`，缺省时走关闭态，保持现有调用签名向后兼容。
4. `bootstrap.js`、`services/session-service.js` 的调用点透传该参数。

**风险与回滚**：仅新增文件与可选参数，回滚为移除参数传递即可。

### P1 技能接入

**交付内容**

1. `pi-agent.mjs`：`agentDir` 改为应用私有目录；`noSkills` 保持 `true`，新增 `additionalSkillPaths: skillRoots`。
2. 技能预扫描：用 SDK 导出的 `loadSkillsFromDir({ dir, source })` 在构造 loader 前扫描各技能根，合并去重（同名保留首个并记诊断，与 SDK 一致）。
3. 提示词注入：`formatSkillsForPrompt(skills, "indirect")` 生成段落，与 `TEST_AGENT_PROMPT` 一起放入 `appendSystemPrompt`；在 `AGENT_SYSTEM_PROMPT` 增补一句，指明用 `read_skill_file` 读取 `<location>`。
4. 新增 `src/main/tools/read-skill-file.mjs`：参数 `path`（绝对路径），校验落在任一已登记技能根内、`realpath` 后仍在根内（防符号链接逃逸）、文件 ≤ 32 KiB、拒绝空字节与非 UTF-8；返回与 `read_workspace_text_file` 同构的 `{ path, text }`。
5. 注册进 `createAgentTools` 与 `tools` 白名单；`read_skill_file` 加入 `AGENT_SYSTEM_PROMPT` 的工具说明。
6. 诊断透出：`loader.getSkills().diagnostics` 写主进程日志，并通过现有 IPC 暴露只读诊断列表。
7. 渲染层：输入框支持 `/skill:` 补全（数据来自诊断接口的技能名列表）。

**风险与回滚**：技能段落会占用固定上下文；限制单技能描述长度并在段首说明数量。回滚为把 `additionalSkillPaths` 置空、关闭 `skillsEnabled`。

### P2 扩展接入

**交付内容**

1. `settingsManager` 改为 `SettingsManager.create(cwd, appAgentDir, { projectTrusted: false })`，并在启动时确保设置文件包含 `defaultTools: []`。
2. 工具选择改为修饰符形式：`tools: agentTools.map((tool) => "+" + tool.name)`，使允许名单为空。
3. 新增 `additionalExtensionPaths: extensionRoots`；`noExtensions` 保持 `true`。
4. 会话创建后调用 `await session.bindExtensions({ mode: "json", onError })`，把扩展错误转为主进程日志与诊断接口。
5. 扩展管理界面：列表展示名称、来源路径、加载错误；启用/停用只改 `pi-resources.json`，不自动安装。
6. 恢复历史会话时按历史工具快照重放，新扩展工具仅在会话未记录该工具时自动激活（SDK 既有行为，需验证）。

**风险与回滚**

- 扩展与宿主同权限，可读写文件、访问 `ctx.modelRuntime`。缓解：只从应用目录加载；安装前必须展示来源并要求确认；`onError` 全量记录。
- 回滚为清空 `extensionRoots` 并把工具选择恢复为纯名称列表。

### P3 包管理

**交付内容**

1. 新增 `src/main/services/pi-package-service.js`：封装 `DefaultPackageManager`（`cwd`、`agentDir`、`settingsManager`、`builtinExtensions: []`），暴露 `install`、`remove`、`update`、`listConfiguredPackages`、`checkForAvailableUpdates`，并用 `setProgressCallback` 把进度转成 IPC 事件。
2. 来源限定：`npm:`、`git:`、本地路径三种；版本号必须固定（拒绝浮动 tag）。
3. 安装前检查：包 `package.json` 的 `pi` 字段与 `keywords` 是否含 `pi-package`；若宿主已提供包出现在 `dependencies` 中，提示按规范改为 `peerDependencies: "*"` 并拒绝安装。
4. 安装后生效：默认提示"新会话生效"；如用户选择立即生效，在 idle 时调用 `session.reload()`，失败则回退为新建会话提示。
5. 卸载与更新：卸载后其技能与扩展从下一会话移除；更新保持已固定的 ref，不自动移动。
6. 界面：包列表（来源、版本、技能数、扩展数、状态）、安装进度、错误详情、卸载确认。

**风险与回滚**

- 用户机器可能无可用 `npm`：先检测 `npmCommand`，缺失时禁用 npm 源，仅保留 git 与本地源，并给出说明。
- 安装即执行第三方代码（扩展）：界面上把"安装"与"启用扩展"拆成两步，默认只装不启用。
- 回滚为移除包服务与界面入口，已安装目录保留但不再解析。

## 6. 验收标准

类型说明：**A** = 自动测试（`node --test`，可用模拟对象，不发真实模型请求）；**O** = 离线页面/脚本检查（`electron tests/ui/*.check.cjs` 或临时脚本）；**M** = 人工验收（真实配置与会话，需用户确认）。三者不可互相替代。

### 6.1 横切

| 编号 | 类型 | 判定条件 |
| --- | --- | --- |
| AC-X-01 | A | 未配置任何技能/扩展时，`session.systemPrompt` 与改造前逐字节一致（基线快照对比），确认默认行为零变化 |
| AC-X-02 | A | 工作目录下放置 `.pi/skills/demo/SKILL.md` 与 `.pi/extensions/evil.ts`，创建会话后二者均未加载，`getSkills()` 与扩展结果均不含之 |
| AC-X-03 | A | 全链路不读取 `~/.pi/agent`：把该路径指向不存在的目录，创建会话仍成功 |

### 6.2 P0

| 编号 | 类型 | 判定条件 |
| --- | --- | --- |
| AC-P0-01 | A | 四个目录在首次启动后自动创建，重复启动不报错 |
| AC-P0-02 | A | `pi-resources.json` 缺失时按默认关闭态加载，且文件被补写 |
| AC-P0-03 | A | 不传 `resourceOptions` 的旧调用仍能创建会话（向后兼容） |

### 6.3 P1

| 编号 | 类型 | 判定条件 |
| --- | --- | --- |
| AC-P1-01 | A | 技能根下放置夹具 `qa-demo/SKILL.md`（含 `name`、`description`），`session.systemPrompt` 含 `<available_skills>` 与 `<name>qa-demo</name>` |
| AC-P1-02 | A | 移除夹具后同一断言必须失败（反向验证，防止断言空转） |
| AC-P1-03 | A | `<location>` 为技能根下的绝对路径，且该路径可用 `read_skill_file` 成功读取到 SKILL.md 全文 |
| AC-P1-04 | A | `read_skill_file` 传入技能根之外的绝对路径、`..` 逃逸、指向根外的符号链接，三种情况均返回错误且未读取文件 |
| AC-P1-05 | A | 名称非法（含大写、下划线、超 64 字符）或缺 `description` 的技能不被加载，且出现在 `getSkills().diagnostics` |
| AC-P1-06 | A | 同名技能在两个根下重复时只保留首个，并产生一条冲突诊断 |
| AC-P1-07 | A | 前端输入 `/skill:qa-demo 请按技能执行` 后，实际送入模型的文本包含 SKILL.md 全文（订阅 `message_start` 取用户消息断言） |
| AC-P1-08 | O | 输入框键入 `/skill:` 时补全列表出现 `qa-demo`；键盘上下选择与回车填入不破坏输入法组词 |
| AC-P1-09 | M | 真实模型下提问"按 qa-demo 技能处理这份文件"，回复体现出已读 SKILL.md 的步骤 |

### 6.4 P2

| 编号 | 类型 | 判定条件 |
| --- | --- | --- |
| AC-P2-01 | A | 应用扩展根下放置注册 `demo_tool` 的扩展，`session.getAllTools()` 含 `demo_tool`，且 `session.getActiveToolNames()` 含之 |
| AC-P2-02 | A | 同一扩展在旧实现（纯名称白名单）下 `demo_tool` 被过滤——先用旧参数复现，再验证新参数修复 |
| AC-P2-03 | A | 扩展工厂抛错时，会话仍可创建，错误经 `onError` 进入诊断列表，界面可见 |
| AC-P2-04 | A | 扩展注册的 `session_start` 钩子被触发一次（用计数夹具断言），确认 `bindExtensions()` 生效 |
| AC-P2-05 | A | 恢复一个"历史中无 `demo_tool`"的旧会话，`demo_tool` 自动激活；恢复"历史中显式移除过该工具"的会话则保持移除 |
| AC-P2-06 | O | 扩展管理页正确展示名称、路径、状态与错误详情；停用后新建会话不再加载该扩展 |
| AC-P2-07 | M | 真实安装一个社区扩展后，模型能按其描述调用其工具，工具调用在界面正常展示开始/结束 |

### 6.5 P3

| 编号 | 类型 | 判定条件 |
| --- | --- | --- |
| AC-P3-01 | A | 用本地路径包装入，`listConfiguredPackages()` 出现该包，其技能出现在 `getSkills()`、扩展出现在扩展结果中 |
| AC-P3-02 | A | 包 `dependencies` 误写宿主提供包时，安装被拒绝并给出改为 `peerDependencies` 的提示 |
| AC-P3-03 | A | 卸载后新会话不再含该包的技能与扩展，历史会话仍可正常打开 |
| AC-P3-04 | A | git 源固定 ref 后执行 `update`，ref 不发生移动 |
| AC-P3-05 | O | 安装过程有进度反馈（开始/进行/完成/失败），失败信息可在界面查看，重复点击不会并发安装 |
| AC-P3-06 | M | 真实安装一个 npm 包并新开会话，模型可识别并使用其技能；卸载后确认能力消失 |

## 7. 验证方法

```bash
# 单元测试（仅本次涉及，逐文件执行）
node --test tests/unit/skill-prompt.test.js
node --test tests/unit/read-skill-file.test.js
node --test tests/unit/extension-loading.test.js
node --test tests/unit/pi-package-service.test.js

# 离线页面检查
node_modules/.bin/electron tests/ui/skill-autocomplete.check.cjs
node_modules/.bin/electron tests/ui/extension-manager.check.cjs
```

约定：会话相关测试使用模拟工厂与 `tests/fixtures/` 下的临时目录；不读取用户真实 `.env`、配置、会话；不调用付费模型。真实模型验收（M 类）由使用者执行，结果单独记录，不得据自动测试结果宣称已完成。

## 8. 风险登记

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 扩展与宿主同权限 | 可读写文件、触达模型调用 | 只从应用目录加载；安装与启用分离；错误全量上报 |
| 技能段落长期占用上下文 | 技能多时挤占对话预算 | 限制描述长度、单根技能数；诊断中显示估算占用 |
| `formatSkillsForPrompt` 只接受固定工具名 | 提示词里无法点名 `read_skill_file` | 用 `indirect` + 在系统提示词中补一句工具映射 |
| 打包后 ASAR 内动态解析模块失败 | 扩展加载报错 | 资源与包目录固定在 `userData` 外置路径 |
| 用户机器缺 npm | 包安装不可用 | 启动检测 `npmCommand`，缺失时禁用 npm 源 |
| SDK 升级改变内部行为 | 提示词段落或白名单语义变化 | 每阶段保留第 6 节断言，升级时先跑 P1/P2 全部 A 类用例 |

## 9. 里程碑与交付物

| 阶段 | 交付物 | 出口条件 |
| --- | --- | --- |
| P0 | 资源路径与设置服务、兼容参数 | AC-P0-01~03 全绿 |
| P1 | 技能加载、提示词注入、`read_skill_file`、补全 UI | AC-P1-01~08 全绿，AC-P1-09 待人工 |
| P2 | 扩展加载、`bindExtensions`、扩展管理页 | AC-P2-01~06 全绿，AC-P2-07 待人工 |
| P3 | 包服务与包管理页 | AC-P3-01~05 全绿，AC-P3-06 待人工 |

每阶段独立提交，附对应 `docs/` 功能说明与本阶段验证记录。

## 10. 附录：本项目将用到的 SDK 接口

```js
import {
  DefaultResourceLoader,      // 资源加载（P1/P2）
  SettingsManager,            // inMemory / create(cwd, agentDir, { projectTrusted })
  loadSkillsFromDir,          // 预扫描技能根（P1）
  formatSkillsForPrompt,      // 生成技能段落（P1）
  DefaultPackageManager,      // 包安装与解析（P3）
  defineTool,                 // read_skill_file（P1）
} from "@mariozechner/pi-coding-agent";

// 会话级
session.resourceLoader.getSkills();     // 技能清单与诊断
session.getAllTools();                 // 校验扩展工具是否注册
session.getActiveToolNames();          // 校验是否激活
await session.bindExtensions({ mode: "json", onError });  // P2
await session.reload();                // P3 热更新（idle 时）
```

以 `dist/*.d.ts` 为准，不以文档示例的形参顺序推断签名；调用任一新增接口前先读取对应 `.d.ts`。

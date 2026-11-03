// 中文名仅用于显示；技能标识、文件和调用命令仍使用 Pi 原值。
const skillNames = {
  "qa-requirement-review": "需求评审",
  "qa-case-design": "测试用例设计",
  "qa-skill-smoke": "技能调用验证",
  "qa-api-test": "接口测试",
  "qa-ui-test": "界面测试",
  "playwright-browser": "浏览器自动化",
  "playwright-cli": "浏览器命令行测试",
  "playwright-trace": "浏览器测试追踪分析",
  "playwright-component-testing": "界面组件测试",
  "api-engineer": "接口工程助手",
  "ai-readiness": "接口智能体适用性评估",
  "api-discovery": "接口发现与集成",
  "api-documentation": "接口文档生成",
  "api-mocking": "接口模拟服务",
  "api-monitoring": "接口监控",
  "api-simulation": "接口依赖模拟",
  "api-testing": "接口测试执行",
  bootstrap: "Postman 初始化与认证",
  "ci-integration": "持续集成",
  "collection-schema-v3": "接口集合格式规范",
  datasets: "测试数据集与查询",
  flows: "接口流程编排",
  "performance-testing": "接口性能测试",
  "postman-mcp-server": "Postman 工具使用指南",
  variables: "变量与密钥管理",
  "mcp-scripting": "MCP 工具脚本编写",
  "council-mode": "多顾问决策讨论",
  "pi-subagents": "子智能体协作",
  "darwin-skill": "达尔文技能优化",
  "dingtalk-aicard": "钉钉智能卡片",
  "dingtalk-aisearch": "钉钉智能搜问",
  "dingtalk-aitable": "钉钉多维表格",
  "dingtalk-calendar": "钉钉日历与会议室",
  "dingtalk-chat": "钉钉群聊与消息",
  "dingtalk-contact": "钉钉通讯录",
  "dingtalk-doc": "钉钉在线文档",
  "dingtalk-drive": "钉钉文件与钉盘",
  "dingtalk-event": "钉钉事件监听",
  "dingtalk-mail": "钉钉邮箱",
  "dingtalk-minutes": "钉钉智能听记",
  "dingtalk-misc": "钉钉综合业务",
  "dingtalk-shared": "钉钉操作入口",
  "dingtalk-tag": "钉钉数字员工",
  "dingtalk-todo": "钉钉待办",
  "dingtalk-wiki": "钉钉知识库",
  "comprehensive-topology-analysis": "全面拓扑分析",
  "database-inspector": "数据库巡检",
  docx: "Word 文档处理",
  "dws-cli": "钉钉命令行",
  history: "历史查询",
  notes: "会话笔记",
  "oa-operations": "办公审批操作",
  pdf: "PDF 文档处理",
  "water-safe-knowledge-base": "供水安全知识库",
  "water-safe-operate": "供水安全调度",
  "water-ui": "动态界面",
  "waterwork-knowledge-base": "水厂知识库",
  "waterwork-operate": "水厂运营",
  "web-search": "网页搜索",
  xlsx: "电子表格处理",
};

export function getPiSkillName(name) {
  return Object.hasOwn(skillNames, name) ? skillNames[name] : name;
}

// 描述按原文精确匹配，避免同名资源误用译文；不改写 Pi 资源或命令。
const descriptions = new Map([
  ["Automate browser interactions, test web pages and work with Playwright tests.", "自动操作浏览器、测试网页，并使用 Playwright 测试。"],
  ["Inspect Playwright trace files from the command line — list actions, view requests, console, errors, snapshots and screenshots.", "通过命令行分析 Playwright 测试追踪文件，查看操作列表、网络请求、控制台、错误、页面快照和截图。"],
  ["Set up component testing with Playwright using a story gallery — scaffold stories and a gallery dev page driven by the built-in mount fixture, no dedicated component-testing runtime. Use when asked to test React or Vue components in isolation with Playwright, or to migrate off @playwright/experimental-ct-react / -vue.", "使用 Playwright 和组件示例画廊搭建组件测试：生成组件示例和开发预览页面，通过内置挂载夹具运行，无需独立的组件测试运行环境。适用于单独测试 React 或 Vue 组件，或从 @playwright/experimental-ct-react、@playwright/experimental-ct-vue 迁移。"],
  ["Scores a Postman collection or an OpenAPI spec for how well an AI agent can discover, understand, call, and recover from errors with it — missing examples, undocumented errors, and ambiguous parameters all cost points. Use when the user asks \"is my API agent-ready,\" \"can AI agents use my API,\" \"how agent-friendly is my API,\" or wants to scan, score, or improve a collection or spec for AI/agent consumption. Covers `postman collection ai-readiness` and `postman spec ai-readiness`.", "评估 Postman 集合或 OpenAPI 规范是否便于 AI 智能体发现、理解和调用接口，以及从错误中恢复。缺少示例、未说明的错误和含糊的参数都会扣分。适用于检查接口是否适合智能体使用，或扫描、评分和改进集合与规范。涵盖 postman collection ai-readiness 和 postman spec ai-readiness 命令。"],
  ["Discover and use APIs from the web or Postman. Find and integrate public third-party APIs with Orbit, locate Postman entities with search, and use the Context Graph to investigate dependencies, ownership, runtime behavior, and change impact across an API ecosystem.", "从网络或 Postman 中发现并使用接口。通过 Orbit 查找和集成公开的第三方接口，搜索 Postman 资源，并使用上下文关系图分析接口生态中的依赖、负责人、运行行为和变更影响。"],
  ["Generate filesystem-first agent friendly api documentation that you can share with your teammates without hassle. Use when the user asks to \"publish API docs,\" \"generate documentation for this API,\" \"put this on the API Network,\" \"share a docs link for this collection or spec,\" or \"why do my docs look empty.\"", "生成以本地文件为基础、便于智能体理解并与团队分享的接口文档。适用于发布接口文档、为接口生成说明、发布到 API Network、分享集合或规范的文档链接，以及排查文档内容为空的问题。"],
  ["Makes coding agents faster and more accurate with fewer tokens when designing, implementing, mocking, testing, monitoring, documenting, or deploying an API.", "帮助编程智能体在设计、实现、模拟、测试、监控、编写文档或部署接口时，以更少的词元完成更快、更准确的工作。"],
  ["Stands up a fake backend that behaves like a real API — from a collection or an OpenAPI spec, running locally or pushed to a workspace and deployed at a durable URL — plus request-time scenario and status-code overrides for testing failure paths. Use when the user asks to \"mock this API,\" \"create a mock server,\" \"fake the backend,\" \"run tests without hitting the real API,\" or \"simulate an error/out-of-stock response.\" Covers `postman mock`. Depends on bootstrap for the workspace id only once a mock is pushed to the workspace (`-w`, or the workspace linked in `.postman/resources.yaml`) — generating and running a mock locally needs nothing from bootstrap.", "根据集合或 OpenAPI 规范搭建行为接近真实接口的模拟后端，可在本地运行，也可推送到工作空间并部署为固定地址。支持在请求时覆盖场景和状态码，用于测试失败路径。适用于模拟接口、创建模拟服务器、替代后端、不调用真实接口进行测试，或模拟错误及缺货响应。涵盖 postman mock。仅在推送到工作空间时，需要先通过 bootstrap 获取工作空间编号；单纯在本地生成和运行模拟服务无需此步骤。"],
  ["Creates, schedules, and manages Postman Monitors — recurring checks against a live API — triggers ad hoc runs, inspects job/run history to diagnose failures, and hosts self-hosted execution runners for monitors on a private network. Use when the user asks to \"set up a monitor,\" \"run this monitor now,\" \"check monitor results,\" \"pause/resume a monitor,\" or \"set up a runner for our internal APIs.\" Covers `postman monitor` (create, update, delete, list, get, pause, resume, run, jobs, runs) and `postman runner` (start, list, regions).", "创建、安排和管理 Postman 监控任务，定期检查真实接口；支持立即执行、查看任务与运行历史以诊断失败，以及为私有网络中的监控部署自托管执行器。适用于配置监控、立即运行、检查结果、暂停或恢复监控，以及为内部接口设置执行器。涵盖 postman monitor 的创建、更新、删除、列表、详情、暂停、恢复、运行与历史命令，以及 postman runner 的启动、列表和区域查询。"],
  ["The local development loop for a service that calls other APIs — find its dependencies in the code and the Context Graph, give each one a mock (the owning team's, or one generated from its contract), serve them together from one `.sim.yaml` on one port, run the real service against it, read the simulation's log to see what each dependency served, and ship it with the simulation in the PR. Can also inject latency, error, rate-limit or chaos per dependency. Use when the user is building or changing an endpoint that calls other services, or asks to \"simulate my dependencies,\" \"mock everything this service calls,\" or \"run this end to end locally.\" Covers `postman simulation`. Builds on api-discovery for finding dependencies and their owners' mocks, and on api-mocking for the rest.", "为调用其他接口的服务建立本地开发闭环：从代码和上下文关系图中查找依赖，为每个依赖选择所属团队的模拟服务或按契约生成模拟服务，再用一个 .sim.yaml 文件和一个端口统一运行。让真实服务连接模拟环境，读取日志检查各依赖的响应，并将模拟配置随合并请求一起提交。可按依赖注入延迟、错误、限流或混沌。适用于开发或修改依赖其他服务的接口、模拟全部依赖或本地端到端运行。涵盖 postman simulation；依赖发现由 api-discovery 提供，模拟服务由 api-mocking 提供。"],
  ["Runs tests against an API from the command line — a single ad-hoc request, a full collection of pm.test assertions, or matching real captured app traffic against a collection contract. Use when the user asks to \"test this endpoint,\" \"run this collection,\" \"check the API still works,\" or \"verify my app's requests match the contract.\" Covers `postman request`, `postman collection run`, and `postman application test`. Depends on bootstrap when the target is a cloud collection or workspace-bound environment; a bare URL or local collection needs nothing from bootstrap.", "从命令行测试接口：发送单次临时请求、运行带有 pm.test 断言的完整集合，或将应用捕获的真实请求与集合契约进行比对。适用于测试接口、运行集合、检查接口是否仍然正常，以及验证应用请求是否符合契约。涵盖 postman request、postman collection run 和 postman application test。云端集合或绑定工作空间的环境需要 bootstrap；直接使用地址或本地集合无需此步骤。"],
  ["Resolves the Postman CLI, authenticates when the task needs it, and manages the filesystem/workspace binding for a repository. Use when the user asks to set up Postman, enable filesystem workflows, authenticate, initialize, import, connect, pull, push, sync, or share a workspace — and before skills that need a linked workspace, only when the CLI, linked workspace, or spec path has not already been confirmed.", "定位 Postman 命令行工具，在任务需要时完成认证，并管理仓库的本地文件与工作空间绑定。适用于设置 Postman、启用本地文件工作流、认证、初始化、导入、连接、拉取、推送、同步或共享工作空间。在其他技能需要已绑定工作空间，且尚未确认命令行工具、工作空间或规范路径时，先使用此技能。"],
  ["Common CI integrations that can added as independent pass/fail gates. Use when the user asks to \"add Postman to CI,\" \"run this collection on every PR,\" \"fail the build on a governance violation,\" or \"push to the postman cloud workspace after merge to main\", \"add some api related operation in my Github actions\".", "将常见的持续集成操作加入流水线，作为独立的通过或失败检查。适用于把 Postman 加入持续集成、每次合并请求都运行集合、违反治理规则时阻止构建、合并到主分支后推送到 Postman 云端工作空间，或在 GitHub Actions 中加入接口相关操作。"],
  ["The reference for the git-native v3 collection file format — one YAML file per request/folder/example under postman/collections/, plus postman/environments/. Read before writing, editing, or generating any file in either directory by hand, or before debugging a `collection lint` failure. Covers the HTTP request/example/definition schema, environment schema, and the YAML/naming rules that make files parse — GraphQL, gRPC, WebSocket, Socket.IO, MQTT, MCP, and LLM request schemas are non-HTTP protocols and live in reference/other_protocols.md, read only when a collection actually uses one.", "以 Git 管理的第三版集合文件格式参考：在 postman/collections/ 下为每个请求、文件夹和示例分别建立 YAML 文件，环境文件放在 postman/environments/。手动编写、编辑或生成这两个目录中的文件，或排查 collection lint 失败前，应先阅读。涵盖 HTTP 请求、示例、定义和环境的结构，以及文件可正常解析所需的 YAML 与命名规则。GraphQL、gRPC、WebSocket、Socket.IO、MQTT、MCP 和大模型等非 HTTP 协议结构见 reference/other_protocols.md，仅在集合实际使用时阅读。"],
  ["Query CSV and JSON files, spreadsheet exports, and live databases (MySQL, PostgreSQL, SQL Server, or anything with a JDBC driver JAR) as one SQL surface; join across them; save a query as a named view so it can be rerun without re-pasting the SQL; then drive a collection run one iteration per row — feeding it the rows a query returns instead of a hardcoded data file — or read rows from scripts via `pm.datasets()`. Use when the user wants to run or loop a collection over rows of test data, parameterize a run from a CSV or spreadsheet or database table, query or join data across files and tables, save or rerun a query without pasting it again, use a query's result rows as the input for a run in place of hardcoded JSON or a data file, point Postman at a JDBC driver, work out where database credentials get stored, or names a Postman dataset or view. Covers `postman dataset` (`source`, `view`, `query`, `jdbc`) and `--iteration-data-dataset`/`--iteration-data-view`/`--dataset` on `collection run`.", "使用统一的 SQL 查询 CSV、JSON、电子表格导出文件及实时数据库，包括 MySQL、PostgreSQL、SQL Server 和可提供 JDBC 驱动的数据库；支持跨来源关联查询，并将查询保存为命名视图以便复用。可将查询结果逐行用于集合迭代，或通过 pm.datasets() 在脚本中读取。适用于按测试数据逐行运行集合、从文件或数据库参数化执行、跨文件和表关联查询、保存或重跑查询、替换固定数据文件、设置 JDBC 驱动，以及了解数据库凭据存储位置。涵盖 postman dataset 的 source、view、query、jdbc 命令，以及 collection run 的 --iteration-data-dataset、--iteration-data-view 和 --dataset 参数。"],
  ["Runs, deploys, and debugs Postman Flows from the command line — executing a flow file locally, triggering a deployed flow over its webhook, deploying one so it becomes callable, and tracing a failed run to the block that broke. Use when the user names a flow and an action (\"run the Checkout flow\", \"deploy this flow\", \"why did that flow run fail\", \"what flows do I have\"). Covers `postman flows list`, `run`, `trigger`, `deploy`, `update`, `list-runs`, and `get-run`.", "通过命令行运行、部署和调试 Postman 流程：在本地执行流程文件、通过网络回调触发已部署流程、部署可调用的流程，并将失败定位到出错的模块。适用于运行或部署指定流程、排查流程失败和查看已有流程。涵盖 postman flows 的 list、run、trigger、deploy、update、list-runs 和 get-run 命令。"],
  ["Load-tests a collection with concurrent virtual users, a chosen load profile, and pass/fail thresholds on latency or error rate — run locally or on Postman's cloud runners. Use when the user asks to \"load test this API,\" \"run a performance test,\" \"check how this holds up under load,\" or \"benchmark this collection.\" Covers `postman performance run`. This generates real traffic against a real target — confirm the target and scale before running, the same way any action with effects outside this session gets confirmed.", "使用并发虚拟用户、指定负载模式以及延迟或错误率阈值，对集合进行负载测试；可在本地或 Postman 云端执行器上运行。适用于接口压测、性能测试、负载承受能力检查和集合基准测试。涵盖 postman performance run。此操作会向真实目标发送真实流量，执行前需要确认目标和规模。"],
  ["Postman concepts and MCP tool guidance. Loaded when working with Postman MCP tools to make better decisions about tool selection and workarounds.", "介绍 Postman 概念和 MCP 工具用法。在使用 Postman MCP 工具时加载，帮助选择合适的工具和替代处理方式。"],
  ["How to parameterize a collection with variables and where each value belongs — a plain value goes in an environment or collection variable, a secret (token, password, API key) goes in the team's shared vault via `postman secret create` so its value never passes through the coding harness or lands in a committed file. Covers the variable scopes and their resolution order, reading and writing variables at runtime from pre-request and post-response scripts (`pm.environment`, `pm.collectionVariables`, `pm.variables`), and composing variables out of other variables. Use when the user asks where to put a base URL, token, or password, how to reference a secret without exposing it, how `{{variables}}` resolve, or how to set a value in a script. Covers `postman secret`.", "说明如何用变量参数化集合，以及各类值应存放的位置。普通值放在环境或集合变量中；令牌、密码和接口密钥通过 postman secret create 存入团队共享密钥库，避免明文经过编程工具或进入已提交文件。涵盖变量作用域和解析顺序、请求前与响应后脚本中的变量读写（pm.environment、pm.collectionVariables、pm.variables），以及变量组合。适用于确定基础地址或凭据的存放位置、安全引用密钥、理解 {{variables}} 的解析和在脚本中设置变量。涵盖 postman secret。"],
  ["Read before writing mcpScript code. Covers tool discovery, the shape of call results (including JSON returned as text), and script limits.", "编写 mcpScript 代码前阅读。介绍工具发现、调用结果的结构（包括以文本返回的 JSON）以及脚本限制。"],
  ["Browser automation with Playwright CLI. Use when testing web apps, navigating websites, filling forms, taking screenshots, checking console/network issues, saving auth state, or performing repeatable browser workflows from pi.", "通过 Playwright 命令行工具自动操作浏览器。适用于测试网页应用、浏览网站、填写表单、截图、排查控制台与网络问题、保存登录状态，以及从 Pi 执行可重复的浏览器工作流。"],
  ["Run a bounded supervisor-mediated advisor council. Use when the user asks for council mode, asks to convene advisors, debate a decision, cross-examine recommendations, or run /council.", "在协调者管理下开展有明确边界的顾问讨论。适用于顾问讨论模式、召集顾问、辩论决策、交叉核查建议，或运行 /council 命令。"],
  ["Technical guidance for operator-requested delegation to builtin or custom subagents: bounded handoffs, parallel review, scripted workflows, async work, forked context, isolation, and coordinated execution.", "为用户主动要求的子智能体委派提供技术指导：限定任务交接、并行审查、脚本化工作流、异步工作、分叉上下文、隔离和协同执行。"],
  ["Create, edit, and validate DingTalk AI Card (A2UI) JSON files offline. Use for cards built from requirements or images, structural protocol errors, and named component or function contract lookup through native DWS commands. Send a card to the current user only when a preview is requested.", "离线创建、编辑和校验钉钉 AI 卡片（A2UI）的 JSON 文件。适用于根据需求或图片制作卡片、排查协议结构错误，以及通过原生 DWS 命令查询指定组件或函数的契约。仅在用户要求预览时，才向当前用户发送卡片。"],
  ["Darwin Skill 2.0 (达尔文.skill 2.0): autonomous skill optimizer, v2.0 integrates Microsoft Research SkillLens (arXiv 2605.23899) 9-dim rubric + SkillOpt (arXiv 2605.23904) validation-gated design + human-in-the-loop checkpoints. Evaluates SKILL.md files using a 9-dimension rubric (structure + effectiveness + meta-skill blacklists), runs hill-climbing with git version control, spawns independent judge agents for blind evaluation, validates improvements through test prompts with auto-break on diminishing returns, and generates visual result cards. Use when user mentions \"优化skill\", \"skill评分\", \"自动优化\", \"auto optimize\", \"skill质量检查\", \"达尔文\", \"darwin\", \"帮我改改skill\", \"skill怎么样\", \"提升skill质量\", \"skill review\", \"skill打分\".", "达尔文技能 2.0：自动优化技能，结合微软研究院 SkillLens（论文编号 2605.23899）的九维评分标准、SkillOpt（论文编号 2605.23904）的验证驱动设计，以及人工参与的检查点。按结构、有效性和元技能黑名单等维度评估 SKILL.md，通过 Git 管理迭代优化，使用独立评审智能体进行盲评，并用测试提示词验证改进；收益递减时自动停止，生成可视化结果卡片。适用于技能优化、评分、质量检查、评审及达尔文相关请求。"],
  ["Run a bounded supervisor-mediated council of advisors and write a decision memo", "在协调者管理下开展有明确边界的顾问讨论，并编写决策备忘录。"],
  ["Use subagents to gather context, then ask clarifying questions", "使用子智能体收集背景信息，再提出澄清问题。"],
  ["Parallel cleanup review", "并行审查代码清理工作。"],
  ["Parallel subagents research", "使用多个子智能体并行调研。"],
  ["Parallel subagents review", "使用多个子智能体并行审查。"],
  ["Review/fix loop until clean", "反复审查和修复，直到没有待处理问题。"],
]);

export function translatePiDescription(description) {
  const original = description || "暂无描述";
  return descriptions.get(original.replace(/\s+/g, " ").trim()) ?? original.replace(/\bUse when\b/g, "适用于");
}

const extensionLabels = {
  "builtin:codemode": { name: "代码执行", description: "通过代码组合和执行工具调用，处理需要多个步骤的任务。" },
  "builtin:tool-search": { name: "工具搜索", description: "按需查找可用工具，让智能体使用当前任务所需的能力。" },
  "builtin:mcp": { name: "MCP 服务连接", description: "连接 MCP 服务，将服务提供的工具接入当前会话。" },
  "pi-subagents": { name: "子智能体协作", description: "将任务委派给子智能体，支持单项委派和脚本化的多智能体工作流。" },
  "pi-mcp-adapter": { name: "MCP 适配器", description: "为 Pi 接入 MCP 服务及其工具。" },
  "chrome-profile-bridge": { name: "Chrome 浏览器连接", description: "经你明确授权后，让 Pi 使用已登录的 Chrome 浏览器配置。" },
  "@postman/postman-plugin": { name: "Postman 接口工程", description: "为编程智能体提供接口设计、测试、模拟、监控和文档等工程技能。" },
};

export function getPiExtensionLabel(item) {
  const key = item.path.startsWith("builtin:") ? item.path : item.name;
  return Object.hasOwn(extensionLabels, key) ? extensionLabels[key] : { name: item.name };
}

// 只替换已知诊断句式；扩展返回的任意错误保留原文，避免丢失排错信息。
export function translatePiDiagnostic(message) {
  const messages = {
    "description is required": "缺少技能描述。",
    "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)": "技能名称只能包含小写英文字母、数字和连字符。",
    "name must not start or end with a hyphen": "技能名称不能以连字符开头或结尾。",
    "name must not contain consecutive hyphens": "技能名称不能包含连续的连字符。",
    "skill path does not exist": "技能路径不存在。",
    "skill path is not a markdown file": "技能路径指向的文件不是 Markdown 文件。",
    "prompt template path does not exist": "提示词模板路径不存在。",
    "theme path does not exist": "主题路径不存在。",
    "theme path is not a json file": "主题路径指向的文件不是 JSON 文件。",
    "failed to read prompt template file": "无法读取提示词模板文件。",
    "failed to parse prompt template file": "无法解析提示词模板文件。",
  };
  if (Object.hasOwn(messages, message.toLowerCase())) return messages[message.toLowerCase()];
  return message
    .replace(/^name "(.*)" collision$/, "名称“$1”重复，已采用优先加载的资源。")
    .replace(/^(name|description) exceeds (\d+) characters \((\d+)\)$/, (_, field, limit, length) => `${field === "name" ? "技能名称" : "技能描述"}超过 ${limit} 个字符，当前为 ${length} 个字符。`);
}

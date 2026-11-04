# DeepSeek Harness 对话界面复用评估

评估日期：2026-11-04。对象为本机安装的 DeepSeek Harness `0.2.1-rc.5`：代码位于 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的 `dsh/`，已解包到临时目录只读分析；同时核对公共仓库 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（MIT，默认分支 `master`）。

范围限定为四项界面能力：对话输出、思考过程、工具调用、任务栏。只读源码与 README，未运行 DSH 界面，未做像素级还原对比，也未改动本项目源码。

## 结论

1. **组件代码不能直接复用。** 四项能力全部建立在 React 18 + Cordis 插件 + slot 组合 + CSS Modules/设计 token 之上，依赖 `@deepseek-ai/dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-client-store` 三个**未随安装包分发**（仅存在于打包后的前端产物中）的运行时包。本项目渲染层是原生 DOM/ESM、无打包器、直接以相对路径导入 `node_modules`，两者没有可对接的边界。
2. **展示规则与纯数据模型可以移植。** 思考行摘要算法、工具卡片分类与派生模型、todo 面板状态语言都是几十到几百行、无框架耦合的逻辑，用原生 DOM 重写成本远低于引入整套 React 栈。
3. **不建议照抄的是"大件"**：轮次轨道虚拟化、分页锚点补偿、折叠批处理与滚动跟随子系统；它们占 `ui-chat` 绝大部分体积，收益集中在极端场景。

## 一、四项能力的实现方式

### 1. 对话输出

- **节点模型**：`dsh-client-ui-conversation` 的 assembler 把会话事件流组装成 Turn/Step/Node 图；`ui-chat` 只消费与 target 无关的节点，`AssistantNodeView` 的 `data.blocks` 按 `text / reasoning / tool-call / image / unknown` 分派。`groupPart` 只在同一次渲染里选择"推理"或"回复"，不复制载荷。
- **流式**：客户端有仅存于浏览器的瞬态事件 `assistant/live-chunk`，推理与工具 delta 按帧合批发布，持久调用和结果立即发布；终值以消息结束快照替换增量，而不是继续追加。
- **Markdown 与代码块**：正文由 primitives 的 `MarkdownText` 渲染（源码不在安装包内）；代码高亮使用 shiki 并按语言懒加载（`dsh-web-frontend/dist/assets/langs/*.js`）；代码块有 sticky 头栏，宽表格可越出阅读列。
- **列表与滚动**：transcript 按 Session 窗口分页加载，**不做整表虚拟化**；被虚拟化的是右侧轮次轨道刻度（`@tanstack/react-virtual`）。滚动跟随、阅读线定位、分页锚点补偿、收起动画批处理合起来是 `ui-chat` 中篇幅最大的部分。
- **消息操作**：复制、反馈（`ui-message-feedback`）、每轮 token 用量行、完成轮页脚、输入框下方的轮次/步骤/输出速度/缓存命中统计。

### 2. 思考过程

`ReasoningRow`（`dsh-client-ui-chat`，约 80 行）：

- 折叠态＝图标 +"思考"+ 分隔点 + 单行摘要，摘要按 `TextShimmer` 扫光；运行中取**最近完成段落的第一行**，结束后取首行，并去掉 `**` 标记。
- 展开态通过 `conversation.chat.reasoning.body` slot 渲染完整 Markdown，使用次级字号。
- `reasoningText()` 剥离 `<signature>…</signature>` 签名块，只剩签名时返回空文本并整行隐藏——与本项目"不传递签名"的约束一致。
- 每轮独立的 `useDisclosure`，轮次收起时重置，不变更组件 key；`settledReasoningPreview` 策略决定结束后是否保留预览。

### 3. 工具调用

- `ToolCallTree` 渲染根调用与 PTC 子调用；每个原子调用经 keyed slot `tool.call.toolview` 按 wire 工具名分发，未注册的走 generic 卡片。
- `ToolRow` 是统一行壳：图标、标题、摘要、运行扫光、耗时、退出码徽标、差异 `+N/-N`、文件路径链接、Inspect。展开体由卡片决定：`TerminalBlock`、`DiffBlock`、`ReadBlock`、`SearchBlock`、`WebBlock`、图片、提问卡片、Details。
- **卡片模型是纯函数**（`diffCardModel`、`readCardModel`、`terminalCardModel` 等，单个 100–300 行），从调用参数与结果元数据派生并校验，不合格就回退 generic。它们是这批代码里最容易移植的部分。
- 生命周期固定三阶段：preparing（参数流式）/ start（开始执行）/ result（结果），同一 `callId` 贯穿。

### 4. 任务栏

- **主任务栏**是 `TodoDock`（`dsh-client-ui-conversation`，约 150 行）：注册在 `conversation.input.dock`（order 0，位于 composer 上方），读取 `todos` 投影；默认折叠，标题"任务"+ 进度（`2 已完成 · 1 进行中 · 3 待处理`），行内用共享状态点表示 idle/ongoing/done。
- 数据来源是 `todo_write` 工具：每次整表替换并写入 `todo/write` 会话事件，客户端投影取最新一份，首次写入前为 `null`，下一轮开始时清空。
- 另有 `JobListAction`（`dsh-client-ui-jobs`，646 行）在会话头部展示**后台任务**：运行/停止中/完成/失败状态、可展开的流式输出面板、二次确认后 kill。它和任务栏是两套东西，容易混淆。

## 二、结构差异

| 维度 | DSH | 本项目 |
| --- | --- | --- |
| 渲染框架 | React 18 + hooks + `use-sync-external-store` 外置 store | 原生 DOM，手动创建与更新节点 |
| 组合方式 | Cordis 插件 + `ctx.slots.register/inject`，keyed/chain slot 运行时注入 | 直接函数调用与事件监听 |
| 样式 | CSS Modules 编译为哈希类名，运行时按插件注入 `<style>`，全套 `--dsw-alias-*` token | 手写 `styles/*.css`，`--` 变量自建 |
| 数据来源 | 会话事件流 → 客户端投影（`session/projection`、`todos`、`jobs`） | Pi SDK 事件（`message_update`/`tool_execution_*`）经 IPC 直达渲染层 |
| 组件库 | `ui-primitives`、`ui-slots`、`client-store` 未单独发布，只存在于打包产物 | 无组件库，`marked` + `dompurify` + `highlight.js` |
| 构建 | tsdown/rolldown 产出 `lib/client.js`，由 `window.__ModuleLoader__` 注册 | 无打包，浏览器直接加载 ESM |

体积参考（安装包内的 `lib/client.js`）：`ui-chat` 13,374 行/581 KB、`ui-conversation` 20,276 行/764 KB（含 Lexical 输入编辑器）、`ui-tool` 4,636 行/193 KB、`ui-jobs` 646 行/31 KB。本项目对应实现：`output-trace.js` 385 行、`message-view.js` 118 行、`markdown-renderer.js` 61 行、`message-scroll.js` 44 行。

## 三、复用判断

| 功能 | 直接复用组件 | 可移植的规则/模型 | 结论 |
| --- | --- | --- | --- |
| 对话输出 | 否：需要 React、primitives、slots、store 四层 | 块模型与终值替换、sticky 代码头栏、消息操作行、每轮用量页脚 | 按原生重写呈现层，不搬架构 |
| 思考过程 | 否：`ReasoningRow` 依赖 DisclosureRow/TextShimmer/MarkdownText | 签名剥离、首行/最近段落摘要、折叠时机 | 最划算，小改即可接近 |
| 工具调用 | 否：卡片依赖 primitives 的 Terminal/Diff/Read/Search Block | 卡片分类、纯模型校验、退出码与差异统计、三阶段状态 | 收益最大，分阶段重写 |
| 任务栏 | 否，但面板本身仅 150 行 | 整个面板结构、状态语言、进度文案 | 前置条件是先有 `todo_write` 工具 |

许可证不是障碍：相关包均为 MIT。真正的障碍是运行时依赖与源码形态——公开发布的是插件级包，primitives/slots/store 只以打包产物存在，照抄需要逆向压缩代码或引入整套栈。

## 四、落地建议（按性价比排序）

1. **思考行升级**（约 0.5–1 天）：把 `output-trace.js` 里的 `<pre>` 换成"折叠摘要 + Markdown 正文"，补运行扫光与结束保留策略。现有 `thinking` 块与计时已经齐备。
2. **对话输出打磨**（约 1–2 天）：代码块头栏与复制按钮、每轮 token 用量页脚、流式光标、消息操作行。无需改动事件链路。
3. **工具卡片**（约 3–5 天）：先做 bash/read/edit/write 四类，从参数与结果派生卡片模型，保留现有"未知工具走通用卡片"的回退。需要按 Pi 的工具参数与结果格式重写模型，不能直接套用 DSH 的 `read`/`edit` 形状。
4. **任务栏**（约 2–3 天）：新增 `todo_write` 自定义工具（当前 `pi-agent.mjs` 明确不传 `tools`/`customTools`，需重新决策）、客户端从历史重放最新整表、composer 上方面板。

不建议做的事：引入 React/Cordis 改写渲染层；把 DSH 的会话事件模型搬进来；照搬轮次轨道与分页锚点子系统。若确实想要 DSH 的完整界面，可行路径是在应用内嵌 DSH Web 前端（另一套宿主），而不是"复用"到现有渲染层。

## 五、验证边界

以上为只读代码与文档分析：未运行 DSH 界面、未比对真实渲染效果、未验证本项目按建议改造后的表现。工作量是按现有代码结构估算，不含测试与真机验收。

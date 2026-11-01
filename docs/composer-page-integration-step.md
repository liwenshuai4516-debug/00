# 输入持久化接入实际页面（手写步骤）

本轮已核对使用者新建的 `src/renderer/components/composer-persistence.js`，内容与上一步指南一致，语法检查通过。测试误放在 `tests/composer-persistence.test.js`，相对导入因此越过项目目录，直接运行16项全部失败。先移动文件，不修改测试里的导入路径。

假设与取舍：沿用现有深色页面、原生 DOM 和现有后端接口；本步一次接通输入保存、发送消费、会话切换和错误状态，避免自动保存提前启用而发送仍走旧流程。继续由使用者亲手修改应用代码。

可验证目标：A/B输入不串会话；原文与空白准确；发送成功及停止不恢复旧输入；生成中的新输入独立保存；保存失败提供重试；结果未知保留独立原文，不自动重发。

步骤：先修正测试位置并验证组件 → 同时完成HTML、CSS、renderer接线 → 语法与针对性测试通过后再启动应用验收。全部修改完成前先不要启动新页面。

## 0. 移动测试并验证组件

在项目根目录执行（仅移动一次；若目标文件已经存在，先核对两份文件，不覆盖）：

```bash
mv tests/composer-persistence.test.js tests/unit/composer-persistence.test.js
node --check src/renderer/components/composer-persistence.js
node --test \
  tests/unit/composer-persistence.test.js \
  tests/unit/composer-send-reconcile.test.js \
  tests/unit/composer-draft-send-queue.test.js \
  tests/unit/composer-draft-queue.test.js \
  tests/unit/composer-draft-restore.test.js \
  tests/unit/composer-drafts.test.js
```

预期53项通过，其中组件16项、原有37项。实际错误目录下的16项失败不能记作通过；本轮只在测试移到正确目录的临时副本中验证了53项。

## 1. HTML：输入状态、重试及未确认原文

文件：`src/renderer/index.html`。

先找到输入框的 `aria-describedby="message-input-hint"`，改成：

```html
aria-describedby="message-input-hint composer-draft-status"
```

再找到 `<p id="message-input-hint">`，在这一行前面插入下面完整内容。保留原提示段落与它的正文；新内容位于表单后方，与提示段落同级。

```html
        <div class="composer-save-row">
          <p id="composer-draft-status" role="status" aria-atomic="true">正在读取输入……</p>
          <button id="composer-draft-retry" type="button" hidden>重试保存或核对</button>
        </div>
        <details id="unconfirmed-send" class="unconfirmed-send" hidden>
          <summary>查看未确认的发送原文</summary>
          <p>请求结果尚未确认，原文已保留。请先核对聊天记录；可以新建对话继续。</p>
          <pre id="unconfirmed-send-text" tabindex="0" aria-label="未确认的发送原文"></pre>
        </details>
```

未确认原文是独立的只读区域；可以展开查看并用键盘选择文本。它不会回填普通输入，也不会自动重发。手动解除记录的入口留到后续步骤，当前可以保留原会话并新建对话继续。

## 2. CSS：沿用深色输入区布局

文件：`src/renderer/styles/codex-theme.css`。在现有 `@media (max-width: 1100px) {` 之前插入以下完整样式。保留该媒体查询及其内容：

```css
/* 输入保存与文件草稿分别展示，状态和原文只在输入区内换行、滚动。 */
.composer-save-row {
  width: min(100%, var(--content-width)); margin: 8px auto 0;
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
}
#composer-draft-status { flex: 1 1 180px; margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
#composer-draft-retry { min-height: 40px; padding: 6px 10px; font-size: 12px; }
.unconfirmed-send { width: min(100%, var(--content-width)); margin: 8px auto 0; max-height: 24dvh; overflow: auto; }
.unconfirmed-send > summary { color: var(--muted); font-size: 12px; }
.unconfirmed-send > p { margin: 8px 0; font-size: 12px; overflow-wrap: anywhere; }
.unconfirmed-send pre { max-width: 100%; max-height: 120px; margin: 0; padding: 8px; white-space: pre; overflow: auto; font-size: 12px; tab-size: 2; }
```

## 3. renderer：整体接入保存、发送和切换

以下都修改 `src/renderer/renderer.js`。不要直接覆盖整份文件，以免混入或覆盖其他界面改动。

### 3.1 替换输入管理器导入

将这一行：

```js
import { createComposerDrafts } from "./components/composer-drafts.js";
```

替换为：

```js
import { createComposerPersistence } from "./components/composer-persistence.js";
```

删除下面这一行。保留周围的 input、sendButton、stopButton 声明：

```js
const composerDrafts = createComposerDrafts(input);
```

### 3.2 添加输入状态接线

找到下面的原有一行，将它整体替换为下面完整代码；`stopButton` 只保留这一处声明：

```js
const stopButton = document.getElementById("stop-button");
```

```js
const stopButton = document.getElementById("stop-button");
// 页面忙碌与输入就绪分别管理，保存确认不能解除其他操作的忙碌状态。
let pageBusy = true;
let pageGenerating = false;
let composerState = { canSend: false, retryable: false, pendingSend: null };
const composerStatus = document.getElementById("composer-draft-status");
const composerRetry = document.getElementById("composer-draft-retry");
const unconfirmedSend = document.getElementById("unconfirmed-send");
const unconfirmedText = document.getElementById("unconfirmed-send-text");
let shownSendId = null;

function renderComposerState() {
  const message = composerState.message || "正在读取输入……";
  if (composerStatus.textContent !== message) composerStatus.textContent = message;
  composerRetry.hidden = !composerState.retryable;
  composerRetry.disabled = pageBusy;
  sendButton.disabled = pageBusy || !composerState.canSend;

  // 生成中的临时快照等待请求结束后再展示，避免误报为异常。
  const pending = pageGenerating ? null : composerState.pendingSend;
  unconfirmedSend.hidden = !pending;
  if (shownSendId !== pending?.id) unconfirmedSend.open = false;
  shownSendId = pending?.id ?? null;
  unconfirmedText.textContent = pending?.text ?? "";
}

const composerPersistence = createComposerPersistence(input, window.agent, (state) => {
  composerState = state;
  renderComposerState();
});

// 主进程已切换成功时，输入读取失败只影响输入区，不误报为会话切换失败。
async function bindComposer(sessionId) {
  try {
    await composerPersistence.switchTo(sessionId);
  } catch (error) {
    addMessage("error", `当前对话已打开，输入读取失败：${error.message}`);
  }
}

composerRetry.addEventListener("click", async () => {
  if (composerRetry.disabled) return;
  setBusy(true);
  try {
    await composerPersistence.retry();
  } catch {
    // 组件已在输入区展示具体错误；继续保留编辑内容和重试入口。
  } finally {
    setBusy(false);
    input.focus();
  }
});
window.addEventListener("pagehide", () => composerPersistence.dispose(), { once: true });
```

`pageBusy` 与组件的 `canSend` 共同决定发送按钮。组件保存完成只能更新输入状态，不能解除正在进行的会话切换、生成或文件保存操作。`pagehide` 仅释放监听和计时器，不代表实现关闭前补保存。

### 3.3 整体替换 setBusy

从 `function setBusy(busy, generating = false) {` 到该函数结束的 `}`，整体替换为：

```js
function setBusy(busy, generating = false) {
  pageBusy = busy;
  pageGenerating = generating;
  // fieldset 会统一禁用其内部按钮。
  proposalPanelElement.disabled = busy;
  modelSelector.setBusy(busy);
  renderComposerState();
  newChatButton.disabled = busy;
  selectWorkspaceButton.disabled = busy;
  compactSessionButton.disabled = busy;
  exportConversationButton.disabled = busy;
  sessionList.setBusy(busy);
  projectPanel.setBusy(busy);
  stopButton.disabled = !generating;
  renameButton.disabled = busy;
}
```

### 3.4 列表刷新与初始化绑定分开

整体替换 `async function refreshSessions() { ... }` 为：

```js
async function refreshSessions() {
  const sessions = await window.agent.listSessions();
  const currentId = await window.agent.currentSession();

  // 会话数据和当前编号仍由主进程提供。
  sessionList.render(sessions, currentId);
}
```

再整体替换 `async function loadHistory() { ... }` 为：

```js
async function loadHistory() {
  setBusy(true);

  try {
    const history = await window.agent.loadHistory();
    await bindComposer(await window.agent.currentSession());
    showHistory(history);
    await sessionInfoPanel.refresh();

    await restoreProposalPanel();
    await refreshSessions();
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    // 操作结束后读取实际会话的模型，再恢复交互。
    await modelSelector.refresh();
    setBusy(false);
    input.focus();
  }
}
```

刷新历史列表只刷新列表；首次初始化及主进程确认切换成功时才绑定输入。项目打开会并行刷新文件草稿与列表，而输入核对和文件草稿读取共用主进程互斥入口，因此不能把输入读取放进并行的列表刷新里。

### 3.5 四个切换入口改用异步绑定

以下每处只替换所列片段，其余代码保留。全部 `bindComposer` 都必须有 `await`。

新建对话：在 `newChatButton.addEventListener("click", ...)` 中，将：

```js
    const sessionId = await window.agent.newChat();
    composerDrafts.switchTo(sessionId);
```

替换为：

```js
    const sessionId = await window.agent.newChat();
    await bindComposer(sessionId);
```

打开项目：在 `async function openProject(projectId)` 中，将：

```js
  const result = await window.agent.openProject(projectId);

  // 等待期间的新输入也归入原会话，再恢复目标会话的输入。
  composerDrafts.switchTo(result.sessionId);
```

替换为：

```js
  const result = await window.agent.openProject(projectId);

  // 等待期间的新输入也归入原会话，再恢复目标会话的输入。
  await bindComposer(result.sessionId);
```

保持这次绑定在后面的 `Promise.allSettled([...])` 之前，不移入并行刷新。

打开历史对话：在 `async function openHistorySession(sessionId)` 中，将：

```js
    const history = await window.agent.openSession(sessionId);
    // 打开成功后，再保存旧输入并恢复目标会话的输入。
    composerDrafts.switchTo(sessionId);
```

替换为：

```js
    const history = await window.agent.openSession(sessionId);
    // 打开成功后，再保存旧输入并恢复目标会话的输入。
    await bindComposer(sessionId);
```

选择工作目录：在 `selectWorkspaceButton.addEventListener("click", ...)` 中，将：

```js
    switched = true;
    // 主进程已切换成功，立即保存旧输入并绑定新会话编号。
    composerDrafts.switchTo(result.sessionId);
```

替换为：

```js
    switched = true;
    // 主进程已切换成功，立即保存旧输入并绑定新会话编号。
    await bindComposer(result.sessionId);
```

取消选择或主进程切换失败时，不调用绑定；原输入继续属于原会话。主进程切换成功但输入读取失败时，页面显示目标对话并提供输入重试，不能假装仍停留在原会话。

### 3.6 整体替换发送处理

从 `form.addEventListener("submit", async (event) => {` 开始，到 `newChatButton.addEventListener("click", ...)` **前面**的 `});` 为止，整体替换为下面代码。保留后面的新建对话处理。

不要仅拼接 try/catch/finally，否则容易留下重复 finally；此版本已经包含完整的监听清理、流式补绘和工具收尾：

```js
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!input.value.trim() || sendButton.disabled) return;

  setBusy(true);
  let ticket;
  try {
    ticket = await composerPersistence.prepareSend();
  } catch (error) {
    addMessage("error", error.message);
    setBusy(false);
    input.focus();
    return;
  }

  messageScroll.followLatest();
  // 等待保存期间可能继续编辑，展示和发送都使用最终固定的同一份原文。
  addMessage("user", ticket.text.trim());
  setBusy(true, true);
  setRequestStatus("正在准备请求并等待模型回复……");

  // 模型请求和随后刷新历史列表是两个不同阶段。
  let requestReturned = false;
  let inputSettled = false;
  let replyElement;
  let reply = "";

  // 每轮请求独立管理，使用调用编号关联，不能按工具名称匹配。
  const pendingTools = new Map();
  // 一帧内合并流式更新；工具调用前后的回复节点分别保留。
  const pendingReplies = new Map();
  let replyFrame;

  function flushReplies() {
    replyFrame = undefined;

    for (const [body, text] of pendingReplies) {
      updateAssistantMessage(body, text);
    }

    pendingReplies.clear();
    messageScroll.update();
  }

  // 请求发起之前先监听，避免遗漏早期状态。
  const unsubscribeStatus = window.agent.onRequestStatus(setRequestStatus);
  const unsubscribeConsumed = window.agent.onDraftConsumed((ack) => {
    composerPersistence.confirmConsumed(ticket, ack);
  });

  const unsubscribe = window.agent.onTextDelta((delta) => {
    setRequestStatus("正在接收回复……");

    if (!replyElement) {
      replyElement = addMessage("assistant", "");
    }

    reply += delta;

    pendingReplies.set(replyElement, reply);

    if (replyFrame === undefined) {
      replyFrame = requestAnimationFrame(flushReplies);
    }
  });

  const unsubscribeTool = window.agent.onToolEvent((event) => {
    if (event.type === "start") {
      setRequestStatus(`正在调用工具：${event.name}`);

      // 工具事件将连续的模型文本分成不同段落。
      replyElement = undefined;
      reply = "";

      const body = addMessage("tool", `正在调用 ${event.name}`);

      pendingTools.set(event.toolCallId, {
        body,
        name: event.name,
      });
    } else if (event.type === "end") {
      setRequestStatus("工具已返回，正在继续处理……");

      replyElement = undefined;
      reply = "";

      const text = event.proposal
        ? `${event.text}\n草稿编号：${event.proposal.id}`
        : event.text;

      const pending = pendingTools.get(event.toolCallId);

      if (pending) {
        // 更新开始时创建的记录，避免留下重复的“正在调用”。
        updateToolMessage(pending.body, text);
        pendingTools.delete(event.toolCallId);
        messageScroll.update();
      } else {
        // 未收到开始事件时，也保留实际完成结果。
        addMessage("tool", text);
      }

      if (event.proposal) {
        proposalPanel.add(event.proposal.id);
        proposalReviewPanel.open = true;
      }
    }
  });
  try {
    const result = await window.agent.sendMessage(ticket.text, {
      sessionId: ticket.sessionId,
      revision: ticket.revision,
    });
    // 已返回的请求与随后页面刷新分别处理，输入补保存失败不恢复已发送原文。
    requestReturned = true;
    await composerPersistence.finishSend(ticket, result);
    inputSettled = true;

    if (result.outcome === "unconfirmed") {
      setRequestStatus("请求结果尚未确认，发送原文已单独保留。可以查看后新建对话继续。");
      addMessage("error", result.error || "请求结果尚未确认。");
    } else {
      setRequestStatus(result.stopped ? "生成已停止。" : "本次回复已结束。");
      if (result.stopped) addMessage("status", "生成已停止");
    }
    if (result.warning) addMessage("status", result.warning);
    await refreshSessions();
  } catch (error) {
    if (requestReturned && inputSettled) {
      setRequestStatus("请求已返回，但历史列表刷新失败；输入保持当前状态。");
      addMessage("error", `历史列表刷新失败：${error.message}`);
    } else {
      try {
        const recovered = await composerPersistence.recoverSend(ticket);
        setRequestStatus(
          recovered?.status === "not-consumed"
            ? "本次请求未发送，已保留输入，可检查后重试。"
            : "请求结果尚未确认，已核对输入状态；请先查看聊天记录。",
        );
      } catch (recoveryError) {
        setRequestStatus("请求结果及输入状态尚未确认，请使用输入区的重试入口核对。");
        addMessage("error", `输入状态核对失败：${recoveryError.message}`);
      }
      addMessage("error", error.message);
    }
  } finally {
    // 每轮请求都清理全部监听，避免下一轮重复接收事件。
    unsubscribe();
    unsubscribeTool();
    unsubscribeStatus();
    unsubscribeConsumed();
    // 正常结束、停止或失败时，立即展示尚未绘制的最后一段。
    if (replyFrame !== undefined) cancelAnimationFrame(replyFrame);
    flushReplies();
    // 停止或异常可能没有完成事件，不能继续显示“正在调用”。
    for (const { body, name } of pendingTools.values()) {
      updateToolMessage(
        body,
        `${name} 结果未确认\n本轮请求已结束，未收到该工具的完成结果。`,
      );
    }

    pendingTools.clear();
    messageScroll.update();

    // 成功、失败或停止后都重新读取当前会话的上下文估算。
    await sessionInfoPanel.refresh();
    setBusy(false);
    input.focus();
  }
});
```

发送使用 `ticket.text` 完整原文与固定的会话编号、版本。聊天气泡仍可去除首尾空白来展示；主进程既有模型调用规则保持不变。消费确认监听先于发送请求，返回结果再补确认；只有核对证明未消费时才恢复，后来的输入和主动清空优先。

结果未知时保留发送快照并暂停该会话再次发送；普通输入仍可保存。不要把“列表刷新失败”当成“消息没有发送”。如果核对接口仍忙碌，输入区保留重试入口，等待本轮结束后再核对。

## 4. 验证

先检查语法：

```bash
node --check src/renderer/components/composer-persistence.js
node --check src/renderer/renderer.js
```

再运行第0节的六个测试文件，预期53项通过。检查 renderer 中已经没有旧输入管理器引用：

```bash
rg -n "composerDrafts|createComposerDrafts|originalInput|requestCompleted" src/renderer/renderer.js
```

这次搜索预期无输出（rg无匹配时退出码为1，这是正常结果）。然后 `npm start`。

使用已有消息的两条对话做界面验收，避免把未落盘的空会话当作重启恢复证据：

1. 在A输入带首尾空格、缩进和空行的文本，等“输入已保存”；切B输入不同内容，再切回，两边各自保留。主动清空后等保存，切走再回来仍为空。
2. 在A等保存后正常退出、重启，再打开同一条已有历史的A，检查原文。这里只验证已确认保存的内容；不要用最后一个字符尚未保存时强退来验收关闭补保存。
3. 发送A原文，生成期间继续写下一条输入，等保存；完成后新输入保留。切换/重启后不恢复已发送的旧原文。主动停止同样检查。
4. 输入中文时用Enter选词不发送；Shift+Enter换行；普通Enter只发送一次。检查流式回复、上翻阅读、工具配对和停止后按钮恢复。
5. 保留输入执行目录选择取消、模型切换、上下文整理、导出，以及项目切换；原输入不丢失且不串项目。已有文件草稿的保存/放弃入口继续可用。
6. 缩窄窗口，检查输入、状态、重试按钮没有整页横向溢出，键盘可以到达。若遇到真实保存或读取失败，正文应保留，重试成功后再恢复发送；不需要破坏真实数据来制造故障。
7. 若遇到未确认结果，检查独立原文区域可展开，原样显示文字与空白；新输入仍可编辑、保存，发送受保护。可保留此会话并新建继续，暂不提供清除快照操作。

模拟检查已覆盖保存失败、消费前异常、模型异常、缺失确认、列表刷新失败及状态核对仍忙碌；这些检查使用模拟请求，不替代用户真实界面验收。

## 5. 本轮验证边界与后续

临时副本：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-page-o_qy2gsq`。它以已提交代码为底，覆盖当前实际渲染层，再应用本指南候选。测试只用临时状态、工作目录及模拟请求，未读取真实会话或配置、请求模型、写真实剪贴板。

- 正确测试目录下的组件与相关回归：53项通过；候选renderer语法检查通过。
- Electron实际页面、实际preload/IPC与临时状态存储：14项模拟检查通过，覆盖恢复隔离、保存失败重试、发送/停止与新输入、缺失确认协调、未确认原文、读取失败保护、项目与其他页面操作、整页重建恢复及三档窗口布局。
- 1120×900、620×850、375×812三档检查无整页横向溢出，输入状态可见；已查看模拟页面截图。实际应用页面尚未修改或手动验收。

本步完成后先核对实际代码和针对性验证，再继续未确认记录的手动处理、空会话登记与重建、正常关闭补保存。尚不能称为完整输入草稿重启恢复；会话置顶归档与上下文常驻入口按总设计后续实施。

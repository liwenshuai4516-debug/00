# 未确认发送：页面确认与组件同步（手写步骤）

后端dismissSend、互斥IPC和preload已由使用者完成，实际三个脚本语法检查及11项新增加相关回归共67项通过。下面继续由使用者亲手编写前端与专项测试，复用当前深色页面和现有接口。

## 范围与成功标准

第一次点击“解除发送限制…”只展示说明，默认焦点在“取消”。用户明确点击“清理快照并解除”后，才提交打开确认时的会话编号和发送编号。说明必须明确：快照原文会移除；请先核对聊天记录、保留需要的原文；当前输入与历史记录保留，不重新发送消息。

动作期间保留输入编辑；解除只更新快照状态，不用读取结果中的旧草稿正文或版本覆盖后来输入。清理失败保留快照；返回丢失先只读核对，核对也失败时保留限制和重试入口。普通“重试保存或核对”只读取解除结果，不重复调用清理接口。会话或快照变化后旧确认失效。

步骤：扩展输入组件 → 添加确认区域与样式 → 接renderer事件与禁用状态 → 写8项专项测试 → 运行61项相关验证后再做页面验收。

本步已应用ui-ux-pro-max的局部交互建议：不可恢复动作先确认，完成有文字反馈，说明紧邻原文，取消优先，保留键盘焦点和窄窗口内滚动。不引入Vue、额外依赖或新的后端通道。

## 1. 输入组件扩展

以下修改 `/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/components/composer-persistence.js`。

### 1.1 整体替换publish函数

从 `function publish(entry) {` 到这个函数的结束 `}`，整体替换为以下完整代码；保留后面的clearTimers：

```js
  function publish(entry) {
    if (disposed || entry?.sessionId !== currentId) return;
    onState({
      sessionId: currentId,
      message: entry.dismissing ? "正在解除发送限制……"
        : entry.pendingCheckError ? `解除结果尚未确认，请重试核对：${entry.pendingCheckError.message}`
        : entry.error ? `输入未保存或未完成核对：${entry.error.message}` : entry.message,
      retryable: Boolean(entry.error || entry.pendingCheckError),
      canSend: entry.loaded && !entry.preparing && !entry.ticket && !entry.pendingSend && !entry.error && !entry.dismissing && !entry.pendingCheckError,
      canDismiss: entry.loaded && !entry.preparing && !entry.ticket && Boolean(entry.pendingSend) && !entry.error && !entry.dismissing && !entry.pendingCheckError,
      pendingSend: entry.pendingSend ? { ...entry.pendingSend } : null,
    });
  }
```

`pendingCheckError`与普通输入保存错误分别保留。即使后来输入保存成功，也不能因此抹掉“解除结果尚未核对”的限制。`canDismiss`同时检查加载、发送凭证、准备状态和处理状态。

### 1.2 增加每条会话的解除状态

在switchTo内部创建entry对象时，找到：

```js
preparing: false, ticket: null, confirmed: false, pendingSend: null,
```

替换为：

```js
preparing: false, ticket: null, confirmed: false, pendingSend: null,
        dismissing: false, pendingCheckError: null,
```

### 1.3 补充prepareSend的状态保护

在prepareSend开头，找到下面这行if条件，保留后面的throw与结束括号：

```js
if (!entry?.loaded || entry.error || entry.preparing || entry.ticket || entry.pendingSend) {
```

只将这一行替换为：

```js
if (!entry?.loaded || entry.error || entry.preparing || entry.ticket || entry.pendingSend || entry.dismissing || entry.pendingCheckError) {
```

### 1.4 替换retry并添加两个内部方法

找到现有完整的 `async function retry() { ... }`，从该函数开头到它的结束括号整体替换为下面全部代码。保留后面的dispose，不重复定义retry：

```js
  // 解除结果丢失时只读取快照，不采用读取到的草稿正文或版本覆盖本地编辑。
  async function refreshPending(entry) {
    try {
      const inspected = await api.inspectComposerSend(entry.sessionId);
      const pending = inspected?.pendingSend;
      if (inspected?.sessionId !== entry.sessionId || !(pending === null || (
        typeof pending?.id === "string" && pending.id && typeof pending.text === "string"
      ))) {
        throw new Error("快照核对结果无效，请重新读取。");
      }
      entry.pendingSend = pending ? { ...pending } : null;
      entry.pendingCheckError = null;
      return !pending;
    } catch (error) {
      entry.pendingCheckError = error;
      publish(entry);
      throw error;
    }
  }

  async function dismissPendingSend(sendId) {
    const entry = entries.get(currentId);
    if (!entry?.loaded || entry.error || entry.preparing || entry.ticket || entry.dismissing || entry.pendingCheckError || !entry.pendingSend || entry.pendingSend.id !== sendId) {
      throw new Error("发送记录或输入状态已变化，请重新核对。");
    }
    entry.dismissing = true;
    publish(entry);
    try {
      try {
        const result = await api.dismissComposerSend(entry.sessionId, sendId);
        if (result?.sessionId !== entry.sessionId || result.sendId !== sendId) {
          throw new Error("解除确认与提交的编号不匹配。");
        }
        entry.pendingSend = null;
      } catch (error) {
        // 可能已经写入但没有收到返回；核对前不能假定失败，也不能重复清理。
        if (!await refreshPending(entry)) throw error;
      }
      entry.message = "发送限制已解除，当前输入已保留。";
    } finally {
      entry.dismissing = false;
      publish(entry);
    }
  }

  async function retry() {
    const entry = entries.get(currentId);
    if (!entry) return;
    if (entry.dismissing) throw new Error("请等待解除操作结束。");
    if (entry.ticket) return recoverSend(entry.ticket);
    if (!entry.loaded) return switchTo(currentId);
    // 普通重试只核对解除结果，绝不再次调用清理接口。
    if (entry.pendingCheckError) await refreshPending(entry);
    return save(entry);
  }
```

refreshPending只采用快照字段；即使接口返回磁盘上的旧输入，也不回填DOM、不重登记队列、不猜测新版本。解除成功只清除本条快照；若接口报错但核对发现快照已为空，则恢复操作；若核对发现新快照，则展示新原文并要求重新确认。

### 1.5 暴露组件方法

在文件底部公开方法列表中，将：

```js
switchTo, prepareSend, confirmConsumed, finishSend, recoverSend, retry, dispose,
```

替换为：

```js
switchTo, prepareSend, confirmConsumed, finishSend, recoverSend, dismissPendingSend, retry, dispose,
```

保留公开对象中的flush实现，不修改其他模块。

## 2. HTML增加二次确认区

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/index.html`。

找到 `<details id="unconfirmed-send" ...>`，从它的开始标签到紧邻的结束 `</details>`，整体替换为以下完整内容。保留后面的message-input-hint提示和footer：

```html
        <details id="unconfirmed-send" class="unconfirmed-send" hidden>
          <summary>查看未确认的发送原文</summary>
          <p>请求结果尚未确认，原文已保留。请先核对聊天记录；可以新建对话继续。</p>
          <pre id="unconfirmed-send-text" tabindex="0" aria-label="未确认的发送原文"></pre>
          <button id="dismiss-send-button" type="button" aria-controls="dismiss-send-confirm" aria-expanded="false" disabled>解除发送限制…</button>
          <div id="dismiss-send-confirm" class="dismiss-send-confirm" role="group" aria-labelledby="dismiss-send-question" hidden>
            <p id="dismiss-send-question">将移除这份未确认原文快照并解除发送限制。请先核对聊天记录，保留需要的原文。当前输入和历史记录会保留，不会重新发送。</p>
            <div class="dismiss-send-actions">
              <button id="dismiss-send-cancel" type="button">取消</button>
              <button id="dismiss-send-accept" type="button">清理快照并解除</button>
            </div>
          </div>
        </details>
```

所有按钮都必须保留type="button"，避免触发表单发送。说明区沿用hidden控制，不把快照当作HTML渲染。

## 3. CSS保持输入区内部滚动

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/styles/codex-theme.css`。

在已有 `@media (max-width: 1100px) {` 之前插入：

```css
/* 清理确认紧邻原文，按钮允许换行并保留键盘焦点样式。 */
#dismiss-send-button { min-height: 44px; margin-top: 8px; }
.dismiss-send-confirm { margin-top: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
.dismiss-send-confirm p { margin: 0 0 10px; font-size: 12px; overflow-wrap: anywhere; }
.dismiss-send-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dismiss-send-actions button { min-height: 44px; }
```

沿用现有unconfirmed-send的最大高度与内部滚动，按钮允许换行。短窗口内确认区域可滚动到达，不扩大整页横向宽度。

## 4. renderer接线

以下修改 `/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/renderer.js`。

### 4.1 声明确认区节点

找到 `let shownSendId = null;`，将这一行替换为以下完整代码。保留后面的renderComposerState：

```js
let shownSendId = null;
const dismissSendButton = document.getElementById("dismiss-send-button");
const dismissConfirm = document.getElementById("dismiss-send-confirm");
const dismissAccept = document.getElementById("dismiss-send-accept");
const dismissCancel = document.getElementById("dismiss-send-cancel");
let dismissTarget = null;
```

### 4.2 整体替换renderComposerState

从 `function renderComposerState() {` 到该函数的结束括号，整体替换为下面完整代码。保留后面的composerPersistence创建：

```js
function renderComposerState() {
  const message = composerState.message || "正在读取输入……";
  if (composerStatus.textContent !== message)
    composerStatus.textContent = message;
  composerRetry.hidden = !composerState.retryable;
  composerRetry.disabled = pageBusy;
  sendButton.disabled = pageBusy || !composerState.canSend;

  // 生成中的临时快照等待请求结束后再展示，避免误报为异常。
  const pending = pageGenerating ? null : composerState.pendingSend;
  unconfirmedSend.hidden = !pending;
  if (shownSendId !== pending?.id) unconfirmedSend.open = false;
  shownSendId = pending?.id ?? null;
  unconfirmedText.textContent = pending?.text ?? "";
  // 确认只属于打开时的会话和快照；切换后必须重新核对。
  if (dismissTarget && (dismissTarget.sessionId !== composerState.sessionId || dismissTarget.sendId !== pending?.id)) {
    dismissTarget = null;
  }
  const disabled = pageBusy || !composerState.canDismiss;
  dismissSendButton.disabled = disabled;
  dismissAccept.disabled = disabled;
  dismissCancel.disabled = pageBusy;
  dismissConfirm.hidden = !dismissTarget;
  dismissSendButton.setAttribute("aria-expanded", String(Boolean(dismissTarget)));
}
```

输入保存状态刷新不会关闭同一份确认说明；切换会话或发送编号变化才撤销旧确认。全页面忙碌与组件就绪共同禁用按钮，组件不能擅自解除页面忙碌。

### 4.3 添加按钮事件

找到下面这条原有pagehide监听的第一行：

```js
window.addEventListener("pagehide", () => composerPersistence.dispose(), {
```

在它之前插入以下完整事件代码，原pagehide监听与后续声明保留，不重复粘贴：

```js
// 第一次点击只展示影响说明，不调用后端；焦点先放到取消按钮。
dismissSendButton.addEventListener("click", () => {
  if (dismissSendButton.disabled) return;
  dismissTarget = { sessionId: composerState.sessionId, sendId: composerState.pendingSend.id };
  renderComposerState();
  dismissCancel.focus();
});

function cancelDismiss() {
  dismissTarget = null;
  renderComposerState();
  dismissSendButton.focus();
}
dismissCancel.addEventListener("click", cancelDismiss);
dismissConfirm.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.isComposing && !pageBusy) {
    event.preventDefault();
    cancelDismiss();
  }
});

dismissAccept.addEventListener("click", async () => {
  const target = dismissTarget;
  if (dismissAccept.disabled || !target || target.sessionId !== composerState.sessionId || target.sendId !== composerState.pendingSend?.id) return;
  setBusy(true);
  dismissTarget = null;
  renderComposerState();
  try {
    await composerPersistence.dismissPendingSend(target.sendId);
    setRequestStatus("发送限制已解除，当前输入已保留；没有重新发送消息。");
  } catch (error) {
    setRequestStatus("解除尚未完成，请查看输入区状态或重新核对原文。");
    addMessage("error", `解除发送限制：${error.message}`);
  } finally {
    setBusy(false);
    input.focus();
  }
});
```

第一次点击只打开说明并把焦点交给取消；取消或非输入法状态下的Escape不调用后端。确认后捕获原编号，清理或核对结束再恢复交互，并把焦点还给输入框。输入区仍可编辑，不将原文自动填回或重发。

## 5. 新建完整专项测试

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/composer-send-dismiss-ui.test.js`，写入下面全部代码：

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(t) {
  const { createComposerPersistence } = await import("../../src/renderer/components/composer-persistence.js");
  class Input extends EventTarget { value = ""; }
  const input = new Input();
  const snapshot = { id: "old-send", text: "  待核对原文\r\n", draftRevision: 1 };
  const records = new Map([
    ["a", { sessionId: "a", text: "  后来输入\n", revision: 2, pendingSend: snapshot }],
    ["b", { sessionId: "b", text: "B 输入", revision: 0, pendingSend: null }],
  ]);
  let current = "a";
  const calls = [];
  const views = [];
  const api = {
    async loadComposerDraft() {
      const { sessionId, text, revision } = records.get(current);
      return { sessionId, text, revision };
    },
    async inspectComposerSend(id) {
      calls.push(["inspect", id]);
      return structuredClone(records.get(id));
    },
    async saveComposerDraft(id, text, revision) {
      const state = records.get(id);
      assert.equal(revision, state.revision);
      state.text = text;
      state.revision += 1;
      return { sessionId: id, text, revision: state.revision };
    },
    async dismissComposerSend(id, sendId) {
      calls.push(["dismiss", id, sendId]);
      assert.equal(records.get(id).pendingSend.id, sendId);
      records.get(id).pendingSend = null;
      return { sessionId: id, sendId };
    },
  };
  const controller = createComposerPersistence(input, api, (view) => views.push(view));
  t.after(() => controller.dispose());
  await controller.switchTo("a");
  return {
    input, records, calls, views, api, controller,
    view: () => views.at(-1),
    select(id) { current = id; },
    edit(text) { input.value = text; input.dispatchEvent(new Event("input")); },
    dismissCalls: () => calls.filter(([kind]) => kind === "dismiss").length,
  };
}

test("读取只展示快照，错误编号或无快照不调用解除接口", async (t) => {
  const s = await setup(t);
  assert.equal(s.view().canDismiss, true);
  assert.equal(s.view().canSend, false);
  assert.equal(s.dismissCalls(), 0);
  await assert.rejects(s.controller.dismissPendingSend("wrong"), /状态已变化/);
  s.select("b");
  await s.controller.switchTo("b");
  assert.equal(s.view().canDismiss, false);
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /状态已变化/);
  assert.equal(s.dismissCalls(), 0);
});

test("解除期间保留新输入与主动清空，编号确认后不覆盖正文和保存版本", async (t) => {
  for (const text of ["  新输入\r\n", ""]) {
    const s = await setup(t);
    const gate = Promise.withResolvers();
    const dismiss = s.api.dismissComposerSend;
    s.api.dismissComposerSend = async (...args) => { await gate.promise; return dismiss(...args); };
    const working = s.controller.dismissPendingSend("old-send");
    assert.equal(s.view().canDismiss, false);
    assert.equal(s.view().canSend, false);
    await assert.rejects(s.controller.dismissPendingSend("old-send"), /状态已变化/);
    await assert.rejects(s.controller.prepareSend(), /尚未就绪/);
    s.edit("后来主动编辑"); s.edit(text);
    await s.controller.flush();
    gate.resolve(); await working;
    assert.equal(s.input.value, text);
    assert.equal(s.records.get("a").text, text);
    assert.equal(s.records.get("a").revision, 3);
    assert.equal(s.view().pendingSend, null);
    assert.equal(s.view().canSend, true);
    assert.equal(s.dismissCalls(), 1);
  }
});

test("解除前失败，核对后保留同一快照供重新确认，不改当前输入", async (t) => {
  const s = await setup(t);
  s.api.dismissComposerSend = async (id, sendId) => {
    s.calls.push(["dismiss", id, sendId]);
    throw new Error("模拟写入失败");
  };
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /模拟写入失败/);
  assert.equal(s.view().pendingSend.id, "old-send");
  assert.equal(s.view().canDismiss, true);
  assert.equal(s.view().canSend, false);
  assert.equal(s.input.value, "  后来输入\n");
  assert.equal(s.dismissCalls(), 1);
});

test("写入成功但返回丢失时只读核对，确定空快照后解除且不重复请求", async (t) => {
  const s = await setup(t);
  const dismiss = s.api.dismissComposerSend;
  s.api.dismissComposerSend = async (...args) => {
    await dismiss(...args);
    throw new Error("模拟返回丢失");
  };
  s.edit(" \n新输入\t ");
  await s.controller.dismissPendingSend("old-send");
  assert.equal(s.view().pendingSend, null);
  assert.equal(s.view().canSend, true);
  assert.equal(s.input.value, " \n新输入\t ");
  await s.controller.flush();
  assert.equal(s.records.get("a").text, " \n新输入\t ");
  assert.equal(s.dismissCalls(), 1);
});

test("返回与核对都失败时保持限制，普通重试只核对且不自动再次清理", async (t) => {
  const s = await setup(t);
  const dismiss = s.api.dismissComposerSend;
  const inspect = s.api.inspectComposerSend;
  s.api.dismissComposerSend = async (...args) => { await dismiss(...args); throw new Error("返回丢失"); };
  s.api.inspectComposerSend = async () => { throw new Error("核对不可用"); };
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /核对不可用/);
  s.edit("仍可单独保存的新输入");
  await s.controller.flush();
  assert.equal(s.view().retryable, true);
  assert.equal(s.view().canSend, false);
  assert.equal(s.view().canDismiss, false);
  assert.match(s.view().message, /解除结果尚未确认/);
  s.api.inspectComposerSend = inspect;
  await s.controller.retry();
  assert.equal(s.view().pendingSend, null);
  assert.equal(s.view().canSend, true);
  assert.equal(s.records.get("a").text, "仍可单独保存的新输入");
  assert.equal(s.dismissCalls(), 1);
});

test("核对发现新快照时替换展示，旧确认不能清理新快照", async (t) => {
  const s = await setup(t);
  s.api.dismissComposerSend = async (id, sendId) => {
    s.calls.push(["dismiss", id, sendId]);
    s.records.get(id).pendingSend = { id: "new-send", text: "另一份原文", draftRevision: 1 };
    throw new Error("发送记录已变化");
  };
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /发送记录已变化/);
  assert.equal(s.view().pendingSend.id, "new-send");
  assert.equal(s.view().pendingSend.text, "另一份原文");
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /状态已变化/);
  assert.equal(s.dismissCalls(), 1);
  assert.equal(s.input.value, "  后来输入\n");
});

test("错误归属的返回和缺失pendingSend的核对不能误解锁", async (t) => {
  const s = await setup(t);
  const inspect = s.api.inspectComposerSend;
  s.api.dismissComposerSend = async () => ({ sessionId: "b", sendId: "old-send" });
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /编号不匹配/);
  assert.equal(s.view().canSend, false);
  s.api.inspectComposerSend = async () => ({ sessionId: "a" });
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /核对结果无效/);
  assert.equal(s.view().retryable, true);
  s.api.inspectComposerSend = inspect;
  await s.controller.retry();
  assert.equal(s.view().pendingSend.id, "old-send");
  assert.equal(s.view().canSend, false);
});

test("A的迟到解除不回填或发布到B，切回A仍保留自己的输入", async (t) => {
  const s = await setup(t);
  const gate = Promise.withResolvers();
  const dismiss = s.api.dismissComposerSend;
  s.api.dismissComposerSend = async (...args) => { await gate.promise; return dismiss(...args); };
  const working = s.controller.dismissPendingSend("old-send");
  s.select("b"); await s.controller.switchTo("b");
  s.edit("B 后来的输入");
  const count = s.views.length;
  gate.resolve(); await working;
  assert.equal(s.input.value, "B 后来的输入");
  assert.equal(s.views.length, count);
  assert.equal(s.view().sessionId, "b");
  s.select("a"); await s.controller.switchTo("a");
  assert.equal(s.input.value, "  后来输入\n");
  assert.equal(s.view().pendingSend, null);
});
```

## 6. 验证

在项目根目录执行：

```bash
node --check src/renderer/components/composer-persistence.js
node --check src/renderer/renderer.js
```

```bash
node --test \
  tests/unit/composer-send-dismiss-ui.test.js \
  tests/unit/composer-persistence.test.js \
  tests/unit/composer-send-reconcile.test.js \
  tests/unit/composer-draft-send-queue.test.js \
  tests/unit/composer-draft-queue.test.js \
  tests/unit/composer-draft-restore.test.js \
  tests/unit/composer-drafts.test.js
```

预期61项通过，其中本步新增8项。然后 `npm start`。

手动验收：

1. 有现成未确认记录时，展开原文，点击“解除发送限制…”，核对说明和默认取消焦点；点击取消或按Escape，原文及当前输入保持不变。中文输入法状态下Escape不应被页面误当成取消操作。
2. 打开确认后切换另一会话，再返回，应重新确认；旧确认不能直接处理新会话或新快照。
3. 需要保留的快照原文先自行保存，再点击“清理快照并解除”。确认快照区域消失、当前输入保留、发送恢复，并且没有自动发起聊天请求。
4. 等输入已保存后，重新打开同一条已有历史的会话，检查后来的输入仍在，已清理快照不再阻塞。
5. 缩窄窗口，检查说明可滚动、取消与确认都能用键盘到达，按钮不引起整页横向溢出。正常聊天、停止、项目切换及文件草稿操作继续可用。

没有现成未确认记录时，不必破坏配置、删除状态文件或故意触发真实付费请求失败来制造；本轮候选已用模拟请求和临时状态验证异常分支。用户写完后助手仍需核对实际接线；模拟验证不替代用户真实界面验收。

## 7. 候选验证与后续边界

临时副本：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-dismiss-ui-l_biuotn`。基于HEAD与实际整个渲染层、实际三个后端接线文件，再应用本指南候选；使用模拟会话/请求及真实临时状态存储，不读取真实配置或会话、不请求模型、不写真实剪贴板。

组件两个脚本语法检查及8项新增加输入回归61项通过；23项Electron整页模拟检查全部通过，已查看1120和375截图；覆盖原有14项以及确认取消、跨会话确认失效、单次清理保留新输入、重载恢复、写入失败与重新确认、返回及核对均失败后的只读重试、返回丢失补核对、新快照保护和三档确认区布局。实际前端和8项测试尚未由助手改写或创建，用户完成后还需核对实际文件。

本步完成后继续空会话登记与重建、正常关闭前补保存，之后再做置顶归档与上下文常驻入口。尚不能称为完整输入草稿重启恢复。

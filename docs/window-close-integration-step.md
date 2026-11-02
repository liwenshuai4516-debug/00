# 下一步：关闭前保存与应用退出完整接线

状态：使用者已亲手完成本页关闭协调、主进程/预加载/页面接线及专项测试，并修正启动专项的顺序断言。2026-11-02实际工作区与仅含本次功能的精确提交副本均通过12个脚本语法检查、15文件119项单元检查和14+19+27项Electron检查。下一步见 `docs/window-close-acceptance.md` 做真实关窗与重启验收；以下代码保留供对照，不重复实施。

本轮假设：关闭时停止正在生成的回复、取消正在进行的上下文整理，等待原操作和输入协调全部收尾，再保存本页面已访问会话的输入；保存成功才关闭，失败保留窗口、输入与文件草稿。系统文件选择窗口已打开时，需要先由使用者完成或取消选择。未确认发送快照沿用现有含义，不清理或重新发送。

1. 接页面协调、受限预加载和等待界面 → 验证：先监听再ready，冻结新操作，慢保存及旧会话失败记录不能提前放行，失败恢复交互与焦点。
2. 接主进程与应用退出 → 验证：普通关闭、重复关闭、Command+Q、失败后重试、macOS关闭后重新开窗都走同一保存握手。
3. 针对性检查与真实验收 → 验证：候选12个脚本语法、15文件119项单元检查及14+19+27项Electron模拟；实际实现后重新执行，再记录真实重启结果。

以下按当时的手写顺序保留，实际接线现已完成。原`closed`停止兜底、原输入自动保存及`pagehide`释放继续保留；后续修改同样需要保证页面确认逻辑先就绪。

## 1. 新建页面关闭协调模块

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/components/window-close-controller.js`，完整内容如下：

```javascript
// 页面仍用原忙碌状态收尾；关闭状态只阻止新操作，不冒充当前操作结束。
export function createWindowCloseController({ api, readState, flushAll, setClosing, onError }) {
  let active = false;
  let disposed = false;
  let wake = null;

  function notify() {
    wake?.();
  }

  async function prepare(requestId) {
    if (disposed || active || typeof requestId !== "string" || !requestId) return;
    active = true;
    try {
      setClosing(true);
      let stopped = false;
      let canceled = false;
      for (;;) {
        if (disposed) return;
        const state = readState();
        if (!state.busy) break;
        // 先订阅变化，再停止，避免漏掉停止期间已经完成的操作。
        const changed = new Promise(resolve => { wake = resolve; });
        if (state.generating && !stopped) {
          stopped = true;
          await api.stop();
        } else if (state.compacting && !canceled) {
          canceled = true;
          await api.cancelCompaction();
        } else {
          await changed;
        }
        wake = null;
      }
      await flushAll();
      if (!disposed) api.reportCloseResult(requestId, true);
      // 成功后保持冻结，直到主进程真正关闭；不释放输入组件。
    } catch (error) {
      if (disposed) return;
      try {
        api.reportCloseResult(requestId, false);
      } finally {
        active = false;
        setClosing(false);
        onError(error);
      }
    }
  }

  // 必须先订阅，再报告就绪；ready不是保存成功确认。
  const unsubscribe = api.onPrepareClose(requestId => { void prepare(requestId); });
  api.closeReady();

  return {
    notify,
    dispose() {
      disposed = true;
      unsubscribe();
      notify();
    },
  };
}
```

`readState().busy`读取原页面操作与输入法状态；关闭冻结独立维护，不会把“冻结页面”当成仍有原操作。等待过程中如果发送前保存结束后才开始生成，`notify()`会唤醒协调器，再请求停止。

停止接口返回不代表发送已经全部收尾，仍要等原页面`finally`恢复原忙碌状态。输入组件在这之后由`flushAll()`自行检查凭证、读取和队列状态。没有完成通知时继续保留窗口，不以超时自动批准。

## 2. 给已有主进程守卫补退出取消通知

将 `/Users/liyingjun/Desktop/SW-QA/17-00/src/main/lifecycle/window-close-guard.js` 的内容替换为以下完整代码。与刚完成的版本相比，只增加可选`onBlocked`回调，并在通知送达失败、页面明确保存失败、未完成握手期间整页导航或页面异常退出时通知应用退出流程。原13项专项继续保留。

```javascript
const { randomUUID } = require("node:crypto");

// 只负责关闭握手；停止生成、等待页面操作和保存输入由页面接线负责。
function registerWindowCloseGuard(window, ipcMain, onBlocked = () => {}) {
  const contents = window.webContents;
  let ready = false;
  let pendingId = null;
  let approved = false;

  function isMainFrame(event) {
    return event.sender === contents && event.senderFrame === contents.mainFrame;
  }

  function sendRequest() {
    if (!ready || !pendingId) return;
    try {
      contents.send("agent:prepare-close", pendingId);
    } catch {
      // 没收到确认就保留窗口；新页面准备好后可重新发起关闭。
      ready = false;
      pendingId = null;
      onBlocked();
      console.error("关闭准备通知未送达，窗口已保留。");
    }
  }

  function onClose(event) {
    if (approved) return;
    event.preventDefault();
    if (pendingId) return;
    pendingId = randomUUID();
    sendRequest();
  }

  function onReady(event) {
    if (!isMainFrame(event) || ready) return;
    ready = true;
    // 页面尚未就绪时点击关闭，也必须等监听与保存逻辑准备完成。
    sendRequest();
  }

  function onResult(event, result) {
    if (
      !isMainFrame(event) || !pendingId ||
      result?.requestId !== pendingId || typeof result.saved !== "boolean"
    ) return;
    pendingId = null;
    if (!result.saved) {
      onBlocked();
      return;
    }
    if (window.isDestroyed()) return;
    // 只放行这次同步close；若被其他监听器取消，下次仍须重新保存。
    approved = true;
    try {
      window.close();
    } finally {
      approved = false;
    }
  }

  function resetPage() {
    if (pendingId) onBlocked();
    ready = false;
    pendingId = null;
  }

  function onNavigation(_event, _url, isInPlace, isMain) {
    if (isMain && !isInPlace) resetPage();
  }

  function cleanup() {
    resetPage();
    window.removeListener("close", onClose);
    ipcMain.removeListener("agent:close-ready", onReady);
    ipcMain.removeListener("agent:close-result", onResult);
    contents.removeListener("did-start-navigation", onNavigation);
    contents.removeListener("render-process-gone", resetPage);
  }

  window.on("close", onClose);
  window.once("closed", cleanup);
  ipcMain.on("agent:close-ready", onReady);
  ipcMain.on("agent:close-result", onResult);
  contents.on("did-start-navigation", onNavigation);
  contents.on("render-process-gone", resetPage);
}

module.exports = { registerWindowCloseGuard };
```

不要用`window.close()`返回后的`!window.isDestroyed()`判断关闭失败：真实Electron窗口可能在后续事件中才销毁。页面明确回报保存失败才取消此次退出，成功关闭的完成由`closed`事件确认。

## 3. 新建应用退出守卫

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/src/main/lifecycle/app-quit-guard.js`，完整内容如下：

```javascript
// 应用退出也经过每个窗口已有的关闭握手；失败后取消本次退出。
function registerAppQuitGuard(app, BrowserWindow, platform = process.platform) {
  let quitting = false;

  app.on("browser-window-created", (_event, window) => {
    window.once("closed", () => {
      if (!quitting) return;
      // app.quit路径可能不发window-all-closed；等窗口移出列表再继续退出。
      setImmediate(() => {
        if (quitting && BrowserWindow.getAllWindows().length === 0) app.quit();
      });
    });
  });

  app.on("before-quit", event => {
    const windows = BrowserWindow.getAllWindows();
    if (!windows.length) {
      quitting = false;
      return;
    }
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    for (const window of windows) {
      if (!quitting) break;
      if (!window.isDestroyed()) window.close();
    }
  });

  app.on("window-all-closed", () => {
    if (quitting || platform !== "darwin") app.quit();
  });

  return {
    isQuitting: () => quitting,
    cancelQuit() { quitting = false; },
  };
}

module.exports = { registerAppQuitGuard };
```

`app.quit()`可能不触发普通的`window-all-closed`，所以还要监听每个新窗口的`closed`，等窗口真正移出列表后再继续退出。重复退出合并；失败时由第2节回调清除退出标记。macOS普通关闭窗口仍保留进程，原有activate及单实例重新开窗逻辑继续使用。

## 4. 预加载增加固定关闭接口

打开 `/Users/liyingjun/Desktop/SW-QA/17-00/src/preload/preload.js`，紧接着以下原有行后插入代码，其他接口保留：

```javascript
contextBridge.exposeInMainWorld("agent", {
```

```javascript
  // 固定关闭协议；不向页面暴露 Electron 事件或通用 send。
  closeReady: () => ipcRenderer.send("agent:close-ready"),
  onPrepareClose: (callback) => {
    const listener = (_event, requestId) => {
      if (typeof requestId === "string" && requestId) callback(requestId);
    };
    ipcRenderer.on("agent:prepare-close", listener);
    return () => ipcRenderer.removeListener("agent:prepare-close", listener);
  },
  reportCloseResult: (requestId, saved) => {
    if (typeof requestId !== "string" || !requestId || typeof saved !== "boolean") {
      throw new Error("关闭保存确认无效。");
    }
    ipcRenderer.send("agent:close-result", { requestId, saved });
  },
```

页面只能报告无参数ready、接收字符串请求编号、回报同一编号和布尔保存结果。不要暴露通用`send`、`ipcRenderer`或Electron事件；关闭通道由窗口守卫管理，不在`agent-ipc.js`重复注册。

## 5. 添加关闭等待模态窗口与样式

在 `/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/index.html` 中找到文件末尾的：

```html
  <!-- 业务入口保留；页面外壳仅管理本地展示。 -->
```

在这一行之前插入以下完整片段，保留原脚本顺序：

```html
  <!-- 原生模态窗口阻止键盘、鼠标及已有配置弹窗中的新操作。 -->
  <dialog id="window-close-dialog" class="window-close-dialog"
    aria-labelledby="window-close-title" aria-describedby="window-close-status">
    <h2 id="window-close-title" tabindex="-1" autofocus>正在准备关闭</h2>
    <p id="window-close-status" role="status" aria-live="polite">
      正在等待当前操作结束并保存输入。若系统文件选择窗口仍打开，请先完成或取消选择。
    </p>
  </dialog>
```

在 `/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/styles/codex-theme.css` 的文件末尾追加：

```css
/* 关闭等待沿用当前深色主题；错误后关闭模态窗口并恢复原操作入口。 */
.window-close-dialog {
  width: min(420px, calc(100vw - 48px));
  box-sizing: border-box;
  padding: calc(var(--space) * 2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}
.window-close-dialog::backdrop {
  background: rgb(0 0 0 / 45%);
}
.window-close-dialog h2 { margin-top: 0; font-size: 18px; }
.window-close-dialog p { margin-bottom: 0; color: var(--muted); line-height: 1.6; }
.window-close-dialog :focus-visible { outline: 2px solid var(--focus); outline-offset: 4px; }
```

原生`showModal()`会阻止背景的鼠标和键盘操作，也覆盖已有的模型配置模态窗口。关闭等待期间Escape不跳过保存；失败关闭等待窗口并返回原焦点。样式沿用已核对的深色主题变量；以ui-ux-pro-max核对模态提示、可见焦点与窄窗布局。

## 6. 页面接线（共5处）

打开 `/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/renderer.js`。

### 6.1 新增导入

在已有`createComposerPersistence`导入后添加：

```javascript
import { createWindowCloseController } from "./components/window-close-controller.js";
```

### 6.2 增加关闭与输入法状态

在原有`let pageGenerating = false;`后插入下列完整代码，后面的`composerState`等声明保留。不要把原`pageBusy`改成关闭状态。

```javascript
let closing = false;
let composing = false;
let closeController = null;
const closeDialog = document.getElementById("window-close-dialog");
let focusBeforeClose = null;

// 不在输入法组词尚未结束时确认保存；模态窗口会使输入框失焦。
input.addEventListener("compositionstart", () => { composing = true; });
input.addEventListener("compositionend", () => {
  composing = false;
  closeController?.notify();
});
closeDialog.addEventListener("cancel", event => event.preventDefault());

function setClosing(value) {
  closing = value;
  setBusy(pageBusy, pageGenerating);
  if (value) {
    focusBeforeClose = document.activeElement;
    closeDialog.showModal();
  } else {
    closeDialog.close();
    const target = focusBeforeClose;
    if (target?.isConnected && !target.disabled) target.focus();
    else input.focus();
  }
}
```

输入法结束通知也唤醒等待；不能在仍组词时宣称最后输入已经保存。此处不会改写原输入，不会清空未保存配置字段。

### 6.3 替换输入状态渲染函数

从`function renderComposerState() {`这一行开始，到该函数末尾、`const composerPersistence =`前为止，替换为以下完整函数：

```javascript
function renderComposerState() {
  const busy = pageBusy || closing;
  const message = composerState.message || "正在读取输入……";
  if (composerStatus.textContent !== message)
    composerStatus.textContent = message;
  composerRetry.hidden = !composerState.retryable;
  composerRetry.disabled = busy;
  sendButton.disabled = busy || !composerState.canSend;

  // 生成中的临时快照等待请求结束后再展示，避免误报为异常。
  const pending = pageGenerating ? null : composerState.pendingSend;
  unconfirmedSend.hidden = !pending;
  if (shownSendId !== pending?.id) unconfirmedSend.open = false;
  shownSendId = pending?.id ?? null;
  unconfirmedText.textContent = pending?.text ?? "";
  // 确认只属于打开时的会话和快照；切换后必须重新核对。
  if (
    dismissTarget &&
    (dismissTarget.sessionId !== composerState.sessionId ||
      dismissTarget.sendId !== pending?.id)
  ) {
    dismissTarget = null;
  }
  const disabled = busy || !composerState.canDismiss;
  dismissSendButton.disabled = disabled;
  dismissAccept.disabled = disabled;
  dismissCancel.disabled = busy;
  dismissConfirm.hidden = !dismissTarget;
  dismissSendButton.setAttribute(
    "aria-expanded",
    String(Boolean(dismissTarget)),
  );
}
```

### 6.4 替换统一忙碌函数

从`function setBusy(busy, generating = false) {`开始，到该函数结束、`// 用历史消息替换当前页面内容。`前为止，替换为：

```javascript
function setBusy(busy, generating = false) {
  pageBusy = busy;
  pageGenerating = generating;
  const blocked = busy || closing;
  // 关闭冻结与原操作忙碌分别保存；原 finally 不能提前解除关闭冻结。
  proposalPanelElement.disabled = blocked;
  modelSelector.setBusy(blocked);
  modelSettingsPanel.setBusy(blocked);
  renderComposerState();
  newChatButton.disabled = blocked;
  selectWorkspaceButton.disabled = blocked;
  compactSessionButton.disabled = blocked;
  exportConversationButton.disabled = blocked;
  sessionList.setBusy(blocked);
  unsentSessionList.setBusy(blocked);
  projectPanel.setBusy(blocked);
  stopButton.disabled = closing || !generating;
  renameButton.disabled = blocked;
  closeController?.notify();
}
```

原操作仍以`pageBusy`记录；控件按`busy || closing`禁用。已有操作的`finally`可以正常结束，但不能解除关闭冻结。不要在关闭时直接调用`setBusy(false)`冒充收尾完成。

### 6.5 在整个renderer.js文件末尾建立关闭监听

保留已有初始化调用、表单/按钮处理和原`pagehide`释放，在全部原代码之后追加：

```javascript
// 所有组件与事件均已建立后再报告就绪；初始化未结束时也会等待。
closeController = createWindowCloseController({
  api: window.agent,
  readState: () => ({
    busy: pageBusy || composing,
    generating: pageGenerating,
    compacting: !cancelCompactionButton.hidden,
  }),
  flushAll: () => composerPersistence.flushAll(),
  setClosing,
  onError: (error) => {
    setRequestStatus("关闭前保存未完成，窗口与输入已保留；处理后可再次关闭。");
    addMessage("error", `关闭前保存失败：${error.message}`);
  },
});
window.addEventListener("pagehide", () => closeController.dispose(), { once: true });
```

只有监听建立后才报告ready。初始历史尚未加载完时，协调器同样等待；发送前保存、生成、整理、会话切换、解除快照和模型/文件操作均继续由原忙碌流程收尾。

不把保存放进`pagehide`，也不在成功回报后立即`dispose()`输入组件：只有实际离开页面才释放。保存失败则组件、输入、已登记的旧会话和文件草稿继续保留。

## 7. 最后接bootstrap

打开 `/Users/liyingjun/Desktop/SW-QA/17-00/src/main/bootstrap.js`。

### 7.1 在原registerWindowLifecycle导入后增加

```javascript
const { registerWindowCloseGuard } = require("./lifecycle/window-close-guard.js");
const { registerAppQuitGuard } = require("./lifecycle/app-quit-guard.js");
```

### 7.2 创建退出守卫并保护新开窗

找到`function createWindow() {`，将该行替换为下面片段，后面的`const window = new BrowserWindow({ ... })`及配置保留：

```javascript
const quitGuard = registerAppQuitGuard(app, BrowserWindow);

function createWindow() {
  // 退出进行中不再创建新窗口；失败取消退出后仍可正常重新打开。
  if (quitGuard.isQuitting()) return;
```

### 7.3 在每次loadFile前安装窗口守卫

保留原`registerWindowLifecycle(window, { ... })`整段。在其后的`window.loadFile(...)`前添加：

```javascript
  registerWindowCloseGuard(window, ipcMain, quitGuard.cancelQuit);
```

两个守卫之间没有注册先后依赖；已把关闭守卫放在`registerWindowLifecycle()`之前的实现同样有效，只要两者都在`loadFile()`之前。启动专项已修正为检查这一实际约束，避免把无关顺序写死。

### 7.4 删除旧window-all-closed注册

只删除下面这一整段，它已由新应用退出守卫接管。保留`app.whenReady()`、`activate`及底部`module.exports`，`main.js`无需修改。

```javascript
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

## 8. 新建4个单元测试文件

以下测试不启动真实模型、不读.env或真实会话；退出测试同时覆盖“没有window-all-closed”和“close返回时窗口尚未销毁”的原生事件顺序。

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/window-close-controller.test.js`，完整内容如下：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(t, options = {}) {
  const { createWindowCloseController } = await import("../../src/renderer/components/window-close-controller.js");
  const calls = [];
  const state = { busy: false, generating: false, compacting: false };
  let listener;
  const api = {
    onPrepareClose(callback) { calls.push("subscribe"); listener = callback; return () => calls.push("unsubscribe"); },
    closeReady() { calls.push("ready"); },
    reportCloseResult(id, saved) { calls.push([id, saved]); },
    async stop() { calls.push("stop"); await options.stop?.(); },
    async cancelCompaction() { calls.push("cancel"); await options.cancel?.(); },
  };
  const controller = createWindowCloseController({
    api, readState: () => state,
    async flushAll() { calls.push("flush"); await options.flush?.(); },
    setClosing(value) { calls.push(["closing", value]); },
    onError(error) { calls.push(["error", error.message]); },
  });
  t.after(() => controller.dispose());
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return {
    state, calls, controller, tick,
    request: id => listener(id),
    update(value) { Object.assign(state, value); controller.notify(); },
    results: () => calls.filter(item => Array.isArray(item) && item[0] !== "closing" && item[0] !== "error"),
  };
}

test("先监听再就绪；保存完成前不确认，成功后保留冻结", async t => {
  const gate = Promise.withResolvers();
  const s = await setup(t, { flush: () => gate.promise });
  assert.deepEqual(s.calls, ["subscribe", "ready"]);
  s.request("one"); await s.tick();
  assert.deepEqual(s.results(), []);
  assert.deepEqual(s.calls.slice(2), [["closing", true], "flush"]);
  gate.resolve(); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
  assert.equal(s.calls.some(item => item?.[0] === "closing" && item[1] === false), false);
});

test("保存失败回报false并恢复；再次关闭使用新编号重试", async t => {
  let fail = true;
  const s = await setup(t, { flush() { if (fail) throw Error("磁盘失败"); } });
  s.request("one"); await s.tick();
  assert.deepEqual(s.calls.slice(-3), [["one", false], ["closing", false], ["error", "磁盘失败"]]);
  fail = false; s.request("two"); await s.tick();
  assert.deepEqual(s.results(), [["one", false], ["two", true]]);
});

test("普通操作完成之前等待，重复关闭不另起保存", async t => {
  const s = await setup(t);
  s.update({ busy: true }); s.request("one"); s.request("one"); s.request("two");
  await s.tick(); assert.equal(s.calls.includes("flush"), false);
  s.update({ busy: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
  assert.equal(s.calls.filter(item => item === "flush").length, 1);
});

test("生成中关闭先停止，停止返回仍等待发送及输入协调的收尾", async t => {
  const s = await setup(t);
  s.update({ busy: true, generating: true }); s.request("one"); await s.tick();
  assert.equal(s.calls.filter(item => item === "stop").length, 1);
  assert.equal(s.calls.includes("flush"), false);
  s.update({ generating: false }); await s.tick();
  assert.equal(s.calls.includes("flush"), false);
  s.update({ busy: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("发送前保存阶段关闭，随后开始生成时也会停止", async t => {
  const s = await setup(t);
  s.update({ busy: true }); s.request("one"); await s.tick();
  assert.equal(s.calls.includes("stop"), false);
  s.update({ generating: true }); await s.tick();
  assert.equal(s.calls.includes("stop"), true);
  assert.equal(s.calls.includes("flush"), false);
  s.update({ busy: false, generating: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("整理中关闭取消整理，等待原操作结束才保存", async t => {
  const s = await setup(t);
  s.update({ busy: true, compacting: true }); s.request("one"); await s.tick();
  assert.equal(s.calls.includes("cancel"), true);
  assert.equal(s.calls.includes("flush"), false);
  s.update({ busy: false, compacting: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("停止或取消失败不继续确认保存，并允许再次尝试", async t => {
  for (const compacting of [false, true]) {
    let fail = true;
    const action = () => { if (fail) throw Error("停止失败"); };
    const s = await setup(t, { stop: action, cancel: action });
    s.update({ busy: true, generating: !compacting, compacting });
    s.request("one"); await s.tick();
    assert.deepEqual(s.results(), [["one", false]]);
    assert.equal(s.calls.includes("flush"), false);
    fail = false; s.request("two"); await s.tick();
    s.update({ busy: false, generating: false, compacting: false }); await s.tick();
    assert.deepEqual(s.results(), [["one", false], ["two", true]]);
  }
});

test("停止期间已经收尾的变化不丢失", async t => {
  const gate = Promise.withResolvers();
  const s = await setup(t, { stop: () => gate.promise });
  s.update({ busy: true, generating: true }); s.request("one");
  s.update({ busy: false, generating: false }); gate.resolve(); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("读取或输入法收尾仍忙时等待，直到通知就绪", async t => {
  const s = await setup(t);
  s.update({ busy: true }); s.request("one"); await s.tick();
  assert.deepEqual(s.results(), []);
  s.update({ busy: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("离开页面时移除监听，旧保存返回不能再确认关闭", async t => {
  const gate = Promise.withResolvers();
  const s = await setup(t, { flush: () => gate.promise });
  s.request("one"); s.controller.dispose(); gate.resolve(); await s.tick();
  assert.equal(s.calls.includes("unsubscribe"), true);
  assert.deepEqual(s.results(), []);
});

test("等待操作期间离开页面不再保存，无效请求不触发准备", async t => {
  const s = await setup(t);
  for (const value of [null, "", 1, {}]) s.request(value);
  assert.deepEqual(s.calls, ["subscribe", "ready"]);
  s.update({ busy: true }); s.request("one"); s.controller.dispose(); await s.tick();
  assert.equal(s.calls.includes("flush"), false);
  assert.deepEqual(s.results(), []);
});
```

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/window-close-preload.test.js`，完整内容如下：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { EventEmitter } = require("node:events");
const path = require("node:path");

test("关闭接口仅使用固定通道、允许字段和布尔确认，不暴露事件对象", () => {
  const ipcRenderer = new EventEmitter(), sent = [];
  ipcRenderer.send = (...args) => sent.push(args);
  let api;
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require() { return { ipcRenderer, contextBridge: { exposeInMainWorld(_name, value) { api = value; } } }; },
  });
  api.closeReady("forged");
  api.reportCloseResult("one", false, "/forged", "原文");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    ["agent:close-ready"], ["agent:close-result", { requestId: "one", saved: false }],
  ]);
  for (const value of [undefined, 1, "true", null]) assert.throws(() => api.reportCloseResult("one", value));
  for (const id of [null, 1, ""]) assert.throws(() => api.reportCloseResult(id, true));
  const received = [];
  const unsubscribe = api.onPrepareClose((...args) => received.push(args));
  const unrelated = () => {};
  ipcRenderer.on("agent:prepare-close", unrelated);
  ipcRenderer.emit("agent:prepare-close", { secret: "event" }, "one");
  ipcRenderer.emit("agent:prepare-close", {}, {});
  assert.deepEqual(received, [["one"]]);
  unsubscribe(); assert.deepEqual(ipcRenderer.listeners("agent:prepare-close"), [unrelated]);
});
```

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/app-quit-guard.test.js`，完整内容如下：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { registerAppQuitGuard } = require("../../src/main/lifecycle/app-quit-guard.js");
const { registerWindowCloseGuard } = require("../../src/main/lifecycle/window-close-guard.js");

function setup(platform = "darwin", emitAllClosed = true, deferredClose = false) {
  const app = new EventEmitter(), ipcMain = new EventEmitter(), windows = [];
  let exits = 0;
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  app.quit = () => {
    const e = event(); app.emit("before-quit", e);
    if (!e.prevented) exits += 1;
  };
  const guard = registerAppQuitGuard(app, { getAllWindows: () => windows.slice() }, platform);
  function add() {
    const window = new EventEmitter(), contents = new EventEmitter(), sent = [];
    let destroyed = false;
    contents.mainFrame = {};
    contents.send = (_channel, id) => sent.push(id);
    window.webContents = contents;
    window.isDestroyed = () => destroyed;
    window.close = () => {
      const e = event(); window.emit("close", e);
      const finish = () => {
        destroyed = true;
        windows.splice(windows.indexOf(window), 1);
        window.emit("closed");
        if (!windows.length && emitAllClosed) app.emit("window-all-closed");
      };
      if (!e.prevented) {
        if (deferredClose) setImmediate(finish);
        else finish();
      }
    };
    windows.push(window);
    app.emit("browser-window-created", {}, window);
    registerWindowCloseGuard(window, ipcMain, guard.cancelQuit);
    const own = () => ({ sender: contents, senderFrame: contents.mainFrame });
    return {
      window, contents, sent,
      ready() { ipcMain.emit("agent:close-ready", own()); },
      result(saved, id = sent.at(-1)) { ipcMain.emit("agent:close-result", own(), { requestId: id, saved }); },
    };
  }
  return { app, guard, add, exits: () => exits, windows };
}

test("macOS退出先保存，重复退出合并，最后窗口确认关闭后才退出", () => {
  const s = setup(), a = s.add(); a.ready();
  s.app.quit(); s.app.quit();
  assert.equal(s.exits(), 0); assert.equal(a.sent.length, 1);
  a.result(true);
  assert.equal(s.exits(), 1); assert.equal(a.window.isDestroyed(), true);
});

test("保存失败取消退出，旧确认无效，可继续使用并再次退出", () => {
  const s = setup(), a = s.add(); a.ready(); s.app.quit();
  const old = a.sent.at(-1); a.result(false);
  assert.equal(s.guard.isQuitting(), false); assert.equal(s.exits(), 0);
  s.app.quit(); a.result(true, old);
  assert.equal(a.window.isDestroyed(), false);
  a.result(true); assert.equal(s.exits(), 1);
});

test("退出失败后单独关窗不会意外退出macOS应用，随后可重新开窗", () => {
  const s = setup(), a = s.add(); a.ready(); s.app.quit(); a.result(false);
  a.window.close(); a.result(true);
  assert.equal(s.exits(), 0); assert.equal(s.guard.isQuitting(), false);
  const b = s.add(); b.ready(); b.window.close(); b.result(true);
  assert.equal(s.exits(), 0);
});

test("macOS普通关窗保留进程，无窗口时退出直接放行", () => {
  const s = setup(), a = s.add(); a.ready(); a.window.close(); a.result(true);
  assert.equal(s.exits(), 0); s.app.quit(); assert.equal(s.exits(), 1);
});

test("非macOS普通关闭最后窗口后自动退出", () => {
  const s = setup("win32"), a = s.add(); a.ready(); a.window.close(); a.result(true);
  assert.equal(s.exits(), 1);
});

test("多个窗口都确认后才退出，其他窗口仍保存时继续等待", () => {
  const s = setup(), a = s.add(), b = s.add(); a.ready(); b.ready();
  s.app.quit(); a.result(true); assert.equal(s.exits(), 0);
  b.result(true); assert.equal(s.exits(), 1);
});

test("退出等待中页面重载或崩溃取消退出，不认旧成功", () => {
  for (const navigation of [true, false]) {
    const s = setup(), a = s.add(); a.ready(); s.app.quit(); const old = a.sent.at(-1);
    if (navigation) a.contents.emit("did-start-navigation", {}, "file:///next", false, true);
    else a.contents.emit("render-process-gone");
    assert.equal(s.guard.isQuitting(), false);
    a.result(true, old); assert.equal(s.exits(), 0);
    a.ready(); s.app.quit(); a.result(true); assert.equal(s.exits(), 1);
  }
});

test("通知送达失败取消退出，重试不被退出标记卡住", t => {
  const s = setup(), a = s.add(); a.ready();
  t.mock.method(console, "error", () => {});
  const send = a.contents.send;
  a.contents.send = () => { throw Error("模拟送达失败"); };
  s.app.quit(); assert.equal(s.guard.isQuitting(), false); assert.equal(s.exits(), 0);
  a.contents.send = send; a.ready(); s.app.quit(); a.result(true); assert.equal(s.exits(), 1);
});

test("原生退出不发window-all-closed时，最后窗口closed后仍会完成退出", async () => {
  const s = setup("darwin", false), a = s.add(); a.ready();
  s.app.quit(); a.result(true); assert.equal(s.exits(), 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.exits(), 1);
});


test("原生close返回后销毁尚未完成时不误取消退出", async () => {
  const s = setup("darwin", false, true), a = s.add(); a.ready();
  s.app.quit(); a.result(true);
  assert.equal(a.window.isDestroyed(), false);
  assert.equal(s.guard.isQuitting(), true);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.window.isDestroyed(), true);
  assert.equal(s.exits(), 1);
});
```

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/window-close-bootstrap.test.js`，完整内容如下：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

test("实际启动入口每次开窗均装守卫，退出中阻止新窗口，取消退出后可再打开", () => {
  const calls = [], ipcMain = {}, app = {
    getPath: () => "/temporary/user-data",
    whenReady: () => ({ then() {} }),
    on() {},
  };
  let quitting = false;
  const quitGuard = { isQuitting: () => quitting, cancelQuit() { quitting = false; } };
  class BrowserWindow {
    constructor() { calls.push(["window", this]); }
    loadFile(filename) { calls.push(["load", this, filename]); }
  }
  const factories = {
    registerAppQuitGuard(receivedApp, receivedWindow) {
      assert.equal(receivedApp, app); assert.equal(receivedWindow, BrowserWindow);
      calls.push(["quit-guard"]); return quitGuard;
    },
    registerWindowLifecycle(window) { calls.push(["lifecycle", window]); },
    registerWindowCloseGuard(window, receivedIpc, onBlocked) {
      assert.equal(receivedIpc, ipcMain); assert.equal(onBlocked, quitGuard.cancelQuit);
      calls.push(["close-guard", window]);
    },
  };
  const module = { exports: {} };
  runInNewContext(readFileSync(path.join(__dirname, "../../src/main/bootstrap.js"), "utf8"), {
    __dirname: path.join(__dirname, "../../src/main"), module,
    process: { env: {}, platform: "darwin" },
    require(name) {
      if (name === "node:path") return path;
      if (name === "node:process") return { loadEnvFile() {} };
      if (name === "electron") return { app, BrowserWindow, ipcMain };
      return new Proxy({}, { get: (_target, key) => factories[key] ?? (() => ({})) });
    },
  });
  // 两个守卫均须在加载页面前注册；它们之间没有先后依赖。
  function assertWindowSetup(offset) {
    const setup = calls.slice(offset);
    assert.equal(setup.length, 4);
    assert.equal(setup[0][0], "window");
    assert.equal(setup[3][0], "load");
    assert.deepEqual(
      setup.slice(1, 3).map(item => item[0]).sort(),
      ["close-guard", "lifecycle"],
    );
    const window = setup[0][1];
    for (const call of setup.slice(1)) assert.equal(call[1], window);
    return window;
  }

  assert.deepEqual(calls, [["quit-guard"]]);
  module.exports.createWindow();
  const first = assertWindowSetup(1);
  quitting = true; module.exports.createWindow(); assert.equal(calls.length, 5);
  quitGuard.cancelQuit(); module.exports.createWindow();
  const second = assertWindowSetup(5);
  assert.notEqual(second, first);
});
```

## 9. 新建原生窗口与实际页面专项，并更新侧栏替身

新专项使用实际renderer/preload/IPC和实际Electron窗口/关闭守卫，但会话与模型均为本地模拟；输入记录只保存在进程内Map。每次使用临时userData，并禁用HTTP/HTTPS，绝不加载实际bootstrap或真实配置/会话。保存/停止异常只由模拟接口注入，不能通过破坏真实配置制造故障。

注意：测试最后会调用测试进程自身的`app.quit()`，校验保存完成后正常退出；不会退出你已经运行的应用。这个专项的输入法检查派发模拟composition事件，不等同于真实系统输入法验收。

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/ui/window-close-page.check.cjs`，完整内容如下：

```javascript
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temporary = mkdtempSync(path.join(os.tmpdir(), "window-close-ui-"));
const { app, BrowserWindow, ipcMain } = require("electron");
const root = path.resolve(__dirname, "../..");
const { registerAgentIpc } = require(path.join(root, "src/main/ipc/agent-ipc.js"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.commandLine.appendSwitch("disable-http-cache");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const flags = {}, calls = [], drafts = new Map();
const entry = id => {
  if (!drafts.has(id)) drafts.set(id, { sessionId: id, text: "", revision: 0 });
  return drafts.get(id);
};
Object.assign(entry("a"), { text: "原输入", revision: 1 });
Object.assign(entry("b"), { text: " 完整原文\r\n第二行 \n", revision: 2 });
Object.assign(entry("c"), { text: "", revision: 3 });
let runningCompaction;
let current = "a", workspace = "/qa/one", serial = 0, generating = false, runningGate;
const history = id => id === "b" ? [] : [{ role: "user", text: `保留消息 ${id}` }];
const failure = name => { if (flags[name]) { flags[name] = false; throw Error(`模拟${name}失败`); } };
const pause = async name => { if (flags[name]) { const gate = flags[name]; flags[name] = null; await gate.promise; } };
const session = {
  loadHistory: async () => { await pause("initGate"); return history(current); }, currentSession: async () => current,
  getSessionInfo: async () => ({ sessionId: current, workspaceDir: workspace, modelId: current === "b" ? "Pro" : "Flash", provider: "mock", contextUsage: null }),
  listModelProfiles: async () => ({ currentProfileId: current === "b" ? "pro" : "flash", profiles: [{ id:"flash", name:"Flash", provider:"mock", modelId:"Flash" },{ id:"pro",name:"Pro",provider:"mock",modelId:"Pro" }] }),
  listSessions: async () => { failure("historyList"); return ["a", "b"].map(id => ({ id, title: `对话 ${id}`, workspaceDir: workspace, updatedAt: 10 })); },
  listUnsentSessions: async () => {
    calls.push(["list",current,workspace]); await pause("listGate"); failure("list");
    if (workspace !== "/qa/one") return [];
    return ["a","b","c"].filter(id => id === "c" || entry(id).text.length).map(id => ({ id, title:id === "c" ? "待确认输入" : `摘要 ${id}`, workspaceDir:workspace, blockedReason:id === "c" ? "仍有待确认发送，暂不能重建。" : "" }));
  },
  restoreUnsentSession: async id => {
    calls.push(["restore",id,entry(current).text]); await pause("restoreGate"); failure("restore");
    assert.notEqual(id,"c"); current=id; return { sessionId:id,workspaceDir:workspace,history:history(id) };
  },
  openSession: async id => { await pause("openGate"); current=id; return history(id); },
  newChat: async () => { current=`new-${++serial}`; return current; },
  renameSession: async () => {},
  compactSession: async () => { calls.push(["compact"]); runningCompaction = flags.compactGate; await pause("compactGate"); return { history:history(current), stopped:true }; },
  cancelCompaction: async () => { calls.push(["cancel"]); failure("cancel"); runningCompaction?.resolve(); },
  previewSession: async id => ({ history:history(id) }),
};
const composer = {
  loadCurrentDraft: async () => { calls.push(["load",current]); failure("load"); return { ...entry(current) }; },
  inspectSend: async id => { calls.push(["inspect",id]); return { ...entry(id), pendingSend:null }; },
  saveDraft: async (id,text,revision) => {
    calls.push(["save",id,text]); await pause("saveGate"); failure("save");
    if (flags.failSaveIds?.has(id)) throw Error("模拟磁盘失败");
    assert.equal(revision,entry(id).revision); Object.assign(entry(id), { text,revision:revision+1 }); return { ...entry(id) };
  },
};
const chat = {
  isBusy: () => generating,
  listProposals: async () => { calls.push(["proposals",current]); failure("proposals"); return [{ id:`proposal-${current}` }]; },
  async send(text,onText,onTool,onStatus,draft,onAck) {
    calls.push(["send", current, text]); generating=true; entry(current).text=""; entry(current).revision++;
    const ack={ sessionId:current,text:"",revision:entry(current).revision,sendId:"send-1" }; onAck(ack); onText("模拟回复");
    runningGate=flags.sendGate; await pause("sendGate"); generating=false; return { outcome:"completed",stopped:true,draft:ack };
  },
  stop: async () => { calls.push(["stop"]); failure("stop"); runningGate?.resolve(); },
};
registerAgentIpc(ipcMain,session,chat,{}, {}, { exportConversation:async () => ({ canceled:true }) },
  { selectWorkspace:async () => { workspace="/qa/two"; current="other"; return { sessionId:current,workspaceDir:workspace }; } },
  { listProjects:async () => [{ id:"p",name:"测试项目",workspaceDir:"/qa/one" }],openProject:async () => { workspace="/qa/one"; current="a"; return { sessionId:current,history:history(current) }; },addProject:async () => ({ canceled:true }) },composer,{read:async()=>({profiles:[],providers:[],defaultProfileId:"",encryptionAvailable:false,environment:null})});


const { registerWindowCloseGuard } = require(path.join(root, "src/main/lifecycle/window-close-guard.js"));
const { registerAppQuitGuard } = require(path.join(root, "src/main/lifecycle/app-quit-guard.js"));
const quitGuard = registerAppQuitGuard(app, BrowserWindow);
const requests = [], results = [], errors = [], passed = [];
ipcMain.on("agent:close-result", (event, result) => results.push({ sender:event.sender.id, ...result }));
async function fresh({ beforeLoad = false } = {}) {
  current="a"; workspace="/qa/one"; generating=false; runningGate=null; runningCompaction=null;
  for (const key of Object.keys(flags)) if(key!=="initGate") delete flags[key];
  const win=new BrowserWindow({width:1120,height:820,show:false,webPreferences:{preload:path.join(root,"src/preload/preload.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]},(_d,done)=>done({cancel:true}));
  win.webContents.on("console-message", details => { if(details.level==="error") errors.push(details.message); });
  registerWindowCloseGuard(win,ipcMain,quitGuard.cancelQuit);
  const originalSend=win.webContents.send.bind(win.webContents);
  win.webContents.send=(channel,...args)=>{if(channel==="agent:prepare-close")requests.push(args[0]);return originalSend(channel,...args);};
  const closed=()=>new Promise(resolve=>win.once("closed",resolve));
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{
    const end=Date.now()+6000;
    while(!await js(code)){if(Date.now()>end)throw Error(`等待超时：${code}`);await new Promise(r=>setTimeout(r,15));}
  };
  const idle=()=>until('!document.getElementById("new-chat-button").disabled && !document.querySelector(".unsent-list-refresh").disabled');
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const edit=text=>js(`document.getElementById("message-input").value=${JSON.stringify(text)};document.getElementById("message-input").dispatchEvent(new Event("input"));`);
  const loaded=win.loadFile(path.join(root,"src/renderer/index.html"));
  if(beforeLoad)win.close();
  await loaded;
  return {win,js,until,idle,click,edit,closed};
}
async function check(name,fn){await fn();passed.push(name);console.log("通过",name);}
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
async function main(){
  await app.whenReady();
  await check("未满自动保存间隔的最后编辑先落盘再关闭",async()=>{
    const s=await fresh();await s.idle();await s.edit("关闭前最后输入 中文\n第二行");
    const done=s.closed();s.win.close();await done;
    assert.equal(entry("a").text,"关闭前最后输入 中文\n第二行");assert.equal(results.at(-1).saved,true);
  });
  await check("慢保存期间保持模态冻结，重复关闭合并，成功后再关窗",async()=>{
    const s=await fresh();await s.idle();await s.edit("等待保存");flags.saveGate=Promise.withResolvers();const gate=flags.saveGate;
    const count=requests.length;const done=s.closed();s.win.close();s.win.close();
    await s.until('document.getElementById("window-close-dialog").open');
    assert.equal(s.win.isDestroyed(),false);assert.equal(requests.length,count+1);
    assert.equal(await s.js('document.getElementById("new-chat-button").disabled && document.getElementById("send-button").disabled'),true);
    await s.js('document.getElementById("window-close-dialog").dispatchEvent(new Event("cancel",{cancelable:true}))');
    assert.equal(await s.js('document.getElementById("window-close-dialog").open'),true);
    for(const width of [1120,760,375]){
      s.win.setContentSize(width,820);await tick();
      assert.equal(await s.js('document.documentElement.scrollWidth <= innerWidth+1'),true);
      assert.equal(await s.js('document.getElementById("window-close-dialog").contains(document.activeElement)'),true);
      await fs.writeFile(path.join(temporary,`close-${width}.png`),(await s.win.webContents.capturePage()).toPNG());
    }
    gate.resolve();await done;assert.equal(entry("a").text,"等待保存");
  });
  await check("保存失败留窗、保留输入和文件草稿，恢复焦点后可再次关闭",async()=>{
    const s=await fresh();await s.idle();const count=await s.js('document.querySelectorAll("#proposal-list article").length');
    await s.js('document.getElementById("message-input").focus()');await s.edit("失败后保留原文");flags.failSaveIds=new Set(["a"]);
    s.win.close();await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(s.win.isDestroyed(),false);assert.equal(await s.js('document.getElementById("window-close-dialog").open'),false);
    assert.equal(await s.js('document.getElementById("message-input").value'),"失败后保留原文");
    assert.equal(await s.js('document.querySelectorAll("#proposal-list article").length'),count);
    assert.equal(await s.js('document.activeElement.id'),"message-input");
    flags.failSaveIds.clear();const done=s.closed();s.win.close();await done;assert.equal(entry("a").text,"失败后保留原文");
  });
  await check("关闭也补存本页面旧会话失败输入，失败不会漏过",async()=>{
    const s=await fresh();await s.idle();flags.failSaveIds=new Set(["a"]);await s.edit("旧会话未存");
    await s.until('document.getElementById("composer-draft-status").textContent.includes("未保存")');
    await s.click('#session-list .session-group-items button:last-child');await s.idle();assert.equal(current,"b");await s.edit("新会话输入");
    s.win.close();await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(await s.js('document.getElementById("message-input").value'),"新会话输入");
    flags.failSaveIds.clear();const done=s.closed();s.win.close();await done;
    assert.equal(entry("a").text,"旧会话未存");assert.equal(entry("b").text,"新会话输入");
  });
  await check("生成中关闭自动停止，保留生成中新输入，已消费原文不恢复",async()=>{
    const s=await fresh();await s.idle();await s.edit("已发送原文");flags.sendGate=Promise.withResolvers();
    await s.click('#send-button');await s.until('!document.getElementById("stop-button").disabled');await s.edit("生成中的新输入");
    const done=s.closed();s.win.close();await done;
    assert.equal(entry("a").text,"生成中的新输入");assert.equal(results.at(-1).saved,true);
  });
  await check("发送前保存期间关闭，等待后续生成启动并停止后才放行",async()=>{
    const s=await fresh();await s.idle();await s.edit("准备阶段原文");flags.saveGate=Promise.withResolvers();const save=flags.saveGate;
    flags.sendGate=Promise.withResolvers();const count=calls.filter(item=>item[0]==="send").length;
    await s.click('#send-button');await s.until('document.getElementById("new-chat-button").disabled');
    const done=s.closed();s.win.close();await s.until('document.getElementById("window-close-dialog").open');
    assert.equal(s.win.isDestroyed(),false);save.resolve();await done;
    assert.equal(calls.filter(item=>item[0]==="send").length,count+1);assert.equal(entry("a").text,"");
  });
  await check("整理中关闭先取消并等待原整理收尾，保留输入",async()=>{
    const s=await fresh();await s.idle();await s.edit("整理时保留");flags.compactGate=Promise.withResolvers();
    await s.click('#compact-session-button');await s.until('!document.getElementById("cancel-compaction-button").hidden');
    const done=s.closed();s.win.close();await done;assert.equal(entry("a").text,"整理时保留");assert(calls.some(item=>item[0]==="cancel"));
  });
  await check("停止失败留窗恢复生成状态，再次关闭可停止并保存",async()=>{
    const s=await fresh();await s.idle();await s.edit("停止失败原文");flags.sendGate=Promise.withResolvers();
    await s.click('#send-button');await s.until('!document.getElementById("stop-button").disabled');await s.edit("停止失败后新输入");flags.stop=true;
    s.win.close();await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(s.win.isDestroyed(),false);assert.equal(await s.js('document.getElementById("stop-button").disabled'),false);
    const done=s.closed();s.win.close();await done;assert.equal(entry("a").text,"停止失败后新输入");
  });
  await check("会话切换进行中关闭等待新编号绑定，再保存各自原文",async()=>{
    const s=await fresh();await s.idle();await s.edit("切换前A输入");flags.openGate=Promise.withResolvers();const gate=flags.openGate;
    await s.click('#session-list .session-group-items button:last-child');await s.until('document.getElementById("new-chat-button").disabled');
    const done=s.closed();s.win.close();await s.until('document.getElementById("window-close-dialog").open');
    assert.equal(s.win.isDestroyed(),false);gate.resolve();await done;
    assert.equal(entry("a").text,"切换前A输入");assert.equal(current,"b");
  });
  await check("启动初始化期间关闭仍等待读取完成再确认",async()=>{
    flags.initGate=Promise.withResolvers();const gate=flags.initGate;const s=await fresh({beforeLoad:true});
    await s.until('document.getElementById("window-close-dialog").open');assert.equal(s.win.isDestroyed(),false);
    const done=s.closed();gate.resolve();await done;assert.equal(results.at(-1).saved,true);
  });
  await check("配置对话框已打开时关闭冻结全部交互，失败后仍能继续配置",async()=>{
    const s=await fresh();await s.idle();
    // 保留已有配置窗口，检查关闭模态冻结与失败恢复。
    await s.click('#model-settings-button');await s.until('document.getElementById("model-settings-dialog").open');
    await s.edit("配置窗口下的输入");flags.failSaveIds=new Set(["a"]);s.win.close();
    await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(await s.js('document.getElementById("model-settings-dialog").open'),true);
    flags.failSaveIds.clear();const done=s.closed();s.win.close();await done;
  });
  await check("输入法组词未结束时不确认，结束后的最新文字落盘",async()=>{
    const s=await fresh();await s.idle();await s.js('document.getElementById("message-input").dispatchEvent(new CompositionEvent("compositionstart"))');
    s.win.close();await s.until('document.getElementById("window-close-dialog").open');await tick();assert.equal(s.win.isDestroyed(),false);
    const done=s.closed();await s.edit("最后中文组词");await s.js('document.getElementById("message-input").dispatchEvent(new CompositionEvent("compositionend"))');await done;
    assert.equal(entry("a").text,"最后中文组词");
  });
  await check("原生退出保存失败取消退出，随后普通关窗不意外退出macOS进程",async()=>{
    const s=await fresh();await s.idle();await s.edit("退出失败待保存");flags.failSaveIds=new Set(["a"]);app.quit();
    await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(quitGuard.isQuitting(),false);flags.failSaveIds.clear();const done=s.closed();s.win.close();await done;
    assert.equal(quitGuard.isQuitting(),false);
  });
  const s=await fresh();await s.idle();await s.edit("最终原生退出输入");
  app.once("will-quit",()=>{
    assert.equal(entry("a").text,"最终原生退出输入");assert.equal(s.win.isDestroyed(),true);
    passed.push("原生应用退出等待页面保存，最终关闭后退出");
    require("node:fs").writeFileSync(path.join(temporary,"report.json"),JSON.stringify({passed,errors},null,2));
    console.log(`通过 ${passed.length} 项关闭页面模拟检查；截图与报告：${temporary}`);
  });
  app.quit();
}
const timeout=setTimeout(()=>{console.error("关闭检查超时");app.exit(1);},45000);
main().catch(error=>{clearTimeout(timeout);console.error(error);app.exit(1);});
```

原侧栏检查使用专用测试预加载，需要同步新增接口，不能通过生产代码的条件判断跳过关闭流程。在 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/ui/sidebar-layout.preload.cjs` 末尾原`contextBridge.exposeInMainWorld("agent", agent);`之前插入：

```javascript
// 本专项不发关闭请求；关闭协议由window-close-page.check.cjs独立验证。
agent.closeReady = () => {};
agent.onPrepareClose = () => () => {};
agent.reportCloseResult = () => {};
```

## 10. 验证命令

在 `/Users/liyingjun/Desktop/SW-QA/17-00` 执行以下12个脚本语法检查：

```bash
node --check src/main/lifecycle/window-close-guard.js
node --check src/main/lifecycle/app-quit-guard.js
node --check src/main/bootstrap.js
node --check src/preload/preload.js
node --check src/renderer/renderer.js
node --check src/renderer/components/window-close-controller.js
node --check tests/unit/window-close-controller.test.js
node --check tests/unit/window-close-preload.test.js
node --check tests/unit/window-close-bootstrap.test.js
node --check tests/unit/app-quit-guard.test.js
node --check tests/ui/window-close-page.check.cjs
node --check tests/ui/sidebar-layout.preload.cjs
```

再运行本次涉及的15个单元测试文件，预期119项全部通过，无失败、取消或跳过：

```bash
node --test \
  tests/unit/window-close-controller.test.js \
  tests/unit/window-close-preload.test.js \
  tests/unit/window-close-bootstrap.test.js \
  tests/unit/app-quit-guard.test.js \
  tests/unit/window-close-guard.test.js \
  tests/unit/window-lifecycle.test.js \
  tests/unit/composer-close-flush.test.js \
  tests/unit/composer-persistence.test.js \
  tests/unit/composer-draft-queue.test.js \
  tests/unit/composer-draft-send-queue.test.js \
  tests/unit/composer-send-reconcile.test.js \
  tests/unit/composer-send-dismiss-ui.test.js \
  tests/unit/composer-drafts.test.js \
  tests/unit/composer-draft-ipc.test.js \
  tests/unit/context-compaction.test.js
```

独立执行三个Electron检查脚本，预期依次14、19、27项通过：

```bash
./node_modules/.bin/electron tests/ui/window-close-page.check.cjs
./node_modules/.bin/electron tests/ui/unsent-session-page.check.cjs
./node_modules/.bin/electron tests/ui/sidebar-layout.check.cjs
```

失败注入会输出“模拟磁盘失败”“模拟stop失败”等日志；只有脚本最终报告成功且进程退出码为0才算通过，超时或断言失败不能忽略。原侧栏专项若报`api.onPrepareClose is not a function`，核对第9节测试替身；不要在实际页面绕过关闭监听。

## 11. 候选验证记录与真实验收

候选目录：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-window-close-integration-g999a865`。12个脚本语法检查、15文件119项单元检查通过；实际Electron关闭14项、未发送页面19项、侧栏27项通过。关闭专项报告与1120/760/375宽度截图在`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/window-close-ui-VS10bI`，375宽度截图已查看。这是此前的候选记录；实际手写文件现已完成，最新核对见下文“实际接线收尾”。

真实使用者验收在手写和自动检查通过后进行：

1. 当前对话输入最后一段中文后立即正常关闭窗口，重新打开原会话，核对完整输入；还要覆盖主动清空后立即关闭，确认不会恢复旧文字。
2. 在两个对话分别保留输入，切换后关闭并彻底退出、重新启动，核对输入分别归原会话；没有真实历史的空会话从同目录“未发送”入口恢复。
3. 在正常使用中已经进行的生成期间关闭，确认先停止再关闭，保留生成期间新写输入；不要为测试额外发起付费请求。整理中关闭同样等待取消收尾，若没有合适的实际场景先记录为未验收。
4. 使用窗口红色关闭按钮及Command+Q各验证一次；macOS普通关窗后重新开窗仍可用，Command+Q后进程应真正退出。文件选择窗口打开时先完成或取消，不绕过在途操作。
5. 自动检查已覆盖磁盘/停止失败留窗与再次关闭重试；无需破坏本机配置、真实会话或发起真实失败请求。真实输入法组词状态关闭的表现单独观察，不把模拟composition事件当作真实IME结论。

正常关闭握手现已完成实际自动核对；此前候选通过与本轮实际检查是独立证据，均不等于真实重启/生成/系统退出已由使用者验收。强制结束、断电等只保证已经确认落盘的输入，本步不提供强制结束前保存保证。无历史且有未确认发送的专用处理入口、模型登记专用重试UI仍留待后续，不在本步清理快照或改写历史。

### 启动专项顺序断言修正（2026-11-02）

实际bootstrap先装close-guard、再装lifecycle，二者均在loadFile之前，行为有效。旧测试错误地写死lifecycle必须在前。本页第8节的window-close-bootstrap测试已调整：构造窗口在最前、加载页面在最后，中间两个守卫各一次，且绑定同一个窗口；保留IPC与取消退出回调、退出中不开窗及失败后重开等断言。

临时副本`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-close-order-check-qq32s4oh`已先复现旧失败，再验证新测试在两种合法顺序都通过；将关闭守卫放到loadFile之后的反例仍失败。当时仅修改临时测试和副本，提供测试末尾的替换建议，未改实际应用或测试；未将候选结果记为实际全链路通过。使用者现已完成该修正，本轮实际全链路核对见下文。

### 实际接线收尾（2026-11-02 最新核对）

使用者已手写完成本页应用和测试，修正后的启动专项已通过。实际12个脚本语法检查、15文件119项单元检查以及关闭14项、未发送页面19项、侧栏27项Electron模拟全部通过。实际关闭报告与截图`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/window-close-ui-K0WM4X`，未发送页面报告`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/unsent-page-ui-D9RRsY`；375宽度关闭截图已查看。

只包含HEAD与本次14个应用/测试文件相关功能的精确提交副本`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-close-integration-exact-tg01xa99`也通过同样12个语法检查、119项单元检查及14+19+27项页面检查。精确副本关闭报告`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/window-close-ui-HBYbpI`，未发送报告`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/unsent-page-ui-BHCQ1r`。

以上只使用临时userData、模拟会话和输入Map并禁用HTTP/HTTPS，不读真实.env、配置或会话，不请求模型。实际应用窗口和系统输入法未由助手操作，不把这些结果当作真实重启验收。助手未改写实际应用或测试，只精确暂存使用者已完成的关闭功能，保留相邻格式及其他视觉/业务改动。下一步按`docs/window-close-acceptance.md`记录真实界面结果，验收前不继续添加新功能。

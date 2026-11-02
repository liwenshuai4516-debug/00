# 下一步：主进程窗口关闭守卫

状态：待使用者亲手编写。上一小步flushAll已完成，实际与仅包含本次功能的提交副本均通过7个相关测试文件66项。本指南候选仅在临时副本验证，没有写入实际应用或测试。

## 目标、范围与取舍

当前窗口在closed后才停止生成，pagehide只释放输入组件。关闭握手需要在窗口真正关闭之前，让页面等待输入保存确认。

1. 新增关闭守卫 → 验证：close先preventDefault，等待当前请求保存成功才再次close；保存失败保留窗口，下一次关闭重新申请。
2. 固定请求归属 → 验证：只接受当前窗口主框架和当前请求编号的布尔确认，其他窗口、子框架及旧确认不能放行。
3. 验证重复请求及清理 → 验证：页面未就绪先等待，重复关闭合并，重载/进程异常退出作废旧请求，窗口销毁移除本守卫监听。

本步只新增一个主进程模块及专项测试，先不在bootstrap调用。原因是预加载和页面还没有保存确认接口；提前安装守卫会使实际窗口一直等待确认。先把这部分独立验证，再在下一步连同页面准备、停止生成和应用退出一起接线。

假设后续页面只有在冻结编辑、等待现有操作与发送收尾，并await composerPersistence.flushAll()成功后，才报告saved: true。主进程守卫不读取输入、不替页面保存、不改变发送快照，也不代替原closed后停止逻辑。

## 1. 新建关闭守卫

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/src/main/lifecycle/window-close-guard.js`，完整内容如下。保持原 `window-lifecycle.js` 不变。

```javascript
const { randomUUID } = require("node:crypto");

// 只负责关闭握手；停止生成、等待页面操作和保存输入由页面接线负责。
function registerWindowCloseGuard(window, ipcMain) {
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
    if (!result.saved || window.isDestroyed()) return;
    // 只放行这次同步close；若被其他监听器取消，下次仍须重新保存。
    approved = true;
    try {
      window.close();
    } finally {
      approved = false;
    }
  }

  function resetPage() {
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

主进程只生成请求编号，不把会话、目录或输入原文发给页面。ready只表示页面的监听与保存流程已准备好，不能单独作为关闭许可。

模块内部使用ipcMain.on而非handle，监听按窗口过滤并在closed移除。后续只需在每次创建窗口时调用registerWindowCloseGuard(window, ipcMain)，不要再在agent-ipc注册同一套关闭处理器。本步先不调用。

协议约定供下一步接线使用，本轮不用自行新增预加载接口：

| 方向 | 固定通道 | 数据 | 含义 |
| --- | --- | --- | --- |
| 页面到主进程 | agent:close-ready | 无 | 关闭监听与页面协调逻辑已就绪 |
| 主进程到页面 | agent:prepare-close | requestId字符串 | 为本次关闭等待保存 |
| 页面到主进程 | agent:close-result | { requestId, saved: boolean } | 成功放行；失败留窗，错误由页面展示 |

页面尚未ready时的关闭会保留一次请求，ready后才通知。没有收到确认会继续保留窗口，重复close不会另发请求；不存在超时自动批准。保存明确失败后下一次关闭使用新编号。整页导航或页面进程异常退出会清除就绪状态和旧请求，新页面必须重新ready；此模块不自动重载页面或宣称旧页面内存输入已保存。

## 2. 新建专项测试

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/window-close-guard.test.js`，完整内容如下：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { registerWindowCloseGuard } = require("../../src/main/lifecycle/window-close-guard.js");

function setup(t, ipcMain = new EventEmitter()) {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  const sent = [];
  let destroyed = false;
  contents.mainFrame = {};
  contents.send = (channel, requestId) => sent.push({ channel, requestId });
  window.webContents = contents;
  window.isDestroyed = () => destroyed;
  window.close = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    window.emit("close", event);
    if (!event.defaultPrevented) {
      destroyed = true;
      window.emit("closed");
    }
    return event;
  };
  const ownEvent = () => ({ sender: contents, senderFrame: contents.mainFrame });
  registerWindowCloseGuard(window, ipcMain);
  t.after(() => { if (!destroyed) window.emit("closed"); });
  return {
    window, contents, ipcMain, sent, ownEvent,
    ready(event = ownEvent()) { ipcMain.emit("agent:close-ready", event); },
    result(value, event = ownEvent()) { ipcMain.emit("agent:close-result", event, value); },
    last: () => sent.at(-1),
  };
}

test("页面未就绪时拦截关闭，就绪后只发送同一次请求", t => {
  const s = setup(t);
  assert.equal(s.window.close().defaultPrevented, true);
  s.window.close();
  assert.equal(s.sent.length, 0);
  s.ready(); s.ready();
  assert.equal(s.sent.length, 1);
  assert.equal(s.last().channel, "agent:prepare-close");
  assert.equal(typeof s.last().requestId, "string");
  assert.ok(s.last().requestId.length > 0);
  assert.equal(s.window.isDestroyed(), false);
});

test("只在当前请求保存成功后关闭，重复关闭和迟到确认不重复放行", t => {
  const s = setup(t);
  s.ready(); assert.equal(s.sent.length, 0);
  s.window.close(); s.window.close();
  assert.equal(s.sent.length, 1);
  let closed = 0;
  s.window.on("closed", () => { closed += 1; });
  const result = { requestId: s.last().requestId, saved: true };
  s.result(result); s.result(result);
  assert.equal(closed, 1);
  assert.equal(s.window.isDestroyed(), true);
});

test("保存失败保留窗口，新关闭使用新编号，旧成功不能放行", t => {
  const s = setup(t);
  s.ready(); s.window.close();
  const first = s.last().requestId;
  s.result({ requestId: first, saved: false });
  assert.equal(s.window.isDestroyed(), false);
  s.window.close();
  const second = s.last().requestId;
  assert.notEqual(first, second);
  s.result({ requestId: first, saved: true });
  assert.equal(s.window.isDestroyed(), false);
  s.result({ requestId: second, saved: true });
  assert.equal(s.window.isDestroyed(), true);
});

test("其他窗口和子框架不能就绪或确认，当前主框架才可响应", t => {
  const s = setup(t);
  const foreign = { sender: {}, senderFrame: s.contents.mainFrame };
  const child = { sender: s.contents, senderFrame: {} };
  s.window.close();
  s.ready(foreign); s.ready(child);
  assert.equal(s.sent.length, 0);
  s.ready();
  const result = { requestId: s.last().requestId, saved: true };
  s.result(result, foreign); s.result(result, child);
  assert.equal(s.window.isDestroyed(), false);
  s.result(result);
  assert.equal(s.window.isDestroyed(), true);
});

test("缺失或非布尔保存结果均不算确认，不生成新的请求", t => {
  const s = setup(t);
  s.ready(); s.window.close();
  const requestId = s.last().requestId;
  for (const result of [null, {}, { requestId }, { requestId, saved: 1 },
    { requestId, saved: "true" }, { requestId: "wrong", saved: true }]) {
    s.result(result);
  }
  s.window.close();
  assert.equal(s.sent.length, 1);
  assert.equal(s.window.isDestroyed(), false);
  s.result({ requestId, saved: true });
  assert.equal(s.window.isDestroyed(), true);
});

test("两个窗口共用IPC，确认不能串到另一窗口", t => {
  const ipcMain = new EventEmitter();
  const a = setup(t, ipcMain), b = setup(t, ipcMain);
  a.ready(); b.ready(); a.window.close(); b.window.close();
  assert.notEqual(a.last().requestId, b.last().requestId);
  a.result({ requestId: b.last().requestId, saved: true });
  assert.equal(b.window.isDestroyed(), false);
  a.result({ requestId: a.last().requestId, saved: true });
  assert.equal(a.window.isDestroyed(), true);
  assert.equal(b.window.isDestroyed(), false);
  b.result({ requestId: b.last().requestId, saved: true });
  assert.equal(b.window.isDestroyed(), true);
});

test("整页导航作废旧确认，新的主框架须重新就绪", t => {
  const s = setup(t);
  s.ready(); s.window.close();
  const oldId = s.last().requestId, oldEvent = s.ownEvent();
  s.contents.emit("did-start-navigation", {}, "file:///next.html", false, true);
  s.contents.mainFrame = {};
  s.result({ requestId: oldId, saved: true }, oldEvent);
  s.window.close();
  assert.equal(s.sent.length, 1);
  s.ready(oldEvent); assert.equal(s.sent.length, 1);
  s.ready(); assert.equal(s.sent.length, 2);
  s.result({ requestId: oldId, saved: true });
  assert.equal(s.window.isDestroyed(), false);
  s.result({ requestId: s.last().requestId, saved: true });
  assert.equal(s.window.isDestroyed(), true);
});

test("页面内导航和子框架导航不打断当前关闭握手", t => {
  const s = setup(t);
  s.ready(); s.window.close();
  const requestId = s.last().requestId;
  s.contents.emit("did-start-navigation", {}, "file:///page.html#part", true, true);
  s.contents.emit("did-start-navigation", {}, "file:///child.html", false, false);
  s.result({ requestId, saved: true });
  assert.equal(s.window.isDestroyed(), true);
});

test("页面进程异常退出不自动关窗，旧确认失效且重载后可重试", t => {
  const s = setup(t);
  s.ready(); s.window.close();
  const oldId = s.last().requestId;
  s.contents.emit("render-process-gone", {}, { reason: "crashed" });
  s.result({ requestId: oldId, saved: true });
  assert.equal(s.window.isDestroyed(), false);
  s.window.close(); s.ready();
  assert.notEqual(s.last().requestId, oldId);
  s.result({ requestId: s.last().requestId, saved: true });
  assert.equal(s.window.isDestroyed(), true);
});

test("窗口关闭时清理所属监听，保留其他监听", t => {
  const s = setup(t);
  const unrelated = () => {};
  s.ipcMain.on("agent:close-ready", unrelated);
  s.window.emit("closed");
  assert.equal(s.window.listenerCount("close"), 0);
  assert.deepEqual(s.ipcMain.listeners("agent:close-ready"), [unrelated]);
  assert.equal(s.ipcMain.listenerCount("agent:close-result"), 0);
  assert.equal(s.contents.listenerCount("did-start-navigation"), 0);
  assert.equal(s.contents.listenerCount("render-process-gone"), 0);
});

test("其他关闭监听器取消后，下一次仍须重新保存", t => {
  const s = setup(t);
  const veto = event => event.preventDefault();
  s.window.on("close", veto);
  s.ready(); s.window.close();
  s.result({ requestId: s.last().requestId, saved: true });
  assert.equal(s.window.isDestroyed(), false);
  s.window.removeListener("close", veto);
  assert.equal(s.window.close().defaultPrevented, true);
  assert.equal(s.sent.length, 2);
  s.result({ requestId: s.last().requestId, saved: true });
  assert.equal(s.window.isDestroyed(), true);
});

test("通知发送失败只输出固定提示并保留窗口，重新就绪后可再关闭", t => {
  const s = setup(t), logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const send = s.contents.send;
  s.contents.send = () => { throw Error("不输出的底层错误"); };
  s.ready(); s.window.close();
  assert.equal(s.window.isDestroyed(), false);
  assert.deepEqual(logs, [["关闭准备通知未送达，窗口已保留。"]]);
  s.contents.send = send;
  s.ready(); s.window.close();
  s.result({ requestId: s.last().requestId, saved: true });
  assert.equal(s.window.isDestroyed(), true);
});

test("隐藏窗口不请求保存，也不触发关闭", t => {
  const s = setup(t);
  s.ready(); s.window.emit("hide");
  assert.equal(s.sent.length, 0);
  assert.equal(s.window.isDestroyed(), false);
});
```

测试替身保留Electron的关键顺序：第一次close被阻止，成功确认触发第二次close，只有未被阻止才发closed。测试不读取.env、真实配置或会话，不请求模型，不操作实际应用窗口。

## 3. 验证

在 `/Users/liyingjun/Desktop/SW-QA/17-00` 执行：

```bash
node --check src/main/lifecycle/window-close-guard.js
node --check tests/unit/window-close-guard.test.js
node --test \
  tests/unit/window-close-guard.test.js \
  tests/unit/window-lifecycle.test.js
```

预期两个脚本语法检查通过，专项13项加原有生命周期4项，共17项全部通过，无失败、取消或跳过。现有flushAll的66项已单独核对，本步不需要例行全量npm test。

候选验证目录：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-close-guard-advice-xjw1vh93`。两个语法检查及上述17项全部通过。同一精确副本的flushAll和原输入相关7文件66项也通过。

助手另外使用临时preload、临时HTML和实际Electron BrowserWindow，对本候选做了5项原生检查：未就绪阻止close、实际IPC主框架就绪/重复关闭合并、保存失败留窗与新请求、旧成功确认失效、当前确认关闭并清理监听。临时userData、禁用HTTP/HTTPS，不加载实际bootstrap或读取真实配置/会话。这只验证守卫与Electron事件契约，不能当作实际页面保存、生成中关闭、Command+Q或完整重启验收。临时检查脚本未加入项目，不要求手写。

## 4. 完成本步后继续什么

本步仅新增模块，npm start的窗口行为保持当前状态；没有新的页面入口需要手动点击。不要提前在bootstrap或pagehide调用它。

下一步将一次接齐预加载和页面准备：先装监听再ready；收到关闭请求冻结输入/其他操作，等待已有操作，停止生成并等待发送协调收尾；await flushAll成功才回报同一编号，失败恢复页面交互并显示重试提示。主进程再安装守卫，并处理应用before-quit、重复退出与macOS无窗口后重新打开。

正常关闭补保存尚未完成，当前不能称为完整重启恢复。既有closed后停止仍作为兜底保留，不在本步删除或重写。

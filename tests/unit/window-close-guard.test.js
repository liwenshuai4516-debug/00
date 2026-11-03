const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { registerWindowCloseGuard } = require("../../src/main/lifecycle/window-close-guard.js");

function setup(t, ipcMain = new EventEmitter(), beforeClose) {
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
  registerWindowCloseGuard(window, ipcMain, undefined, beforeClose);
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

test("输入保存后等待 Pi 清理完成，等待期间不重复关闭", async t => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const s = setup(t, undefined, async () => { calls++; await pending; });
  s.ready(); s.window.close();
  const result = { requestId: s.last().requestId, saved: true };
  s.result(result); s.result(result); s.window.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(s.window.isDestroyed(), false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.window.isDestroyed(), true);
});

test("Pi 清理失败保留窗口，并允许再次关闭", async t => {
  let calls = 0;
  t.mock.method(console, "error", () => {});
  const s = setup(t, undefined, async () => {
    if (++calls === 1) throw new Error("清理失败");
  });
  s.ready(); s.window.close();
  s.result({ requestId: s.last().requestId, saved: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.window.isDestroyed(), false);
  s.window.close();
  s.result({ requestId: s.last().requestId, saved: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.window.isDestroyed(), true);
});

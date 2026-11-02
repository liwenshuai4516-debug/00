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
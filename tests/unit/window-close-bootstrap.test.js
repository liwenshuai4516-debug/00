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

  quitting = true;
  module.exports.createWindow();
  assert.equal(calls.length, 5);

  quitGuard.cancelQuit();
  module.exports.createWindow();
  const second = assertWindowSetup(5);
  assert.notEqual(second, first);
});
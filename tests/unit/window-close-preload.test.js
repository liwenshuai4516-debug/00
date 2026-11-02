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
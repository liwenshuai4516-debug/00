const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createExtensionUiBridge } = require("../../src/main/resources/extension-ui-bridge.js");

async function setup() {
  const ipc = new EventEmitter(), handlers = new Map(), sent = [];
  ipc.handle = (name, action) => handlers.set(name, action);
  const sender = new EventEmitter();
  sender.mainFrame = {};
  sender.isDestroyed = () => false;
  sender.send = (channel, event) => sent.push(event);
  const event = { sender, senderFrame: sender.mainFrame };
  const bridge = createExtensionUiBridge();
  bridge.register(ipc);
  const call = (name, ...args) => handlers.get(`agent:${name}`)(event, ...args);
  await call("extension-ui-ready");
  const ui = bridge.createContext({ sessionId: "a" }, { custom: async () => undefined });
  return { bridge, ipc, handlers, sender, event, sent, ui, call };
}

test("扩展对话只接受所属主页面和有效选项；取消、信号和超时均结束等待", async () => {
  const f = await setup();
  const selected = f.ui.select("选择", ["A", "B"]);
  const id = f.sent.at(-1).id;
  assert.throws(() => f.handlers.get("agent:extension-ui-response")({ sender: {}, senderFrame: {} }, { id, value: "A" }), /来源无效/);
  assert.throws(() => f.call("extension-ui-response", { id, value: "C" }), /结果无效/);
  f.call("extension-ui-response", { id, value: "B" });
  assert.equal(await selected, "B");
  const confirm = f.ui.confirm("确认", "正文");
  f.call("extension-ui-response", { id: f.sent.at(-1).id, cancelled: true });
  assert.equal(await confirm, false);
  const controller = new AbortController();
  const input = f.ui.input("输入", "占位", { signal: controller.signal });
  controller.abort();
  assert.equal(await input, undefined);
  assert.equal(await f.ui.select("超时", ["A"], { timeout: 5 }), undefined);
  const editor = f.ui.editor("编辑", "原文");
  f.bridge.cancelAll();
  assert.equal(await editor, undefined);
  f.ui.setEditorText("保留状态");
  const paused = f.ui.input("等待停止");
  f.bridge.cancelPending("a");
  assert.equal(await paused, undefined);
  f.ipc.emit("agent:extension-editor-state", f.event, "a", "停止后继续编辑");
  assert.equal(f.ui.getEditorText(), "停止后继续编辑");
});

test("页面销毁或重载取消交互，持久状态按会话清理；编辑缓存不会接收外来页面", async () => {
  const f = await setup();
  f.ui.setStatus("step", "进行中");
  f.ui.setWidget("todo", ["一", "二"], { placement: "belowEditor" });
  f.ui.setEditorText("建议正文");
  assert.equal(f.ui.getEditorText(), "建议正文");
  f.ipc.emit("agent:extension-editor-state", { sender: {} }, "a", "外来正文");
  assert.equal(f.ui.getEditorText(), "建议正文");
  f.ipc.emit("agent:extension-editor-state", f.event, "a", "用户编辑");
  assert.equal(f.ui.getEditorText(), "用户编辑");
  const pending = f.ui.input("等待");
  f.sender.emit("render-process-gone");
  assert.equal(await pending, undefined);
  await f.call("extension-ui-ready");
  assert.equal(f.ui.getEditorText(), "");
  assert.ok(f.sent.some(item => item.method === "setWidget" && item.widgetKey === "todo"));
  assert.equal(f.sender.listenerCount("did-start-navigation"), 1, "重复连接不重复注册页面生命周期");
  f.ipc.emit("agent:extension-editor-state", f.event, "a", "重连后输入");
  assert.equal(f.ui.getEditorText(), "重连后输入");
  f.bridge.cancelSession("a");
  assert.equal(f.sent.at(-1).method, "clear");
});

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
  const session = { sessionId: "a" };
  const ui = bridge.createContext(session, { custom: async () => undefined });
  return { bridge, ipc, handlers, sender, event, sent, ui, call, session };
}

test("扩展状态默认隐藏，只在当前调用内发送并在收尾后清除重放缓存", async () => {
  const f = await setup();
  f.ui.setStatus("goal", "初始化状态");
  await f.call("extension-ui-ready");
  assert.equal(f.sent.length, 0);

  const finish = f.session.desktopBeginUiStatus();
  assert.equal(f.sent.length, 0, "调用开始不恢复初始化状态");
  f.ui.setStatus("goal", "调用中");
  assert.equal(f.sent.at(-1).statusText, "调用中");
  f.sent.length = 0;
  await f.call("extension-ui-ready");
  assert.equal(f.sent.at(-1).statusText, "调用中", "活动调用重连可恢复状态");
  finish();
  assert.equal(f.sent.at(-1).method, "clearStatus");
  f.sent.length = 0;
  finish();
  f.ui.setStatus("goal", "迟到更新");
  await f.call("extension-ui-ready");
  assert.equal(f.sent.length, 0);

  const next = f.session.desktopBeginUiStatus();
  assert.equal(f.sent.length, 0, "下一调用不展示上一调用状态");
  f.ui.setStatus("goal", "新调用");
  assert.equal(f.sent.at(-1).statusText, "新调用");
  next();
});

test("状态清除按会话隔离，不影响组件、标题和输入；已释放上下文不再发状态", async () => {
  const f = await setup();
  const other = { sessionId: "b" };
  const otherUi = f.bridge.createContext(other, {});
  const finish = f.session.desktopBeginUiStatus();
  const finishOther = other.desktopBeginUiStatus();
  f.ui.setStatus("goal", "会话 A");
  otherUi.setStatus("goal", "会话 B");
  f.ui.setWidget("result", ["结果"]);
  f.ui.setTitle("扩展标题");
  f.ui.setEditorText("建议正文");
  finish();
  f.sent.length = 0;
  await f.call("extension-ui-ready");
  assert.deepEqual(f.sent.filter(item => item.method === "setStatus").map(item => item.sessionId), ["b"]);
  for (const method of ["setWidget", "setTitle", "setEditorText"]) assert.ok(f.sent.some(item => item.method === method));
  assert.equal(f.ui.getEditorText(), "建议正文");
  f.bridge.cancelSession("b");
  f.sent.length = 0;
  otherUi.setStatus("goal", "已释放会话的迟到状态");
  finishOther();
  assert.equal(f.sent.length, 0);
});

test("发送入口在请求真正结束或抛错后清除状态，不在 agent_end 时提前清除", async () => {
  const { sendMessage } = await import("../../src/main/pi-agent.mjs");
  for (const fails of [false, true]) {
    const f = await setup();
    const done = Promise.withResolvers();
    let receive;
    f.session.agent = { state: {} };
    f.session.subscribe = callback => { receive = callback; return () => {}; };
    f.session.prompt = async () => {
      f.ui.setStatus("step", "调用进行中");
      receive({ type: "agent_end", willRetry: false });
      await done.promise;
    };
    const request = sendMessage(f.session, "测试", () => {}, () => {});
    assert.equal(f.sent.at(-1).statusText, "调用进行中");
    if (fails) {
      done.reject(new Error("预期请求错误"));
      await assert.rejects(request, /预期请求错误/);
    } else {
      done.resolve();
      await request;
    }
    assert.equal(f.sent.at(-1).method, "clearStatus");
    f.sent.length = 0;
    await f.call("extension-ui-ready");
    assert.equal(f.sent.length, 0);
  }
});

test("请求内替换会话即清除原状态，重载不激活初始化状态", async () => {
  const { sendMessage } = await import("../../src/main/pi-agent.mjs");
  const f = await setup();
  f.session.subscribe = () => () => {};
  f.session.desktopRuntimeListeners = new Set();
  f.session.prompt = async () => {
    f.ui.setStatus("step", "旧会话调用中");
    for (const rebind of f.session.desktopRuntimeListeners) rebind({ sessionId: "b", subscribe: () => () => {} });
    assert.equal(f.sent.at(-1).method, "clearStatus");
    const count = f.sent.length;
    f.ui.setStatus("step", "旧会话迟到状态");
    assert.equal(f.sent.length, count);
  };
  await sendMessage(f.session, "/replace", () => {}, () => {});
  assert.equal(f.session.desktopRuntimeListeners.size, 0);
  f.sent.length = 0;
  f.session.desktopReloadResources = async () => f.ui.setStatus("startup", "重载初始化");
  await sendMessage(f.session, "/reload", () => {}, () => {});
  assert.equal(f.sent.length, 0);
});

test("等待用户只暂停所属会话的看门狗，交互开始和结束均重置无进展时间", async () => {
  const f = await setup();
  let progress = 0;
  f.session.desktopAgentProgress = () => progress++;
  const other = { sessionId: "b" };
  f.bridge.createContext(other, {});
  assert.equal(f.session.desktopHasPendingUi(), false);
  const response = f.ui.confirm("确认执行", "是否继续？");
  assert.equal(progress, 1);
  assert.equal(f.session.desktopHasPendingUi(), true);
  assert.equal(other.desktopHasPendingUi(), false);
  f.call("extension-ui-response", { id: f.sent.at(-1).id, value: true });
  assert.equal(await response, true);
  assert.equal(progress, 2);
  assert.equal(f.session.desktopHasPendingUi(), false);
});

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

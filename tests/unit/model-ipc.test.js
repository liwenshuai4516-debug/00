const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { registerModelIpc } = require("../../src/main/ipc/model-ipc.js");

test("模型事件按窗口订阅，重复订阅不累积，关闭与重开清理监听", () => {
  const handlers = new Map(), oauth = new Set(), enrichment = new Set();
  const subscribe = listeners => listener => { listeners.add(listener); return () => listeners.delete(listener); };
  registerModelIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    oauth: { subscribe: subscribe(oauth) }, enrichment: { subscribe: subscribe(enrichment) },
  }, {}, fn => fn());
  const sent = [];
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: (...args) => sent.push(args) });
  const call = name => handlers.get(`agent:${name}`)({ sender });
  call("watch-model-settings"); call("watch-model-settings");
  assert.equal(oauth.size, 1); assert.equal(sender.listenerCount("destroyed"), 1);
  [...oauth][0]({ status: "running" }); assert.equal(sent[0][0], "agent:model-settings-event");
  call("unwatch-model-settings"); assert.equal(oauth.size, 0); assert.equal(sender.listenerCount("destroyed"), 0);
  call("watch-model-settings"); sender.emit("destroyed");
  assert.equal(oauth.size, 0); assert.equal(enrichment.size, 0);
});

test("凭据变更共用互斥并刷新当前会话，登录回复与取消不被互斥阻塞", async () => {
  const handlers = new Map(); let locked = false, refreshed = 0, cancelled = 0, replied = 0;
  registerModelIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    addKey: async () => "added", oauth: { reply: () => { replied++; }, cancel: () => { cancelled++; } }, enrichment: {},
  }, { refreshModelAuth: async () => { refreshed++; } }, fn => { if (locked) throw Error("忙碌"); return fn(); });
  const call = (name, ...args) => handlers.get(`agent:${name}`)({}, ...args);
  assert.equal(await call("add-provider-key", "p", "name", "placeholder"), "added"); assert.equal(refreshed, 1);
  locked = true;
  assert.throws(() => call("add-provider-key", "p", "name", "placeholder"), /忙碌/);
  call("provider-oauth-reply", "flow", "prompt", "reply"); call("provider-oauth-cancel", "flow");
  assert.equal(replied, 1); assert.equal(cancelled, 1);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerModelIpc } = require("../../src/main/ipc/model-ipc.js");

test("官方配置入口不转发路径；写入、重读、默认与思考强度共用互斥", async () => {
  const handlers = new Map(), calls = [];
  let locked = false;
  registerModelIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    readConfiguration: (...args) => { calls.push(["read", ...args]); return { modelsPath: "/pi/models.json" }; },
    openConfiguration: (...args) => calls.push(["open", ...args]),
    readCatalog: (...args) => { calls.push(["catalog", ...args]); return { providers: [] }; },
    saveModel: input => { calls.push(["save", input]); return { providerId: "demo", modelId: "m", action: "created" }; },
    deleteModel: (...args) => { calls.push(["delete", ...args]); return { providerId: "demo", modelId: "m", action: "deleted" }; },
    saveProvider: input => { calls.push(["saveProvider", input]); return { providerId: input.providerId, action: "created" }; },
    deleteProvider: providerId => { calls.push(["deleteProvider", providerId]); return { providerId, modelCount: 0, action: "deleted" }; },
    discoverModels: input => { calls.push(["discover", input]); return { models: [] }; },
  }, {
    reloadModels: (...args) => calls.push(["reload", ...args]),
    setDefaultModel: (...args) => calls.push(["default", ...args]),
    setThinkingLevel: (...args) => calls.push(["thinking", ...args]),
  }, action => { if (locked) throw Error("忙碌"); return action(); });
  const call = (name, ...args) => handlers.get(`agent:${name}`)({}, ...args);
  await call("read-model-configuration", "/untrusted");
  await call("open-models-configuration", "/untrusted");
  await call("read-model-catalog", "/untrusted");
  await call("reload-models", "other-session");
  await call("set-default-model", "gpt", "gpt-6.1-sol");
  await call("set-thinking-level", "high", "other-session");
  // 非字符串参数不进入服务层，避免页面伪造对象。
  await call("set-default-model", 42);
  assert.deepEqual(calls, [
    ["read"], ["open"], ["catalog"], ["reload"],
    ["default", "gpt", "gpt-6.1-sol"], ["thinking", "high"], ["default", undefined, undefined],
  ]);

  // 写入配置后立即让运行时重读，保证表单保存即可用。
  calls.length = 0;
  const saved = { providerId: "demo", model: { id: "m" } };
  assert.deepEqual(await call("save-model", saved), { providerId: "demo", modelId: "m", action: "created" });
  assert.deepEqual(await call("delete-model", "demo", "m"), { providerId: "demo", modelId: "m", action: "deleted" });
  const provider = { providerId: "demo2", provider: { name: "Demo" } };
  assert.deepEqual(await call("save-provider", provider), { providerId: "demo2", action: "created" });
  assert.deepEqual(await call("delete-provider", "demo2"), { providerId: "demo2", modelCount: 0, action: "deleted" });
  const discovery = { baseUrl: "https://example.com/v1", api: "openai-completions" };
  assert.deepEqual(await call("discover-models", discovery), { models: [] });
  assert.deepEqual(calls, [
    ["save", saved], ["reload"],
    ["delete", "demo", "m"], ["reload"],
    ["saveProvider", provider], ["reload"],
    ["deleteProvider", "demo2"], ["reload"],
    ["discover", discovery],
  ]);

  locked = true;
  for (const name of ["reload-models", "set-default-model", "set-thinking-level", "save-model", "delete-model", "save-provider", "delete-provider"]) {
    assert.throws(() => call(name), /忙碌/);
  }
  assert.ok(!handlers.has("agent:save-model-settings"));
  assert.ok(!handlers.has("agent:provider-oauth-start"));
});

test("保存成功但重读失败时保留配置结果并附带提示", async () => {
  const handlers = new Map();
  registerModelIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    readConfiguration: () => ({}),
    openConfiguration: () => {},
    readCatalog: () => ({}),
    saveModel: () => ({ providerId: "demo", modelId: "m", action: "updated" }),
    deleteModel: () => ({ action: "deleted" }),
  }, {
    reloadModels: () => { throw new Error("模拟重读失败"); },
    setDefaultModel: () => {},
    setThinkingLevel: () => {},
  }, action => action());

  const result = await handlers.get("agent:save-model")({}, { providerId: "demo" });
  assert.equal(result.action, "updated");
  assert.match(result.warning, /配置已保存，但重新读取失败/);
});

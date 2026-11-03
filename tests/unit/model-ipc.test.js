const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerModelIpc } = require("../../src/main/ipc/model-ipc.js");

test("官方配置入口不转发路径；重读、默认与思考强度共用互斥", async () => {
  const handlers = new Map(), calls = [];
  let locked = false;
  registerModelIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    readConfiguration: (...args) => { calls.push(["read", ...args]); return { modelsPath: "/pi/models.json" }; },
    openConfiguration: (...args) => calls.push(["open", ...args]),
  }, {
    reloadModels: (...args) => calls.push(["reload", ...args]),
    setDefaultModel: (...args) => calls.push(["default", ...args]),
    setThinkingLevel: (...args) => calls.push(["thinking", ...args]),
  }, action => { if (locked) throw Error("忙碌"); return action(); });
  const call = (name, ...args) => handlers.get(`agent:${name}`)({}, ...args);
  await call("read-model-configuration", "/untrusted");
  await call("open-models-configuration", "/untrusted");
  await call("reload-models", "other-session");
  await call("set-default-model", "other-model");
  await call("set-thinking-level", "high", "other-session");
  assert.deepEqual(calls, [["read"], ["open"], ["reload"], ["default"], ["thinking", "high"]]);
  locked = true;
  for (const name of ["reload-models", "set-default-model", "set-thinking-level"]) assert.throws(() => call(name), /忙碌/);
  assert.ok(!handlers.has("agent:save-model-settings"));
  assert.ok(!handlers.has("agent:provider-oauth-start"));
});

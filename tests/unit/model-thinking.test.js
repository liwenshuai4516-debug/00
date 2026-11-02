const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSessionService } = require("../../src/main/services/session-service.js");

test("思考强度只接受当前模型支持的档位，保存到当前会话而不改变全局默认", async () => {
  const calls = [];
  const session = { thinkingLevel: "off", getAvailableThinkingLevels: () => ["off", "low", "high"],
    setThinkingLevel(value, options) { calls.push([value, options]); this.thinkingLevel = value; } };
  const service = createSessionService("unused", async () => session);
  await assert.rejects(service.setThinkingLevel("xhigh"), /不支持/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await service.setThinkingLevel("high"), { thinkingLevel: "high", thinkingLevels: ["off", "low", "high"] });
  assert.deepEqual(calls, [["high", { persist: false }]]);
});

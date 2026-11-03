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

test("思考强度按模型记住：写入官方设置并立即落盘，其他模型不受影响", async () => {
  const saved = [];
  let flushed = 0;
  const session = {
    thinkingLevel: "off",
    model: { provider: "deepseek", id: "deepseek-v4-pro" },
    getAvailableThinkingLevels: () => ["off", "high", "max"],
    setThinkingLevel(value) { this.thinkingLevel = value; },
    settingsManager: {
      setModelThinkingLevel: (...args) => saved.push(args),
      async flush() { flushed += 1; },
      drainErrors: () => [],
    },
  };
  const service = createSessionService("unused", async () => session);

  assert.deepEqual(await service.setThinkingLevel("max"), { thinkingLevel: "max", thinkingLevels: ["off", "high", "max"] });
  assert.deepEqual(saved, [["deepseek", "deepseek-v4-pro", "max"]]);
  assert.equal(flushed, 1);
});

test("默认模型可按供应商与编号指定，不接受未登记的模型", async () => {
  const saved = [];
  let flushed = 0;
  let stored = { provider: "deepseek", modelId: "deepseek-flash" };
  const session = {
    model: { provider: "deepseek", id: "deepseek-flash" },
    modelRuntime: {
      getModel(provider, id) {
        if (provider === "gpt" && id === "gpt-6.1-sol") return { provider, id };
        return undefined;
      },
    },
    settingsManager: {
      setDefaultModelAndProvider(provider, modelId) {
        saved.push([provider, modelId]);
        stored = { provider, modelId };
      },
      async flush() { flushed += 1; },
      drainErrors: () => [],
      getDefaultProvider: () => stored.provider,
      getDefaultModel: () => stored.modelId,
    },
  };
  const service = createSessionService("unused", async () => session);

  // 不传参数时沿用当前会话的模型，保持原有按钮语义。
  assert.deepEqual(await service.setDefaultModel(), {
    provider: "deepseek",
    modelId: "deepseek-flash",
    defaultProvider: "deepseek",
    defaultModel: "deepseek-flash",
  });
  assert.deepEqual(await service.setDefaultModel("gpt", "gpt-6.1-sol"), {
    provider: "gpt",
    modelId: "gpt-6.1-sol",
    defaultProvider: "gpt",
    defaultModel: "gpt-6.1-sol",
  });
  assert.deepEqual(saved, [["deepseek", "deepseek-flash"], ["gpt", "gpt-6.1-sol"]]);
  assert.equal(flushed, 2);

  await assert.rejects(service.setDefaultModel("gpt", "missing"), /未登记/);
  await assert.rejects(service.setDefaultModel("gpt"), /选择供应商和模型/);
});

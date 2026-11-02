const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchModelCatalog } = require("../../src/main/model/catalog-fetch.js");

test("模型列表按协议发送认证并在 404 时回退", async () => {
  const calls = [];
  const result = await fetchModelCatalog({ baseUrl: "https://example.invalid", apiKey: "test-key", api: "openai-completions" }, async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? { status: 404 } : {
      ok: true, json: async () => ({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, {}] }),
    };
  });
  assert.deepEqual(result, ["a", "b"]);
  assert.deepEqual(calls.map((item) => item.url), ["https://example.invalid/models", "https://example.invalid/v1/models"]);
  assert.equal(calls[0].options.headers.authorization, "Bearer test-key");
  assert.equal(calls[0].options.redirect, "error");
});

test("Anthropic 认证、无效响应与无效输入", async () => {
  const input = { baseUrl: "https://example.invalid/v1", apiKey: "test-key", api: "anthropic-messages" };
  await assert.rejects(fetchModelCatalog(input, async (_url, options) => {
    assert.equal(options.headers["x-api-key"], "test-key");
    assert.equal(options.headers["anthropic-version"], "2023-06-01");
    return { ok: true, json: async () => ({}) };
  }), /响应格式/);
  await assert.rejects(fetchModelCatalog({ ...input, baseUrl: "https://example.invalid/?key=secret" }), /地址/);
  await assert.rejects(fetchModelCatalog({ ...input, apiKey: "bad\nkey" }), /密钥/);
  await assert.rejects(fetchModelCatalog(input, async () => { throw new Error("test-key"); }), /无法读取模型列表/);
});

test("Google 模型目录使用独立认证头、原生编号和明确参数", async () => {
  const { fetchModelEntries } = require("../../src/main/model/catalog-fetch.js");
  const models = await fetchModelEntries({ baseUrl: "https://example.invalid/v1beta", api: "google-generative-ai", apiKey: "test-key" }, async (_url, options) => {
    assert.equal(options.headers["x-goog-api-key"], "test-key");
    assert.equal(options.headers.authorization, undefined);
    return { ok: true, json: async () => ({ models: [{ name: "models/gemini-test", displayName: "Gemini", inputTokenLimit: 1000000, outputTokenLimit: 8192 }] }) };
  });
  assert.deepEqual(models, [{ id: "gemini-test", name: "Gemini", contextWindow: 1000000, maxTokens: 8192 }]);
});

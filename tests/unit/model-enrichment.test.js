const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCatalogEnrichment, parseCatalog, matchModel } = require("../../src/main/model/catalog-enrichment.js");

test("公开参数仅使用目录事实，准确匹配、别名、歧义与未知参数分开展示", () => {
  const catalog = parseCatalog({ data: [{ id: "vendor/model", context_length: 128000, top_provider: { max_completion_tokens: 8000 }, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["reasoning"] }] }, "OpenRouter");
  assert.equal(matchModel("model-preview", catalog).matchedId, "vendor/model");
  assert.equal(matchModel("gateway-name", catalog, "vendor/model").contextWindow, 128000);
  assert.equal(matchModel("unknown", catalog).status, "unmatched");
  assert.equal(matchModel("model", [...catalog, { ...catalog[0], id: "other/model", contextWindow: 64000 }]).status, "ambiguous");
  const incomplete = parseCatalog({ p: { models: { x: { limit: { context: -1 }, reasoning: false } } } }, "models.dev")[0];
  assert.equal(incomplete.contextWindow, undefined);
  assert.equal(incomplete.maxTokens, undefined);
  assert.equal(incomplete.reasoning, false);
});

test("目录回退、进度、缓存和取消不会写入模型配置", async () => {
  const calls = [], events = [];
  const manager = createCatalogEnrichment(async url => {
    calls.push(url);
    return { ok: true, json: async () => url.includes("openrouter") ? { data: [] } : { vendor: { models: { x: { limit: { context: 64000, output: 4000 } } } } } };
  });
  const finished = () => new Promise(resolve => {
    const off = manager.subscribe(event => { events.push(event); if (event.status !== "running") { off(); resolve(event); } });
  });
  let done = finished(); manager.start(["x", "x"]); const result = await done;
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].source, "models.dev");
  assert.ok(events.some(item => item.progress.includes("models.dev")));
  done = finished(); manager.start(["x"]); await done;
  assert.equal(calls.length, 2);
  assert.throws(() => manager.start(["x"], { x: 2 }), /编号无效/);
  manager.dispose();
  const cancelled = createCatalogEnrichment((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private failure")), { once: true })));
  const stopped = new Promise(resolve => cancelled.subscribe(event => { if (event.status === "cancelled") resolve(event); }));
  const job = cancelled.start(["x"]); cancelled.cancel(job.id);
  assert.equal((await stopped).results.length, 0);
  assert.equal(JSON.stringify(cancelled.list()).includes("private failure"), false);
  cancelled.dispose();
});

test("主要目录参数不完整时从次级目录补足，明确值不覆盖", async () => {
  const manager = createCatalogEnrichment(async url => ({ ok: true, json: async () => url.includes("openrouter")
    ? { data: [{ id: "vendor/x", context_length: 32000 }] }
    : { vendor: { models: { x: { limit: { context: 64000, output: 4000 }, reasoning: false } } } } }));
  const done = new Promise(resolve => manager.subscribe(event => { if (event.status === "success") resolve(event.results[0]); }));
  manager.start(["x"]);
  const result = await done;
  assert.equal(result.contextWindow, 32000);
  assert.equal(result.maxTokens, 4000);
  assert.equal(result.reasoning, false);
  assert.match(result.source, /OpenRouter \+ models.dev/);
  manager.dispose();
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, rm, readdir, readFile } = require("node:fs/promises");
const { createModelCatalogStore } = require("../../src/main/storage/model-catalog-store.js");
const { createSettingsCatalog } = require("../../src/main/services/model-settings-service.js");

test("真实 SDK 官方目录刷新后重启可恢复，不读取个人模型或凭据", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-catalog-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createModelCatalogStore(dir);
  const runtime = await createSettingsCatalog(store);
  await runtime.setRuntimeApiKey("deepseek", "catalog-test-placeholder");
  const model = { ...runtime.getModel("deepseek", "deepseek-flash"), id: "new-catalog-test", name: "新目录模型" };
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([model]), { headers: { "last-modified": "Thu, 01 Jan 2099 00:00:00 GMT" } });
  try {
    const result = await runtime.refresh({ allowNetwork: true, force: true, providers: ["deepseek"] });
    assert.equal(result.errors.size, 0);
    assert.equal(runtime.getModel("deepseek", model.id).contextWindow, model.contextWindow);
    globalThis.fetch = async () => assert.fail("目录恢复不得访问网络");
    const reopened = await createSettingsCatalog(createModelCatalogStore(dir));
    assert.equal(reopened.getModel("deepseek", model.id).maxTokens, model.maxTokens);
    assert.deepEqual(await readdir(dir), ["deepseek.json"]);
    const before = await readFile(path.join(dir, "deepseek.json"), "utf8");
    await assert.rejects(store.write("deepseek", { models: [] }, { signal: AbortSignal.abort() }));
    assert.equal(await readFile(path.join(dir, "deepseek.json"), "utf8"), before);
  } finally { globalThis.fetch = previous; }
});

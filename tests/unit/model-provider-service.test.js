const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createModelProviderService } = require("../../src/main/services/model-provider-service.js");

test("官方配置入口只首次创建空文件，不覆盖已有配置或向页面回填内容", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "models-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const opened = [];
  const file = path.join(root, "pi/models.json");
  const service = createModelProviderService(async target => { opened.push(target); return ""; }, () => path.dirname(file));
  assert.deepEqual(await service.readConfiguration(), { modelsPath: file });
  await service.openConfiguration();
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { providers: {} });
  const contents = '{"providers":{"demo":{"apiKey":"private-test-value"}}}';
  await fs.writeFile(file, contents);
  await service.openConfiguration();
  assert.equal(await fs.readFile(file, "utf8"), contents);
  assert.deepEqual(await service.readConfiguration(), { modelsPath: file });
  assert.deepEqual(opened, [file, file]);
  const failure = createModelProviderService(async () => "模拟系统打开失败", () => path.dirname(file));
  await assert.rejects(failure.openConfiguration(), /无法打开 models.json/);
});

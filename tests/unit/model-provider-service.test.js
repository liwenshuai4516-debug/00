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

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "models-edit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "models.json");
  const document = {
    providers: {
      demo: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        apiKey: "$DEMO_KEY",
        headers: { "X-Secret": "never-return" },
        models: [
          {
            id: "demo-small",
            name: "Demo Small",
            contextWindow: 128000,
            headers: { Authorization: "Bearer secret" },
            customField: "keep-me",
          },
          { id: "demo-large", reasoning: true, thinkingLevelMap: { high: "high" } },
        ],
      },
      other: { baseUrl: "https://other.example.com", models: [{ id: "other-1" }] },
    },
  };
  await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  const service = createModelProviderService(async () => "", () => root);
  const read = async () => JSON.parse(await fs.readFile(file, "utf8"));
  return { root, file, service, read, document };
}

test("读取目录不返回密钥与请求头，并给出页面可用的选项清单", async t => {
  const { service } = await setup(t);
  const catalog = await service.readCatalog();
  assert.equal(catalog.providers.length, 2);
  const demo = catalog.providers.find(provider => provider.id === "demo");
  assert.equal(demo.hasApiKey, true);
  assert.equal(demo.baseUrl, "https://api.example.com/v1");
  assert.deepEqual(demo.models.map(model => model.id), ["demo-small", "demo-large"]);
  assert.equal(demo.models[0].contextWindow, 128000);
  assert.equal(demo.models[1].reasoning, true);
  const serialized = JSON.stringify(catalog);
  assert.ok(!serialized.includes("DEMO_KEY"));
  assert.ok(!serialized.includes("never-return"));
  assert.ok(!serialized.includes("Bearer secret"));
  assert.ok(catalog.options.api.includes("openai-completions"));
  assert.ok(catalog.options.thinkingLevels.includes("xhigh"));
});

test("新增模型写入官方字段并保留密钥、请求头和其他供应商", async t => {
  const { service, read, file } = await setup(t);
  const result = await service.saveModel({
    providerId: "demo",
    provider: { name: "演示供应商", baseUrl: "https://api.example.com/v1", api: "openai-completions" },
    model: {
      id: "demo-new",
      name: "Demo New",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 32000,
      input: ["text", "image"],
      cost: { input: 1, output: 2 },
      thinkingLevels: ["off", "low", "high"],
      thinkingFormat: "deepseek",
      extra: { promptCache: { short: 0.1 } },
    },
  });
  assert.deepEqual(result, { modelsPath: file, providerId: "demo", modelId: "demo-new", action: "created" });

  const document = await read();
  const demo = document.providers.demo;
  assert.equal(demo.apiKey, "$DEMO_KEY");
  assert.deepEqual(demo.headers, { "X-Secret": "never-return" });
  assert.equal(demo.name, "演示供应商");
  assert.deepEqual(document.providers.other, { baseUrl: "https://other.example.com", models: [{ id: "other-1" }] });

  const created = demo.models.at(-1);
  assert.equal(created.id, "demo-new");
  assert.equal(created.reasoning, true);
  assert.equal(created.contextWindow, 200000);
  assert.equal(created.maxTokens, 32000);
  assert.deepEqual(created.input, ["text", "image"]);
  assert.deepEqual(created.cost, { input: 1, output: 2 });
  assert.deepEqual(created.thinkingLevelMap, {
    off: "off", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null,
  });
  assert.equal(created.compat.thinkingFormat, "deepseek");
  assert.deepEqual(created.promptCache, { short: 0.1 });
});

test("修改模型保留未涉及字段与原位置，可改编号并换供应商", async t => {
  const { service, read } = await setup(t);
  await service.saveModel({
    providerId: "demo",
    provider: { baseUrl: "https://api.example.com/v1", api: "openai-completions" },
    original: { providerId: "demo", modelId: "demo-small" },
    model: { id: "demo-small-renamed", name: "改名后", input: ["text"], contextWindow: 64000 },
  });

  let document = await read();
  let models = document.providers.demo.models;
  assert.deepEqual(models.map(model => model.id), ["demo-small-renamed", "demo-large"]);
  assert.deepEqual(models[0].headers, { Authorization: "Bearer secret" });
  assert.equal(models[0].customField, "keep-me");
  assert.equal(models[0].contextWindow, 64000);
  assert.equal(models[0].reasoning, undefined);

  // 换供应商：旧供应商保留其他模型，新供应商新增条目。
  await service.saveModel({
    providerId: "other",
    provider: { baseUrl: "https://other.example.com", api: "openai-completions" },
    original: { providerId: "demo", modelId: "demo-large" },
    model: { id: "demo-large", reasoning: true, input: ["text"], thinkingLevels: ["off", "max"] },
  });
  document = await read();
  assert.deepEqual(document.providers.demo.models.map(model => model.id), ["demo-small-renamed"]);
  assert.deepEqual(document.providers.other.models.map(model => model.id), ["other-1", "demo-large"]);
  assert.equal(document.providers.other.models[1].thinkingLevelMap.max, "max");
});

test("删除最后一个模型会移除空供应商，非法输入不写入文件", async t => {
  const { service, read, file } = await setup(t);
  const before = await fs.readFile(file, "utf8");

  await assert.rejects(service.saveModel({ providerId: "demo", model: { id: "" } }), /模型编号不能为空/);
  await assert.rejects(service.saveModel({ providerId: "demo", model: { id: "x", api: "no-such-api", input: ["text"] } }), /接口协议只能是/);
  await assert.rejects(service.saveModel({ providerId: "bad id", model: { id: "x", input: ["text"] } }), /供应商编号只能包含/);
  await assert.rejects(service.saveModel({ providerId: "demo", model: { id: "demo-small", input: ["text"] } }), /已存在编号/);
  await assert.rejects(service.saveModel({ providerId: "demo", model: { id: "x", input: [] } }), /至少需要选择一种输入类型/);
  await assert.rejects(service.saveModel({ providerId: "demo", model: { id: "x", contextWindow: 0, input: ["text"] } }), /上下文窗口/);
  assert.equal(await fs.readFile(file, "utf8"), before);

  await service.deleteModel("other", "other-1");
  const document = await read();
  assert.equal(document.providers.other, undefined);
  assert.deepEqual(document.providers.demo.models.map(model => model.id), ["demo-small", "demo-large"]);
  await assert.rejects(service.deleteModel("demo", "missing"), /不在 models.json 中/);
});

test("配置损坏时给出可修正的提示，不尝试覆盖文件", async t => {
  const { service, file } = await setup(t);
  const broken = '{ "providers": { "demo": ';
  await fs.writeFile(file, broken);
  await assert.rejects(service.readCatalog(), /不是有效的 JSON/);
  await assert.rejects(service.saveModel({ providerId: "demo", model: { id: "x", input: ["text"] } }), /不是有效的 JSON/);
  assert.equal(await fs.readFile(file, "utf8"), broken);
});

test("提供商层保存只改名称、地址与协议，保留模型和凭据字段", async t => {
  const { service, read } = await setup(t);
  const created = await service.saveProvider({
    providerId: "new",
    provider: { name: "新供应商", baseUrl: "https://new.example.com/v1", api: "anthropic-messages" },
  });
  assert.deepEqual(created, { modelsPath: created.modelsPath, providerId: "new", action: "created" });

  let document = await read();
  assert.deepEqual(document.providers.new, {
    name: "新供应商",
    baseUrl: "https://new.example.com/v1",
    api: "anthropic-messages",
    models: [],
  });

  await service.saveProvider({
    providerId: "demo",
    provider: { name: "演示供应商改名", baseUrl: "https://api2.example.com/v1", api: "openai-completions" },
  });
  document = await read();
  const demo = document.providers.demo;
  assert.equal(demo.name, "演示供应商改名");
  assert.equal(demo.baseUrl, "https://api2.example.com/v1");
  assert.equal(demo.apiKey, "$DEMO_KEY");
  assert.deepEqual(demo.headers, { "X-Secret": "never-return" });
  assert.deepEqual(demo.models.map(model => model.id), ["demo-small", "demo-large"]);
});

test("提供商层校验失败不写文件，删除只移除目标区块", async t => {
  const { service, read, file } = await setup(t);
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(service.saveProvider({ providerId: "bad id" }), /供应商编号/);
  await assert.rejects(
    service.saveProvider({ providerId: "demo", provider: { baseUrl: "ftp://example.com" } }),
    /Base URL/,
  );
  await assert.rejects(
    service.saveProvider({ providerId: "demo", provider: { api: "no-such-api" } }),
    /接口协议/,
  );
  assert.equal(await fs.readFile(file, "utf8"), before);

  const result = await service.deleteProvider("demo");
  assert.deepEqual(result, { modelsPath: file, providerId: "demo", modelCount: 2, action: "deleted" });
  const document = await read();
  assert.equal(document.providers.demo, undefined);
  assert.deepEqual(document.providers.other, {
    baseUrl: "https://other.example.com",
    models: [{ id: "other-1" }],
  });
  await assert.rejects(service.deleteProvider("demo"), /不在 models.json 中/);
});

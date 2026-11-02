const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, readFile, writeFile, rm, readdir } = require("node:fs/promises");
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { createModelSettingsStore, PROFILE_PREFIX } = require("../../src/main/storage/model-settings-store.js");
const { createModelSettingsService, createSettingsCatalog } = require("../../src/main/services/model-settings-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

async function setup(t, env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "multi-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "model-settings.json");
  const key = randomBytes(32);
  const crypto = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(data) {
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const store = createModelSettingsStore(file, crypto, env);
  const service = createModelSettingsService(store);
  const input = {
    name: "测试配置 A", kind: "custom", provider: "自定义供应商", modelId: "same-model",
    baseUrl: "https://a.example.invalid/v1", authMode: "saved", apiKey: "placeholder-A",
    api: "openai-completions", contextWindow: 32000, maxTokens: 2000,
  };
  return { dir, file, store, service, input, crypto };
}

test("空初始和启动配置只读，不提前创建文件", async (t) => {
  const { store, dir, file, crypto } = await setup(t);
  assert.deepEqual(await store.read(), { profiles: [], defaultProfileId: "" });
  const fallback = createModelSettingsStore(file, crypto, { PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash" });
  const data = await fallback.read();
  assert.equal(data.defaultProfileId, "legacy");
  assert.equal(data.profiles[0].modelId, "deepseek-flash");
  assert.deepEqual(await readdir(dir), []);
});

test("V1读取不改写；首次新增升级V2并原样保留旧密文", async (t) => {
  const { store, service, crypto, file, input } = await setup(t);
  const encryptedKey = crypto.encryptString("legacy-placeholder").toString("base64");
  const previous = JSON.stringify({ version: 1, provider: "deepseek", modelId: "deepseek-flash", baseUrl: "", authMode: "saved", encryptedKey });
  await writeFile(file, previous);
  assert.equal((await store.read()).profiles[0].hasSavedKey, true);
  assert.equal(await readFile(file, "utf8"), previous);
  await service.save(input);
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.equal(record.version, 2);
  assert.equal(record.defaultProfileId, "legacy");
  assert.equal(record.profiles[0].encryptedKey, encryptedKey);
  assert.equal((await store.resolveSelection({ provider: "deepseek", modelId: "deepseek-v4-pro" })).modelId, "deepseek-v4-pro");
  assert.equal((await store.loadProfile("legacy")).apiKey, "legacy-placeholder");
});

test("同名模型不同地址与密钥独立保存；公开数据无明文密文", async (t) => {
  const { service, store, input, file } = await setup(t);
  const a = await service.save(input);
  const b = await service.save({ ...input, name: "测试配置 B", baseUrl: "https://b.example.invalid/v1", apiKey: "placeholder-B" });
  assert.notEqual(a.id, b.id);
  assert.equal((await store.read()).defaultProfileId, a.id);
  const publicData = JSON.stringify(await service.read());
  for (const value of ["placeholder-A", "placeholder-B", "encryptedKey", "apiKey\":"]) assert.equal(publicData.includes(value), false);
  assert.equal((await readFile(file, "utf8")).includes(input.apiKey), false);
  assert.equal((await store.loadProfile(a.id)).apiKey, input.apiKey);
  assert.equal((await store.loadProfile(b.id)).apiKey, "placeholder-B");
  assert.equal((await store.loadProfile(a.id)).model.baseUrl, input.baseUrl);
});

test("默认与历史独立，缺失及不匹配选择不得套用默认", async (t) => {
  const { service, store, input } = await setup(t);
  const a = await service.save(input);
  const b = await service.save({ ...input, name: "B" });
  await service.setDefault(b.id);
  assert.equal((await store.resolveSelection()).id, b.id);
  assert.equal((await store.resolveSelection({ provider: PROFILE_PREFIX + a.id, modelId: input.modelId })).id, a.id);
  await assert.rejects(store.resolveSelection({ provider: PROFILE_PREFIX + a.id, modelId: "different" }), /不一致/);
  await assert.rejects(store.resolveSelection({ provider: PROFILE_PREFIX + "missing", modelId: input.modelId }), /不存在/);
  await assert.rejects(store.resolveSelection({ provider: "other", modelId: input.modelId }), /其他供应商/);
});

test("编辑保留密钥和历史快照，移除不破坏旧会话", async (t) => {
  const { service, store, input } = await setup(t);
  const original = await service.save(input);
  const edited = await service.save({ ...input, replaceId: original.id, apiKey: "", baseUrl: "https://new.example.invalid/v1" });
  assert.notEqual(edited.id, original.id);
  assert.equal((await store.read()).defaultProfileId, edited.id);
  assert.deepEqual((await store.read()).profiles.map((item) => item.id), [edited.id]);
  assert.equal((await store.loadProfile(edited.id)).apiKey, input.apiKey);
  assert.equal((await store.resolveSelection({ provider: PROFILE_PREFIX + original.id, modelId: input.modelId })).baseUrl, input.baseUrl);
  await assert.rejects(store.hide(edited.id), /先选择其他默认/);
  const other = await service.save({ ...input, name: "其他" });
  await service.setDefault(other.id);
  await store.hide(edited.id);
  assert.deepEqual((await store.read()).profiles.map((item) => item.id), [other.id]);
  const current = await service.listForSession({ model: { provider: PROFILE_PREFIX + edited.id, id: input.modelId } });
  assert.equal(current.currentProfileId, edited.id);
  assert.ok(current.profiles.some((item) => item.id === edited.id));
});

test("非法地址、协议、窗口、缺密钥及重名保留原文件", async (t) => {
  const { service, file, input } = await setup(t);
  await service.save(input);
  const before = await readFile(file, "utf8");
  for (const change of [
    {}, { baseUrl: "/v1" }, { baseUrl: "https://u:p@example.invalid" },
    { baseUrl: "https://example.invalid?token=x" }, { baseUrl: "ftp://example.invalid" },
    { api: "unknown" }, { contextWindow: 0 }, { maxTokens: 32001 },
    { maxTokens: 1.5 }, { apiKey: "" }, { apiKey: "bad\nkey" }, { authMode: "sdk" },
  ]) {
    await assert.rejects(service.save({ ...input, name: "new", ...change, ...(Object.keys(change).length ? {} : { name: input.name }) }));
    assert.equal(await readFile(file, "utf8"), before);
  }
});

test("加密不可用、加解密失败及损坏配置不泄露或覆盖", async (t) => {
  const { service, store, crypto, file, input } = await setup(t);
  const a = await service.save(input);
  const before = await readFile(file, "utf8");
  crypto.isEncryptionAvailable = () => false;
  await assert.rejects(service.save({ ...input, name: "B" }), /保护不可用/);
  crypto.isEncryptionAvailable = () => true;
  crypto.encryptString = () => { throw Error("private failure detail"); };
  await assert.rejects(service.save({ ...input, name: "B" }), { message: "密钥加密失败，原配置未修改。" });
  assert.equal(await readFile(file, "utf8"), before);
  crypto.decryptString = () => { throw Error("private cipher detail"); };
  await assert.rejects(store.loadProfile(a.id), /无法解密/);
  await writeFile(file, "{broken");
  await assert.rejects(store.read(), /损坏/);
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("原子发布失败清理临时文件并保留旧文件", async (t) => {
  const { service, file, input, crypto, dir } = await setup(t);
  await service.save(input);
  const before = await readFile(file, "utf8");
  const vm = require("node:vm");
  const { createRequire } = require("node:module");
  const sourcePath = require.resolve("../../src/main/storage/model-settings-store.js");
  const realRequire = createRequire(sourcePath);
  const moduleStub = { exports: {} };
  vm.runInNewContext(await readFile(sourcePath, "utf8"), {
    require: (name) => name === "node:fs/promises" ? { ...realRequire(name), rename: async () => { throw Error("发布失败"); } } : realRequire(name),
    module: moduleStub, process, Buffer, URL,
  });
  const failing = moduleStub.exports.createModelSettingsStore(file, crypto, {});
  await assert.rejects(failing.setDefault((await service.read()).defaultProfileId), /发布失败/);
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual(await readdir(dir), ["model-settings.json"]);
});

test("内置模型保留真实元信息，未知供应商或模型拒绝", async (t) => {
  const { service, store, input } = await setup(t);
  const config = { ...input, kind: "builtin", provider: "deepseek", modelId: "deepseek-flash", baseUrl: "", authMode: "sdk", apiKey: "" };
  const added = await service.save(config);
  const profile = await store.loadProfile(added.id);
  const catalog = await createSettingsCatalog();
  const providers = (await service.read()).providers.map(item => item.id);
  assert.ok(["anthropic", "deepseek", "openai"].every(id => providers.includes(id)));
  assert.ok(providers.some(id => !["anthropic", "deepseek", "openai"].includes(id)));
  await assert.rejects(service.listModels("not-a-provider"), /自定义兼容接口/);
  assert.equal(profile.model.contextWindow, catalog.getModel("deepseek", "deepseek-flash").contextWindow);
  assert.equal(profile.model.baseUrl, catalog.getModel("deepseek", "deepseek-flash").baseUrl);
  await assert.rejects(service.save({ ...config, name: "missing", modelId: "missing" }), /未登记/);
  assert.ok((await service.listModels("deepseek")).some((model) => model.id === config.modelId));
});

test("配置IPC白名单与互斥；读取无需会话初始化", async () => {
  const handlers = new Map();
  let busy = true;
  const calls = [];
  let release;
  const settingsService = {
    read: () => "read", listModels: (provider) => provider,
    save: async (value) => { calls.push(value); }, setDefault: async () => new Promise((r) => { release = r; }),
  };
  const sessions = { listModelProfiles: () => "profiles", switchModelProfile: (id) => calls.push(id) };
  registerAgentIpc({ handle: (name, fn) => { assert.ok(!handlers.has(name)); handlers.set(name, fn); } }, sessions,
    { isBusy: () => busy }, undefined, undefined, undefined, undefined, undefined, undefined, settingsService);
  assert.equal(handlers.get("agent:read-model-settings")(), "read");
  assert.equal(handlers.get("agent:list-model-profiles")(), "profiles");
  assert.throws(() => handlers.get("agent:switch-model-profile")({}, "id"), /等待当前回复/);
  busy = false;
  await handlers.get("agent:save-model-settings")({}, { name: "A", path: "rejected", encryptedKey: "rejected" });
  assert.deepEqual(Object.keys(calls[0]).sort(), ["name", "kind", "provider", "modelId", "baseUrl", "authMode", "apiKey", "api", "contextWindow", "maxTokens", "replaceId", "reasoning", "vision"].sort());
  assert.equal(calls[0].name, "A");
  const pending = handlers.get("agent:set-default-model-profile")({}, "id");
  await Promise.resolve();
  assert.throws(() => handlers.get("agent:switch-model-profile")({}, "id"), /其他操作完成/);
  release(); await pending;
  await handlers.get("agent:switch-model-profile")({}, "id");
  assert.equal(calls[1], "id");
});

test("目录不访问网络或个人凭据", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("目录不得访问网络");
  try {
    const catalog = await createSettingsCatalog();
    assert.ok(catalog.getModel("deepseek", "deepseek-flash"));
    assert.ok(catalog.getModels("openai").length);
  } finally { globalThis.fetch = previous; }
});

test("预加载只暴露固定通道及配置白名单", async () => {
  const vm = require("node:vm");
  const calls = [];
  let api;
  const source = await readFile(path.resolve(__dirname, "../../src/preload/preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "agent"); api = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); }, on() {}, removeListener() {} },
      };
    },
  });
  api.listModelProfiles("ignored");
  api.switchModelProfile("one", "ignored");
  api.setDefaultModelProfile("two", "ignored");
  api.saveModelSettings({ name: "A", apiKey: "placeholder", path: "ignored", encryptedKey: "ignored" });
  assert.equal(JSON.stringify(calls.slice(0, 3)), JSON.stringify([
    ["agent:list-model-profiles"], ["agent:switch-model-profile", "one"], ["agent:set-default-model-profile", "two"],
  ]));
  assert.equal(calls[3][0], "agent:save-model-settings");
  assert.equal(calls[3][1].apiKey, "placeholder");
  assert.equal(Object.hasOwn(calls[3][1], "encryptedKey"), false);
  assert.equal(Object.hasOwn(calls[3][1], "path"), false);
});

test("启动地址无效仍可查看页面，但不能交给运行时发送密钥", async (t) => {
  const { file, crypto } = await setup(t);
  const store = createModelSettingsStore(file, crypto, {
    PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid?key=bad",
  });
  assert.equal((await store.read()).profiles[0].id, "legacy");
  await assert.rejects(store.resolveSelection(), /API 地址/);
});

test("复制、目录刷新合并、留空密钥探测与默认恢复保留历史快照", async t => {
  const { store, crypto, input, file } = await setup(t, { PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash" });
  let requests = 0;
  const service = createModelSettingsService(store, undefined, { fetch: async (_url, options) => {
    requests++;
    assert.equal(options.headers.authorization, "Bearer placeholder-A");
    return { ok: true, json: async () => ({ data: [{ id: "new-model", context_window: 64000, max_tokens: 4000 }] }) };
  } });
  const saved = await service.save(input);
  const cloned = await service.clone(saved.id, "配置副本");
  assert.notEqual(cloned.id, saved.id);
  assert.equal((await store.loadProfile(cloned.id)).apiKey, input.apiKey);
  await store.mergeCatalog(`profile:${saved.id}`, [{ id: "new-model", contextWindow: 32000 }]);
  assert.equal((await service.refreshProfile(saved.id)).models[0].contextWindow, 32000);
  assert.deepEqual(await service.fetchCatalog({ profileId: saved.id, baseUrl: input.baseUrl, api: input.api }), ["new-model"]);
  assert.equal(requests, 2);
  await assert.rejects(service.fetchCatalog({ profileId: saved.id, baseUrl: "https://other.invalid", api: input.api }), /地址已改变/);
  assert.equal(requests, 2);
  await service.setDefault(saved.id); await service.clearDefault();
  assert.equal((await store.read()).defaultProfileId, "legacy");
  const reopened = createModelSettingsStore(file, crypto, {});
  assert.equal((await reopened.loadProfile(saved.id)).modelId, input.modelId);
  assert.equal((await reopened.readCatalog(`profile:${saved.id}`))[0].maxTokens, 4000);
});

test("手工补充内置模型保留完整参数，目录缓存不接收凭据或无效参数", async t => {
  const { store, service, file, crypto } = await setup(t);
  await service.appendBuiltin("deepseek", { modelId: "future-test-model", api: "openai-completions", contextWindow: 64000, maxTokens: 4000, reasoning: true, vision: false });
  assert.ok((await service.listModels("deepseek")).some(item => item.id === "future-test-model"));
  const saved = await service.save({ name: "手工模型", kind: "builtin", provider: "deepseek", modelId: "future-test-model", baseUrl: "", authMode: "saved", apiKey: "placeholder" });
  assert.equal((await store.loadProfile(saved.id)).model.reasoning, true);
  await assert.rejects(service.appendBuiltin("deepseek", { modelId: "future-test-model", api: "openai-completions", contextWindow: 64000, maxTokens: 4000 }), /已存在/);
  await store.mergeCatalog("profile:manual", [{ id: "x", apiKey: "private", encryptedKey: "private" }]);
  assert.equal(JSON.stringify(await store.readCatalog("profile:manual")).includes("private"), false);
  const before = await readFile(file, "utf8");
  await assert.rejects(store.mergeCatalog("profile:bad", [{ id: "x", contextWindow: -1 }]));
  assert.equal(await readFile(file, "utf8"), before);
  assert.ok((await createModelSettingsStore(file, crypto, {}).loadProfile(saved.id)).model.baseUrl);
});

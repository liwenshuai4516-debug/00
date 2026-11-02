const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

async function verifyRuntime() {
  const assert = require("node:assert/strict");
  const path = require("node:path");
  const { createModelCredentialsStore } = require("./src/main/storage/model-credentials-store.js");
  const { createModelSettingsStore, PROFILE_PREFIX } = require("./src/main/storage/model-settings-store.js");
  const { createModelSettingsService } = require("./src/main/services/model-settings-service.js");
  const { createCredentialRuntime } = await import("./src/main/model/credential-runtime.mjs");
  const { installModelProfile } = await import("./src/main/model-profile-runtime.mjs");
  globalThis.fetch = async () => assert.fail("不得访问网络");
  const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const dir = process.env.PI_CODING_AGENT_DIR;
  const credentials = createModelCredentialsStore(path.join(dir, "credentials.json"), crypto);
  const settingsStore = createModelSettingsStore(path.join(dir, "settings.json"), crypto, {});
  const settings = createModelSettingsService(settingsStore, undefined, { credentialsStore: credentials });
  const a = await credentials.addKey("gateway", "A", "placeholder-A");
  const b = await credentials.addKey("gateway", "B", "placeholder-B");
  const profile = await settings.save({ name: "动态密钥", kind: "custom", provider: "gateway", modelId: "example", baseUrl: "https://example.invalid/v1", authMode: "provider", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 });
  const runtime = await createCredentialRuntime(credentials);
  const model = await installModelProfile(runtime, await settingsStore.loadProfile(profile.id));
  assert.equal((await runtime.getAuth(model)).auth.apiKey, "placeholder-A");
  await credentials.activateKey("gateway", b.id);
  assert.equal((await runtime.getAuth(model)).auth.apiKey, "placeholder-B");
  await credentials.removeKey("gateway", b.id);
  assert.equal(await runtime.getAuth(model), undefined);
  assert.equal((await settings.providerAuth("gateway")).configured, false);
  await credentials.activateKey("gateway", a.id);
  assert.equal((await settings.providerAuth("gateway")).configured, true);
  const reopened = await createCredentialRuntime(credentials);
  const restored = await installModelProfile(reopened, await settingsStore.resolveSelection({ provider: PROFILE_PREFIX + profile.id, modelId: model.id }));
  assert.equal((await reopened.getAuth(restored)).auth.apiKey, "placeholder-A");

  // 使用真正 SDK 的 OAuth 解析与刷新锁，供应商实现替身不访问真实账号。
  let refreshes = 0;
  const source = runtime.getModel("deepseek", "deepseek-flash");
  runtime.registerNativeProvider({ id: "fake-oauth", name: "本地测试", getModels: () => [{ ...source, provider: "fake-oauth" }],
    auth: { oauth: { name: "测试登录", async login() { return { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 }; },
      async refresh() { refreshes++; return { type: "oauth", access: "renewed", refresh: "new-refresh", expires: Date.now() + 3600000 }; },
      async toAuth(value) { return { apiKey: value.access }; } } },
    stream() { assert.fail("不得请求模型"); }, streamSimple() { assert.fail("不得请求模型"); },
  });
  await credentials.modify("fake-oauth", async () => ({ type: "oauth", access: "old", refresh: "old-refresh", expires: 0 }));
  const oauthProfile = { id: "oauth-test", name: "OAuth 快照", kind: "builtin", provider: "fake-oauth", modelId: source.id, authMode: "oauth", model: source };
  const oauthModel = await installModelProfile(runtime, oauthProfile);
  const results = await Promise.all([runtime.getAuth(oauthModel), runtime.getAuth(oauthModel)]);
  assert.ok(results.every(result => result.auth.apiKey === "renewed"));
  assert.equal(refreshes, 1);
  assert.equal((await credentials.state("fake-oauth")).credential.refresh, "new-refresh");
  await credentials.logout("fake-oauth");
  assert.equal(await runtime.getAuth(oauthModel), undefined);
  await assert.rejects(installModelProfile(runtime, oauthProfile), /尚未登录/);
  settings.oauth.dispose(); settings.enrichment.dispose();
}

test("真实 SDK 读取激活密钥、删除后停止使用、配置恢复及 OAuth 令牌只刷新一次", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "credential-runtime-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await promisify(execFile)(process.execPath, ["-e", `(${verifyRuntime.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`], {
    cwd: path.resolve(__dirname, "../.."), env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" },
  });
  assert.equal(result.stdout, "");
});

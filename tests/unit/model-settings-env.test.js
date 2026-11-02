const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, readFile, writeFile, rm } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createModelSettingsStore } = require("../../src/main/storage/model-settings-store.js");
const { createModelSettingsService } = require("../../src/main/services/model-settings-service.js");
const runFile = promisify(execFile);

const placeholderStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (buffer) => buffer.toString(),
};

test("保存过其他配置仍可读取启动环境的非敏感字段，且不改写默认", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-env-fields-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createModelSettingsStore(path.join(directory, "settings.json"), placeholderStorage, {
    PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://env.example.invalid/v1",
    DEEPSEEK_API_KEY: "env-placeholder",
  });
  const service = createModelSettingsService(store);
  const profile = await service.save({
    name: "本地配置", kind: "custom", provider: "Custom", modelId: "model-b",
    api: "openai-completions", baseUrl: "https://saved.example.invalid/v1",
    authMode: "saved", apiKey: "local-placeholder", contextWindow: 32000, maxTokens: 1000,
  });
  await service.setDefault(profile.id);
  const result = await service.read();
  assert.deepEqual(result.environment, {
    provider: "deepseek", modelId: "deepseek-flash", baseUrl: "https://env.example.invalid/v1",
  });
  assert.equal(result.defaultProfileId, profile.id);
  assert.equal(result.environmentError, "");
  assert.equal(JSON.stringify(result).includes("env-placeholder"), false);
  assert.equal((await store.resolveSelection()).id, profile.id);
});

test("缺少或无效环境配置只影响读取入口，不覆盖已保存配置", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-env-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  const store = createModelSettingsStore(file, placeholderStorage, {});
  const service = createModelSettingsService(store);
  const saved = await service.save({
    name: "本地配置", kind: "custom", provider: "Custom", modelId: "model",
    api: "openai-completions", baseUrl: "https://saved.example.invalid/v1",
    authMode: "saved", apiKey: "placeholder", contextWindow: 32000, maxTokens: 1000,
  });
  assert.equal((await service.read()).environment, null);
  const before = await readFile(file, "utf8");
  const invalid = createModelSettingsService(createModelSettingsStore(file, placeholderStorage, {
    PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid?key=private",
  }));
  const result = await invalid.read();
  assert.equal(result.environment, null);
  assert.match(result.environmentError, /API 地址/);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.defaultProfileId, saved.id);
  assert.equal(await readFile(file, "utf8"), before);
});

test("实际启动入口加载临时.env，真实SDK使用其中的模型、地址与凭据", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-env-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const environment = [
    "PI_PROVIDER=deepseek", "PI_MODEL=deepseek-flash", "PI_BASE_URL=https://env.example.invalid/v1",
    "DEEPSEEK_API_KEY=env-placeholder-only", `AGENT_WORKSPACE_DIR=${workspace}`,
  ].join("\n");
  await writeFile(path.join(directory, ".env"), environment);
  const bootstrap = require.resolve("../../src/main/bootstrap.js");
  const script = `
    const assert = require("node:assert/strict");
    const vm = require("node:vm");
    const path = require("node:path");
    const { createRequire } = require("node:module");
    const { readFile } = require("node:fs/promises");
    const base = process.argv[1];
    const filename = ${JSON.stringify(bootstrap)};
    const localRequire = createRequire(filename);
    globalThis.fetch = async () => assert.fail("测试不允许请求网络或模型");
    let factory;
    let windowCount = 0;
    const handlers = new Map();
    class BrowserWindow {
      constructor() { windowCount++; this.webContents = { on() {}, removeListener() {} }; }
      on() {}
      removeListener() {}
      once() {}
      loadFile() {}
      static getAllWindows() { return []; }
    }
    async function run() {
      const source = await readFile(filename, "utf8");
      const context = {
        require(name) {
          if (name === "electron") return {
            BrowserWindow, dialog: {}, ipcMain: { on() {}, removeListener() {}, handle(name, fn) { assert.ok(!handlers.has(name)); handlers.set(name, fn); } },
            app: { whenReady: () => Promise.resolve(), getPath: () => path.join(base, "userData"), on() {}, quit() {} },
            safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: data => data.toString() },
          };
          if (name === "./services/session-service.js") return {
            createSessionService(sessionDir, createAgent) { factory = (...args) => createAgent(sessionDir, ...args); return {}; },
          };
          return localRequire(name);
        },
        process, Buffer, URL, __dirname: path.join(base, "src/main"), module: { exports: {} },
      };
      new vm.Script(source, { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInNewContext(context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(windowCount, 1);
      const first = await factory(false, undefined, process.env.AGENT_WORKSPACE_DIR);
      assert.equal(first.model.id, "deepseek-flash");
      assert.equal(first.model.baseUrl, "https://env.example.invalid/v1");
      assert.ok((await first.modelRuntime.getAuth(first.model)).auth.apiKey === "env-placeholder-only");
      const fields = await handlers.get("agent:read-model-settings")();
      assert.equal(fields.environment.modelId, "deepseek-flash");
      assert.equal(JSON.stringify(fields).includes("env-placeholder-only"), false);
      first.dispose();
      const added = await handlers.get("agent:save-model-settings")({}, {
        name: "新的默认配置", kind: "custom", provider: "Custom", modelId: "other-model",
        api: "openai-completions", baseUrl: "https://saved.example.invalid/v1",
        authMode: "saved", apiKey: "saved-placeholder", contextWindow: 32000, maxTokens: 1000,
      });
      await handlers.get("agent:set-default-model-profile")({}, added.id);
      const second = await factory(false, undefined, process.env.AGENT_WORKSPACE_DIR);
      assert.equal(second.model.id, "other-model");
      assert.equal(second.model.baseUrl, "https://saved.example.invalid/v1");
      assert.ok((await second.modelRuntime.getAuth(second.model)).auth.apiKey === "saved-placeholder");
      second.dispose();
      assert.equal((await handlers.get("agent:read-model-settings")()).environment.modelId, "deepseek-flash");
      assert.equal(await readFile(path.join(base, ".env"), "utf8"), ${JSON.stringify(environment)});
    }
    run().catch(() => { console.error("临时.env启动检查失败；不输出配置或凭据。"); process.exitCode = 1; });
  `;
  // 清除外部同名变量，确保确实由临时.env载入，而不是继承测试进程。
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "pi"), PI_OFFLINE: "1" };
  for (const key of ["PI_PROVIDER", "PI_MODEL", "PI_BASE_URL", "DEEPSEEK_API_KEY", "AGENT_WORKSPACE_DIR"]) delete env[key];
  const result = await runFile(process.execPath, ["--experimental-vm-modules", "-e", script, directory], { env, encoding: "utf8" });
  assert.equal(result.stdout, "");
});

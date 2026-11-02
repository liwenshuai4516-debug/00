const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const runFile = promisify(execFile);

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-empty-rebuild-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceDir = path.join(base, "workspace");
  const other = path.join(base, "other");
  await fs.mkdir(workspaceDir);
  await fs.mkdir(other);
  const sessionDir = path.join(base, "sessions");
  const store = createSessionStateStore(path.join(base, "state"));
  await store.registerSession("original-id", workspaceDir, "empty", {
    provider: "deepseek", modelId: "deepseek-v4-pro",
  });
  await store.saveDraft("original-id", workspaceDir, " 原输入\r\n", 0);
  const recovery = await store.load("original-id");
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");
  return { base, workspaceDir, other, sessionDir, store, recovery, createWorkspaceSession, SessionManager };
}

function addHistory(SessionManager, sessionDir, workspaceDir, id) {
  const manager = SessionManager.create(workspaceDir, sessionDir, { id });
  manager.appendCustomEntry("desktop-workspace-binding", { version: 1, workspaceRoot: workspaceDir });
  manager.appendModelChange("deepseek", "deepseek-flash");
  // 只追加本地测试消息令历史落盘，不调用 prompt 或任何模型。
  manager.appendMessage({ role: "user", content: "临时历史", timestamp: Date.now() });
  return manager;
}

test("按原编号及真实目录重建，不改输入与组织状态，也不伪造历史文件", async (t) => {
  const f = await setup(t);
  await f.store.update(f.recovery.sessionId, f.workspaceDir, state => ({ ...state, pinnedAt: 10, archivedAt: 20 }));
  const stateFile = path.join(f.base, "state", "original-id.json");
  const before = await fs.readFile(stateFile, "utf8");
  const alias = path.join(f.base, "alias");
  await fs.symlink(f.workspaceDir, alias);
  const result = await f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: alias, recovery: f.recovery });
  assert.equal(result.source, "empty");
  assert.equal(result.workspaceRoot, f.workspaceDir);
  assert.equal(result.sessionManager.getSessionId(), f.recovery.sessionId);
  assert.deepEqual(result.sessionManager.buildSessionContext().messages, []);
  assert.equal(result.sessionManager.getEntries().filter(e => e.type === "custom").length, 1);
  await assert.rejects(fs.stat(result.sessionManager.getSessionFile()), { code: "ENOENT" });
  assert.equal(await fs.readFile(stateFile, "utf8"), before);
  assert.equal((await f.store.load(f.recovery.sessionId)).draft.text, " 原输入\r\n");
});

test("纯空白输入保留；来源未知或history、空输入与待确认发送不能重建", async (t) => {
  const f = await setup(t);
  const create = recovery => f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery });
  const blank = await create({ ...f.recovery, draft: { text: " \r\n\t", revision: 1 } });
  assert.equal(blank.sessionManager.getSessionId(), f.recovery.sessionId);
  for (const source of [undefined, "history"]) {
    const registration = source ? { ...f.recovery.registration, source } : undefined;
    await assert.rejects(create({ ...f.recovery, registration }), /没有可信的空会话登记/);
  }
  await assert.rejects(create({ ...f.recovery, draft: { text: "", revision: 1 } }), /没有待恢复的输入/);
  await assert.rejects(create({ ...f.recovery, pendingSend: { id: "pending" } }), /待确认发送/);
  await assert.rejects(create({ ...f.recovery, registration: { source: "empty", model: {} } }), /缺少原模型/);
});

test("真实历史优先于旧empty登记，不因待确认快照或空输入改建会话", async (t) => {
  const f = await setup(t);
  const manager = addHistory(f.SessionManager, f.sessionDir, f.workspaceDir, f.recovery.sessionId);
  const file = manager.getSessionFile();
  const before = await fs.readFile(file, "utf8");
  const result = await f.createWorkspaceSession({
    sessionDir: f.sessionDir, workspaceDir: f.workspaceDir,
    recovery: { ...f.recovery, draft: { text: "", revision: 2 }, pendingSend: { id: "pending" } },
  });
  assert.equal(result.source, "history");
  assert.equal(result.sessionManager.getSessionFile(), file);
  assert.equal(result.sessionManager.buildSessionContext().messages[0].content, "临时历史");
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("同编号跨目录历史拒绝绑定，不能退回重建；重复编号历史也拒绝", async (t) => {
  const f = await setup(t);
  const manager = addHistory(f.SessionManager, f.sessionDir, f.other, f.recovery.sessionId);
  const file = manager.getSessionFile();
  const before = await fs.readFile(file, "utf8");
  const create = () => f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery: f.recovery });
  await assert.rejects(create(), /属于其他工作目录/);
  assert.equal(await fs.readFile(file, "utf8"), before);
  await fs.copyFile(file, path.join(f.sessionDir, "duplicate.jsonl"));
  await assert.rejects(create(), /多份相同编号/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("无应用绑定的同编号历史拒绝认领，拒绝前不迁移原文件", async (t) => {
  const f = await setup(t);
  const manager = f.SessionManager.create(f.workspaceDir, f.sessionDir, { id: f.recovery.sessionId });
  manager.appendMessage({ role: "user", content: "旧历史", timestamp: Date.now() });
  const file = manager.getSessionFile();
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery: f.recovery }), /缺少工作目录绑定/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("列表候选与实际文件编号不一致时只读拒绝，不认领另一个会话", async (t) => {
  const f = await setup(t);
  const manager = addHistory(f.SessionManager, f.sessionDir, f.workspaceDir, "another-id");
  const file = manager.getSessionFile();
  const before = await fs.readFile(file, "utf8");
  const listAll = f.SessionManager.listAll;
  // 模拟列表与后续文件头不一致；绑定检查不能只信列表中的编号。
  f.SessionManager.listAll = async () => [{ id: f.recovery.sessionId, path: file }];
  try {
    await assert.rejects(f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery: f.recovery }), /文件编号与恢复登记不一致/);
    assert.equal(await fs.readFile(file, "utf8"), before);
  } finally {
    f.SessionManager.listAll = listAll;
  }
});

test("目录失效、登记目录不符、无效编号或混用恢复方式均拒绝并保留状态", async (t) => {
  const f = await setup(t);
  const stateFile = path.join(f.base, "state", "original-id.json");
  const before = await fs.readFile(stateFile, "utf8");
  const options = { sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery: f.recovery };
  await assert.rejects(f.createWorkspaceSession({ ...options, workspaceDir: path.join(f.base, "missing") }), { code: "ENOENT" });
  await assert.rejects(f.createWorkspaceSession({ ...options, workspaceDir: f.other }), /不属于当前真实工作目录/);
  await assert.rejects(f.createWorkspaceSession({ ...options, recovery: null }), /缺少原会话编号/);
  await assert.rejects(f.createWorkspaceSession({ ...options, recovery: { ...f.recovery, sessionId: "../bad" } }));
  await assert.rejects(f.createWorkspaceSession({ ...options, resume: true }), /不能同时指定/);
  await assert.rejects(f.createWorkspaceSession({ ...options, sessionPath: "unused" }), /不能同时指定/);
  assert.equal(await fs.readFile(stateFile, "utf8"), before);
});

test("真实SDK恢复原模型；真实历史遵循分支而非旧登记；无效模型不回退", async (t) => {
  const f = await setup(t);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const fs = require("node:fs/promises");
    globalThis.fetch = async () => assert.fail("测试不得请求模型或网络");
    async function check() {
      const { createPiAgent } = await import(${JSON.stringify(root + "/src/main/pi-agent.mjs")});
      const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
      const base = process.argv[1], workspace = path.join(base, "workspace"), dir = path.join(base, "sessions");
      const store = createSessionStateStore(path.join(base, "state"));
      const recovery = await store.load("original-id");
      const stateFile = path.join(base, "state", "original-id.json"), before = await fs.readFile(stateFile, "utf8");
      const create = value => createPiAgent(dir, false, undefined, workspace, undefined, value);
      const first = await create(recovery);
      assert.equal(first.sessionId, recovery.sessionId);
      assert.equal(first.desktopSessionOrigin, "empty");
      assert.equal(first.model.id, "deepseek-v4-pro");
      assert.equal(first.model.baseUrl, "https://example.invalid/v1");
      assert.deepEqual(first.messages, []);
      await assert.rejects(fs.stat(first.sessionFile), { code: "ENOENT" });
      first.dispose();
      for (const model of [{ provider: "deepseek", modelId: "missing-model" }, { provider: "openai", modelId: "gpt-4" }]) {
        await assert.rejects(create({ ...recovery, registration: { source: "empty", model } }), /Pi 未找到模型|其他供应商/);
        assert.equal(await fs.readFile(stateFile, "utf8"), before);
      }
      // 同编号产生真实历史后，当前分支Flash优先于旧快照Pro。
      const manager = first.sessionManager;
      const branch = manager.getBranch().find(e => e.type === "model_change").id;
      manager.appendModelChange("deepseek", "deepseek-flash");
      const flash = manager.getLeafId();
      manager.appendModelChange("deepseek", "deepseek-v4-pro");
      manager.branch(flash);
      manager.appendMessage({ role: "user", content: "分支历史", timestamp: Date.now() });
      assert.ok(branch);
      const historyBefore = await fs.readFile(first.sessionFile, "utf8");
      const reopened = await create({ ...recovery, pendingSend: { id: "pending" } });
      assert.equal(reopened.desktopSessionOrigin, "history");
      assert.equal(reopened.model.id, "deepseek-flash");
      assert.equal(reopened.sessionId, recovery.sessionId);
      assert.equal(reopened.messages[0].content, "分支历史");
      reopened.dispose();
      assert.equal(await fs.readFile(first.sessionFile, "utf8"), historyBefore);
      assert.equal(await fs.readFile(stateFile, "utf8"), before);
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runFile(process.execPath, ["-e", script, f.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(f.base, "pi-config"), PI_OFFLINE: "1", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid/v1", DEEPSEEK_API_KEY: "test-placeholder", AGENT_WORKSPACE_DIR: f.workspaceDir },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
});

test("真实SDK按配置编号重建，同名模型不串地址和凭据，配置丢失明确拒绝", async (t) => {
  const f = await setup(t);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const fs = require("node:fs/promises");
    globalThis.fetch = async () => assert.fail("测试不得请求模型或网络");
    async function check() {
      const { createPiAgent } = await import(${JSON.stringify(root + "/src/main/pi-agent.mjs")});
      const { createModelSettingsStore, PROFILE_PREFIX } = require(${JSON.stringify(root + "/src/main/storage/model-settings-store.js")});
      const { createModelSettingsService } = require(${JSON.stringify(root + "/src/main/services/model-settings-service.js")});
      const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
      const base = process.argv[1], workspace = path.join(base, "workspace"), dir = path.join(base, "sessions");
      const settings = createModelSettingsService(createModelSettingsStore(path.join(base, "models.json"), {
        isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: buffer => buffer.toString(),
      }, { PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash" }));
      const input = { name: "A", kind: "custom", provider: "同名供应商", modelId: "same-model", baseUrl: "https://a.example.invalid/v1", authMode: "saved", apiKey: "placeholder-A", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 };
      const a = await settings.save(input);
      const b = await settings.save({ ...input, name: "B", baseUrl: "https://b.example.invalid/v1", apiKey: "placeholder-B" });
      await settings.setDefault(a.id);
      const store = createSessionStateStore(path.join(base, "state"));
      await store.registerSession("original-id", workspace, "empty", { provider: PROFILE_PREFIX + b.id, modelId: input.modelId });
      const recovery = await store.load("original-id");
      const stateFile = path.join(base, "state", "original-id.json"), before = await fs.readFile(stateFile, "utf8");
      const session = await createPiAgent(dir, false, undefined, workspace, settings, recovery);
      assert.equal(session.sessionId, recovery.sessionId);
      assert.equal(session.model.provider, PROFILE_PREFIX + b.id);
      assert.equal(session.model.baseUrl, "https://b.example.invalid/v1");
      assert.ok((await session.modelRuntime.getAuth(session.model)).auth.apiKey === "placeholder-B");
      assert.deepEqual(session.messages, []);
      await assert.rejects(fs.stat(session.sessionFile), { code: "ENOENT" });
      session.dispose();
      const missing = { ...recovery, registration: { source: "empty", model: { provider: PROFILE_PREFIX + "missing", modelId: input.modelId } } };
      await assert.rejects(createPiAgent(dir, false, undefined, workspace, settings, missing), /配置不存在/);
      assert.equal(await fs.readFile(stateFile, "utf8"), before);
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runFile(process.execPath, ["-e", script, f.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(f.base, "pi-config"), PI_OFFLINE: "1", DEEPSEEK_API_KEY: "test-placeholder", AGENT_WORKSPACE_DIR: f.workspaceDir },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
});
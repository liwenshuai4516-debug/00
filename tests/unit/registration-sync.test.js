const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-registration-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createSessionStateStore(path.join(root, "state"));
  const models = [{ provider: "deepseek", id: "flash" }, { provider: "deepseek", id: "pro" }];
  const session = {
    sessionId: "a", desktopSessionOrigin: "empty", model: models[0], entries: [], messages: [], switches: 0,
    sessionManager: { getCwd: () => root, getEntries: () => session.entries },
    modelRuntime: { getModel: (_provider, id) => models.find(model => model.id === id) },
    async setModel(model) { session.switches += 1; session.model = model; },
    async abort() {}, dispose() {},
  };
  session.desktopModelSettings = {
    async switchProfile(agent, id) {
      agent.model = { provider: `desktop-profile-${id}`, id: "same-model" };
      return { provider: "展示供应商", modelId: "same-model" };
    },
  };
  const sessions = createSessionService("unused", async () => session, () => root, undefined, store);
  const composer = createComposerDraftService(sessions, store);
  await composer.loadCurrentDraft();
  await composer.saveDraft("a", "原文", 0);
  const state = { root, store, session, sessions, composer, calls: 0 };
  state.sender = async () => {
    session.entries.push({ type: "message", message: { role: "user", content: "本地测试消息" } });
  };
  state.chat = createChatService(sessions, async () => async (...args) => {
    state.calls += 1;
    await state.sender(...args);
  }, undefined, store);
  state.send = () => state.chat.send("原文", () => {}, () => {}, () => {}, { sessionId: "a", revision: 1 });
  return state;
}

test("已保存输入后只切换模型或配置，也同步实际选择且保留版本与快照", async (t) => {
  const s = await setup(t);
  await s.store.consumeDraft("a", s.root, "原文", 1);
  await s.store.saveDraft("a", s.root, "后来输入", 2);
  const before = await s.store.load("a");
  await s.sessions.switchModel("pro");
  assert.equal((await s.store.load("a")).registration.model.modelId, "pro");
  await s.sessions.switchModelProfile("selected");
  const after = await s.store.load("a");
  assert.deepEqual(after.registration.model, { provider: "desktop-profile-selected", modelId: "same-model" });
  assert.deepEqual(after.draft, before.draft);
  assert.deepEqual(after.pendingSend, before.pendingSend);
});

test("SDK部分更新后失败仍同步实际选择，未更新时保留原错误对象", async (t) => {
  const s = await setup(t);
  const error = new Error("SDK更新后失败");
  s.session.setModel = async model => { s.session.model = model; throw error; };
  await assert.rejects(s.sessions.switchModel("pro"), actual => actual === error);
  assert.equal((await s.store.load("a")).registration.model.modelId, "pro");
  const before = new Error("SDK更新前失败");
  s.session.setModel = async () => { throw before; };
  await assert.rejects(s.sessions.switchModel("flash"), actual => actual === before);
  assert.equal((await s.store.load("a")).registration.model.modelId, "pro");
});

test("登记发布失败保留原输入，可用相同选择重试且不再次setModel", async (t) => {
  const s = await setup(t);
  const rename = t.mock.method(fs, "rename", async () => { throw new Error("磁盘发布失败"); });
  await assert.rejects(s.sessions.switchModel("pro"), /模型可能已切换.*同步失败.*磁盘发布失败/);
  assert.equal(s.session.model.id, "pro");
  assert.equal((await s.store.load("a")).registration.model.modelId, "flash");
  rename.mock.restore();
  await s.sessions.switchModel("pro");
  assert.equal(s.session.switches, 1);
  assert.equal((await s.store.load("a")).registration.model.modelId, "pro");
  assert.deepEqual((await s.store.load("a")).draft, { text: "原文", revision: 1 });
});

test("切换与登记同时失败时提示保留两个原因", async (t) => {
  const s = await setup(t);
  s.session.setModel = async model => { s.session.model = model; throw new Error("SDK错误"); };
  t.mock.method(fs, "rename", async () => { throw new Error("存储错误"); });
  await assert.rejects(s.sessions.switchModel("pro"), /SDK错误.*同步失败.*存储错误/);
});

test("没有输入记录的同步不新建空状态条目", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sync-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "state");
  const store = createSessionStateStore(directory);
  const session = {
    sessionId: "empty", desktopSessionOrigin: "empty", model: { provider: "p", id: "m" },
    sessionManager: { getCwd: () => root, getEntries: () => [] },
  };
  const service = createSessionService("unused", async () => session, () => root, undefined, store);
  await service.getSession();
  await service.syncSessionRegistration("empty");
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("首次发送先推进history再清快照，即使没有后续输入也保存来源", async (t) => {
  const s = await setup(t);
  const complete = s.store.completeSend;
  t.mock.method(s.store, "completeSend", async (...args) => {
    assert.equal((await s.store.load("a")).registration.source, "history");
    return complete(...args);
  });
  const result = await s.send();
  assert.equal(result.outcome, "completed");
  assert.equal(result.warning, undefined);
  const state = await s.store.load("a");
  assert.equal(state.registration.source, "history");
  assert.equal(state.pendingSend, null);
});

test("首次发送失败保留未确认快照，同时登记已存在的用户消息", async (t) => {
  const s = await setup(t);
  const original = s.sender;
  s.sender = async () => { await original(); throw new Error("连接中断"); };
  const result = await s.send();
  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.error, /连接中断/);
  const state = await s.store.load("a");
  assert.equal(state.registration.source, "history");
  assert.equal(state.pendingSend.id, result.draft.sendId);
  assert.equal(s.calls, 1);
});

test("生成期间停止保留新输入并同步history，初始化期间停止仍为empty", async (t) => {
  const s = await setup(t);
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const original = s.sender;
  s.sender = async () => { await original(); entered.resolve(); await finished.promise; };
  s.session.abort = async () => finished.resolve();
  const pending = s.send();
  await entered.promise;
  await s.store.saveDraft("a", s.root, "停止前的新输入", 2);
  await s.chat.stop();
  assert.equal((await pending).outcome, "stopped");
  const saved = await s.store.load("a");
  assert.equal(saved.registration.source, "history");
  assert.equal(saved.pendingSend, null);
  assert.equal(saved.draft.text, "停止前的新输入");

  const other = await setup(t);
  const loading = Promise.withResolvers();
  const ready = Promise.withResolvers();
  other.sessions.getSession = () => { loading.resolve(); return ready.promise; };
  const stopped = other.send();
  await loading.promise;
  await other.chat.stop();
  ready.resolve(other.session);
  assert.equal((await stopped).outcome, "stopped");
  assert.equal(other.calls, 0);
  assert.equal((await other.store.load("a")).registration.source, "empty");
});

test("回复完成但同步失败保持completed，保留快照且解除前必须同步成功", async (t) => {
  const s = await setup(t);
  const original = s.sender;
  let rename;
  s.sender = async () => {
    await original();
    rename = t.mock.method(fs, "rename", async () => { throw new Error("登记发布失败"); });
  };
  const result = await s.send();
  assert.equal(result.outcome, "completed");
  assert.match(result.warning, /同步失败.*快照未清理/);
  assert.equal(s.chat.isBusy(), false);
  const pending = (await s.store.load("a")).pendingSend;
  assert.ok(pending);
  await assert.rejects(s.composer.dismissSend("a", pending.id), /登记发布失败/);
  assert.equal((await s.store.load("a")).pendingSend.id, pending.id);
  rename.mock.restore();
  await s.composer.dismissSend("a", pending.id);
  const saved = await s.store.load("a");
  assert.equal(saved.registration.source, "history");
  assert.equal(saved.pendingSend, null);
});

test("请求与同步同时失败保留原错误及附加提示，不改成正常完成", async (t) => {
  const s = await setup(t);
  const original = s.sender;
  s.sender = async () => {
    await original();
    t.mock.method(fs, "rename", async () => { throw new Error("同步存储失败"); });
    throw new Error("请求失败");
  };
  const result = await s.send();
  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.error, /请求失败/);
  assert.match(result.warning, /同步存储失败/);
  assert.ok((await s.store.load("a")).pendingSend);
});

test("启动接线向会话、输入和聊天服务注入同一个状态存储", async () => {
  const { readFileSync } = require("node:fs");
  const { runInNewContext } = require("node:vm");
  const store = {};
  const sessions = {};
  const received = {};
  const factories = {
    createWorkspaceSettings: () => ({ load() {}, save() {} }),
    createSessionStateStore: () => store,
    createSessionService(...args) { received.sessions = args; return sessions; },
    createComposerDraftService(...args) { received.composer = args; return {}; },
    createChatService(...args) { received.chat = args; return {}; },
  };
  runInNewContext(readFileSync(path.join(__dirname, "../../src/main/bootstrap.js"), "utf8"), {
    __dirname: path.join(__dirname, "../../src/main"), module: { exports: {} },
    process: { env: {}, platform: "darwin" },
    require(name) {
      if (name === "node:path") return path;
      if (name === "node:process") return { loadEnvFile() {} };
      if (name === "electron") return { app: { getPath: () => os.tmpdir(), whenReady: () => ({ then() {} }), on() {} }, ipcMain: {} };
      return new Proxy({}, { get: (_target, key) => factories[key] ?? (() => ({})) });
    },
  });
  assert.equal(received.sessions[4], store);
  assert.equal(received.composer[1], store);
  assert.equal(received.chat[3], store);
});

test("真实SDK切换后无需编辑输入即可登记，首次发送收尾同步history", async (t) => {
  const { promisify } = require("node:util");
  const { execFile } = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-real-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const project = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    globalThis.fetch = async () => assert.fail("禁止网络和模型请求");
    const { createSessionService } = require(${JSON.stringify(path.join(project, "src/main/services/session-service.js"))});
    const { createComposerDraftService } = require(${JSON.stringify(path.join(project, "src/main/services/composer-draft-service.js"))});
    const { createChatService } = require(${JSON.stringify(path.join(project, "src/main/services/chat-service.js"))});
    const { createSessionStateStore } = require(${JSON.stringify(path.join(project, "src/main/storage/session-state-store.js"))});
    async function check() {
      const root = process.argv[1];
      const store = createSessionStateStore(path.join(root, "state"));
      const service = createSessionService(path.join(root, "sessions"), undefined,
        () => process.env.AGENT_WORKSPACE_DIR, undefined, store);
      const composer = createComposerDraftService(service, store);
      await composer.loadCurrentDraft();
      const session = await service.getSession();
      try {
        const id = session.sessionId;
        await composer.saveDraft(id, "原文", 0);
        await service.switchModel("deepseek-v4-pro");
        const switched = await store.load(id);
        assert.equal(switched.registration.model.modelId, "deepseek-v4-pro");
        assert.deepEqual(switched.draft, { text: "原文", revision: 1 });
        // 仅测试发送边界：真实SDK写入本地用户消息，不调用prompt或远程模型。
        const chat = createChatService(service, async () => async current => {
          current.sessionManager.appendMessage({ role: "user", content: "本地测试", timestamp: Date.now() });
        }, undefined, store);
        const result = await chat.send("原文", () => {}, () => {}, () => {}, { sessionId: id, revision: 1 });
        assert.equal(result.outcome, "completed");
        assert.equal((await store.load(id)).registration.source, "history");
        assert.equal((await store.load(id)).pendingSend, null);
      } finally { session.dispose(); }
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await promisify(execFile)(process.execPath, ["-e", script, root], {
    env: {
      ...process.env, PI_CODING_AGENT_DIR: path.join(root, "pi-config"), PI_OFFLINE: "1",
      PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid/v1",
      DEEPSEEK_API_KEY: "test-only-placeholder", AGENT_WORKSPACE_DIR: workspace,
    }, encoding: "utf8",
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-composer-registration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const directory = path.join(root, "state");
  const store = createSessionStateStore(directory);
  const state = { root, workspace, directory, store, agents: [], failSettings: false };
  state.sessions = createSessionService("unused", async (_dir, _resume, _file, cwd) => {
    const index = state.agents.length;
    const agent = {
      sessionId: `session-${index}`,
      desktopSessionOrigin: "empty",
      model: { provider: `desktop-profile-${index}`, id: "chat-model" },
      entries: [], messages: [], disposed: false,
      sessionManager: { getCwd: () => cwd, getEntries: () => agent.entries },
      dispose() { agent.disposed = true; },
    };
    state.agents.push(agent);
    return agent;
  }, () => workspace, async () => {
    if (state.failSettings) throw new Error("模拟目录配置保存失败");
  });
  state.composer = createComposerDraftService(state.sessions, store);
  state.first = await state.sessions.getSession();
  await state.composer.loadCurrentDraft();
  return state;
}

function addUser(agent) {
  agent.entries.push({ type: "message", message: { role: "user", content: "测试消息" } });
}

test("首次读取不落盘，保存同时登记原编号、目录和实际配置模型", async (t) => {
  const s = await setup(t);
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
  s.first.model = { provider: "desktop-profile-selected", id: "selected-model" };
  const text = " \t输入\r\n\n ";
  assert.deepEqual(await s.composer.saveDraft(s.first.sessionId, text, 0), {
    sessionId: s.first.sessionId, text, revision: 1,
  });
  const saved = await s.store.load(s.first.sessionId);
  assert.equal(saved.workspaceDir, s.workspace);
  assert.deepEqual(saved.registration, {
    source: "empty", model: { provider: "desktop-profile-selected", modelId: "selected-model" },
  });
  assert.deepEqual(await createSessionStateStore(s.directory).load(s.first.sessionId), saved);
});

test("排队期间切换模型，在实际写入时读取最新选择", async (t) => {
  const s = await setup(t);
  const rename = fs.rename;
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let firstRename = true;
  t.mock.method(fs, "rename", async (...args) => {
    if (firstRename) {
      firstRename = false;
      entered();
      await gate;
    }
    return rename(...args);
  });
  const blocking = s.store.update(s.first.sessionId, s.workspace, state => ({ ...state, pinnedAt: 10 }));
  await started;
  const saving = s.composer.saveDraft(s.first.sessionId, "排队输入", 0);
  s.first.model = { provider: "desktop-profile-latest", id: "latest" };
  release();
  await blocking;
  await saving;
  const state = await s.store.load(s.first.sessionId);
  assert.equal(state.registration.model.provider, "desktop-profile-latest");
  assert.equal(state.pinnedAt, 10);
  assert.deepEqual(state.draft, { text: "排队输入", revision: 1 });
});

test("切到 B 后延迟保存 A，仍使用 A 最后实际来源与模型", async (t) => {
  const s = await setup(t);
  s.first.model.id = "a-final";
  addUser(s.first);
  await s.sessions.newChat();
  await s.composer.loadCurrentDraft();
  const second = s.agents[1];
  assert.equal(s.first.disposed, true);
  // 已离开的会话应只保留小型快照，不能让旧实例变化影响 B 或已冻结的登记。
  s.first.model.id = "disposed-object-change";
  await s.composer.saveDraft(s.first.sessionId, "A 迟到输入", 0);
  await s.composer.saveDraft(second.sessionId, "B 输入", 0);
  const a = await s.store.load(s.first.sessionId);
  const b = await s.store.load(second.sessionId);
  assert.deepEqual(a.registration, {
    source: "history", model: { provider: "desktop-profile-0", modelId: "a-final" },
  });
  assert.equal(b.registration.source, "empty");
  assert.equal(b.registration.model.provider, "desktop-profile-1");
  assert.equal(a.draft.text, "A 迟到输入");
  assert.equal(b.draft.text, "B 输入");
});

test("来源只向 history 推进，保存不触碰发送快照和组织状态", async (t) => {
  const s = await setup(t);
  const id = s.first.sessionId;
  await s.composer.saveDraft(id, "原文", 0);
  const consumed = await s.store.consumeDraft(id, s.workspace, "原文", 1);
  await s.store.update(id, s.workspace, state => ({ ...state, pinnedAt: 5, archivedAt: 6 }));
  addUser(s.first);
  await s.composer.saveDraft(id, "后续输入", 2);
  s.first.entries = [];
  await s.composer.saveDraft(id, "", 3);
  const state = await s.store.load(id);
  assert.equal(state.registration.source, "history");
  assert.deepEqual(state.draft, { text: "", revision: 4 });
  assert.deepEqual(state.pendingSend, consumed.pendingSend);
  assert.equal(state.pinnedAt, 5);
  assert.equal(state.archivedAt, 6);
});

test("原本打开历史的会话即使缺少消息也不登记为空，未知来源不补 empty", async (t) => {
  const s = await setup(t);
  s.first.desktopSessionOrigin = "history";
  await s.composer.saveDraft(s.first.sessionId, "历史输入", 0);
  assert.equal((await s.store.load(s.first.sessionId)).registration.source, "history");
  await s.sessions.newChat();
  const second = s.agents[1];
  delete second.desktopSessionOrigin;
  await s.composer.loadCurrentDraft();
  await s.composer.saveDraft(second.sessionId, "保留未知输入", 0);
  assert.equal((await s.store.load(second.sessionId)).registration, undefined);
});

test("无效模型、目录不匹配与旧版本均不写入原文或登记", async (t) => {
  const s = await setup(t);
  const id = s.first.sessionId;
  await s.composer.saveDraft(id, "旧原文", 0);
  const filename = path.join(s.directory, `${id}.json`);
  const before = await fs.readFile(filename, "utf8");
  const originalModel = s.first.model;
  s.first.model = null;
  await assert.rejects(s.composer.saveDraft(id, "新原文", 1), /恢复登记无效/);
  s.first.model = originalModel;
  await assert.rejects(s.store.saveDraft(id, s.workspace, "新原文", 1, () => ({
    ...s.sessions.readSessionRegistration(id), workspaceDir: path.join(s.root, "other"),
  })), /登记的工作目录不匹配/);
  await assert.rejects(s.store.saveDraft(id, s.workspace, "旧版本", 0, () => {
    assert.fail("版本冲突时不应再读取登记");
  }), /版本已变化/);
  assert.equal(await fs.readFile(filename, "utf8"), before);
});

test("发布失败原文和登记都保留，使用同一版本重试可保存最新模型", async (t) => {
  const s = await setup(t);
  const id = s.first.sessionId;
  await s.composer.saveDraft(id, "已保存原文", 0);
  const filename = path.join(s.directory, `${id}.json`);
  const before = await fs.readFile(filename, "utf8");
  s.first.model.id = "next-model";
  const mock = t.mock.method(fs, "rename", async () => { throw new Error("模拟发布失败"); });
  await assert.rejects(s.composer.saveDraft(id, "未保存输入", 1), /模拟发布失败/);
  assert.equal(await fs.readFile(filename, "utf8"), before);
  mock.mock.restore();
  await s.composer.saveDraft(id, "重试输入", 1);
  const state = await s.store.load(id);
  assert.equal(state.registration.model.modelId, "next-model");
  assert.deepEqual(state.draft, { text: "重试输入", revision: 2 });
});

test("切换目录准备失败仍读取原会话，不登记未采用的候选", async (t) => {
  const s = await setup(t);
  s.failSettings = true;
  await assert.rejects(s.sessions.switchWorkspace(s.workspace), /模拟目录配置保存失败/);
  assert.equal(s.agents[1].disposed, true);
  assert.equal(s.sessions.readSessionRegistration(s.first.sessionId).model.provider, "desktop-profile-0");
  assert.equal(s.sessions.readSessionRegistration(s.agents[1].sessionId), undefined);

});

test("模型切换部分失败后，下一次输入保存取实际模型；返回副本不可改内部登记", async (t) => {
  const s = await setup(t);
  s.first.desktopModelSettings = {
    async switchProfile(agent) {
      agent.model = { provider: "desktop-profile-partial", id: "partial-model" };
      throw new Error("模拟更新后失败");
    },
  };
  await assert.rejects(s.sessions.switchModelProfile("selected"), /模拟更新后失败/);
  const descriptor = s.sessions.readSessionRegistration(s.first.sessionId);
  descriptor.model.provider = "caller-change";
  await s.composer.saveDraft(s.first.sessionId, "保留实际选择", 0);
  assert.equal((await s.store.load(s.first.sessionId)).registration.model.provider, "desktop-profile-partial");
});


test("真实 SDK 重新打开同编号后，保存使用新实例的实际来源和模型", async (t) => {
  const { promisify } = require("node:util");
  const { execFile } = require("node:child_process");
  const runFile = promisify(execFile);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-real-registration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const project = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    globalThis.fetch = async () => assert.fail("测试禁止访问网络和模型");
    const { createSessionService } = require(${JSON.stringify(path.join(project, "src/main/services/session-service.js"))});
    const { createComposerDraftService } = require(${JSON.stringify(path.join(project, "src/main/services/composer-draft-service.js"))});
    const { createSessionStateStore } = require(${JSON.stringify(path.join(project, "src/main/storage/session-state-store.js"))});
    async function check() {
      const root = process.argv[1];
      const sessions = createSessionService(path.join(root, "sessions"));
      const store = createSessionStateStore(path.join(root, "state"));
      const composer = createComposerDraftService(sessions, store);
      await composer.loadCurrentDraft();
      const first = await sessions.getSession();
      const id = first.sessionId;
      await composer.saveDraft(id, "原输入", 0);
      first.sessionManager.appendMessage({ role: "user", content: "本地测试消息", timestamp: Date.now() });
      await sessions.newChat();
      await composer.loadCurrentDraft();
      await sessions.openSession(id);
      await composer.loadCurrentDraft();
      const reopened = await sessions.getSession();
      try {
        assert.notEqual(reopened, first);
        await sessions.switchModel("deepseek-v4-pro");
        await composer.saveDraft(id, "重新打开后的输入", 1);
        const saved = await store.load(id);
        assert.equal(saved.registration.source, "history");
        assert.equal(saved.registration.model.provider, "deepseek");
        assert.equal(saved.registration.model.modelId, "deepseek-v4-pro");
        assert.deepEqual(saved.draft, { text: "重新打开后的输入", revision: 2 });
      } finally {
        reopened.dispose();
      }
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runFile(process.execPath, ["-e", script, root], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(root, "pi-config"),
      PI_OFFLINE: "1", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash",
      PI_BASE_URL: "https://example.invalid/v1", DEEPSEEK_API_KEY: "test-placeholder",
      AGENT_WORKSPACE_DIR: workspace,
    },
    encoding: "utf8",
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const runFile = promisify(execFile);
const model = { provider: "deepseek", modelId: "deepseek-v4-pro" };

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "unsent-service-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace"), other = path.join(base, "other");
  await fs.mkdir(workspace); await fs.mkdir(other);
  const store = createSessionStateStore(path.join(base, "state"));
  const s = { base, workspace, other, store, calls: [], sessions: [], selected: workspace };
  s.factory = async (...args) => {
    s.calls.push(args);
    s.enter?.();
    if (s.gate) await s.gate;
    if (s.failCreate) throw new Error("模拟模型失效");
    const session = {
      sessionId: s.wrongId ? "wrong-id" : args[4]?.sessionId ?? "active",
      desktopSessionOrigin: s.unknownSource ? undefined : s.history ? "history" : "empty",
      model: { provider: model.provider, id: model.modelId },
      sessionManager: {
        getCwd: () => s.wrongDirectory ? s.other : args[3],
        getEntries: () => [],
      },
      get messages() {
        if (s.failHistory) throw new Error("模拟历史读取失败");
        return s.history ? [{ role: "user", content: "历史优先" }] : [];
      },
      disposed: false,
      dispose() { this.disposed = true; },
    };
    s.sessions.push(session);
    return session;
  };
  s.service = createSessionService(path.join(base, "sessions"), s.factory, () => s.selected, undefined, store);
  s.save = async (id, text, source = "empty", workspaceDir = workspace) => {
    await store.registerSession(id, workspaceDir, source, model);
    return store.saveDraft(id, workspaceDir, text, 0);
  };
  return s;
}

test("列表不创建Agent，只列同目录可信empty，真实历史去重并标明待确认发送", async (t) => {
  const s = await setup(t);
  await s.save("a", " 第一行\n第二行");
  await s.save("blank", " \t\r\n");
  await s.save("empty", "");
  await s.save("history-source", "历史输入", "history");
  await s.save("other", "其他目录", "empty", s.other);
  await s.store.saveDraft("unknown", s.workspace, "未知来源", 0);
  await s.save("archived", "归档输入");
  await s.store.update("archived", s.workspace, state => ({ ...state, archivedAt: 1 }));
  await s.save("pending", "发送原文");
  await s.store.consumeDraft("pending", s.workspace, "发送原文", 1);
  await s.save("real-history", "旧empty快照");
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const history = await createWorkspaceSession({ sessionDir: path.join(s.base, "sessions"), workspaceDir: s.workspace, recovery: await s.store.load("real-history") });
  history.sessionManager.appendMessage({ role: "user", content: "本地历史", timestamp: Date.now() });
  const before = await s.store.list();
  assert.deepEqual(await s.service.listUnsentSessions(), [
    { id: "a", title: "第一行", workspaceDir: s.workspace, blockedReason: "" },
    { id: "blank", title: "未发送对话", workspaceDir: s.workspace, blockedReason: "" },
    { id: "pending", title: "未发送对话", workspaceDir: s.workspace, blockedReason: "仍有待确认发送，暂不能重建。" },
  ]);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await s.store.list(), before);
});

test("已有会话时目录以实际绑定为准，配置改变不把其他目录混入列表", async (t) => {
  const s = await setup(t);
  const current = await s.service.getSession();
  await s.save("a", "本目录");
  await s.save("b", "其他目录", "empty", s.other);
  s.selected = s.other;
  assert.deepEqual((await s.service.listUnsentSessions()).map(row => row.id), ["a"]);
  assert.equal(await s.service.getSession(), current);
  assert.equal(s.calls.length, 1);
});

test("恢复后才释放原会话；新旧会话输入独立，迟到保存不串会话", async (t) => {
  const s = await setup(t);
  const composer = createComposerDraftService(s.service, s.store);
  const old = await composer.loadCurrentDraft();
  const previous = await s.service.getSession();
  await composer.saveDraft(old.sessionId, "旧会话输入", 0);
  const original = await s.save("target", " 原输入\r\n");
  const result = await s.service.restoreUnsentSession("target");
  assert.deepEqual(result, { sessionId: "target", workspaceDir: s.workspace, history: [] });
  assert.equal(previous.disposed, true);
  assert.deepEqual(s.calls[1], [path.join(s.base, "sessions"), false, undefined, s.workspace, original]);
  assert.deepEqual(await composer.loadCurrentDraft(), { sessionId: "target", text: " 原输入\r\n", revision: 1 });
  await composer.saveDraft(old.sessionId, "旧会话迟到输入", 1);
  assert.equal((await s.store.load("target")).draft.text, original.draft.text);
  assert.equal((await s.store.load(old.sessionId)).draft.text, "旧会话迟到输入");
});

test("重复打开当前编号不重建、不释放，也不改输入版本", async (t) => {
  const s = await setup(t);
  const current = await s.service.getSession();
  const before = await s.save(current.sessionId, "保留输入");
  await s.service.restoreUnsentSession(current.sessionId);
  assert.equal(await s.service.getSession(), current);
  assert.equal(current.disposed, false);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(await s.store.load(current.sessionId), before);
});

test("编号不存在、其他目录及归档拒绝恢复，不替换原会话", async (t) => {
  const s = await setup(t);
  const previous = await s.service.getSession();
  await s.save("other", "保留", "empty", s.other);
  await s.save("archived", "保留");
  await s.store.update("archived", s.workspace, state => ({ ...state, archivedAt: 1 }));
  const before = await s.store.list();
  for (const [id, error] of [["missing", /未找到/], ["../bad", /无效的会话编号/], ["other", /其他工作目录/], ["archived", /已归档/]]) {
    await assert.rejects(s.service.restoreUnsentSession(id), error);
  }
  assert.deepEqual(await s.store.list(), before);
  assert.equal(await s.service.getSession(), previous);
  assert.equal(previous.disposed, false);
  assert.equal(s.calls.length, 1);
});

test("创建、历史、编号、目录、可信来源及登记保存失败均保留旧会话，释放候选", async (t) => {
  const s = await setup(t);
  const previous = await s.service.getSession();
  await s.save("target", "保留输入");
  const filename = path.join(s.base, "state", "target.json"), before = await fs.readFile(filename, "utf8");
  for (const flag of ["failCreate", "failHistory", "wrongId", "wrongDirectory", "unknownSource", "failRegistration"]) {
    s[flag] = true;
    const size = s.sessions.length;
    const register = s.store.registerSession;
    if (flag === "failRegistration") s.store.registerSession = async () => { throw new Error("模拟登记写入失败"); };
    try {
      await assert.rejects(s.service.restoreUnsentSession("target"));
      assert.equal(await s.service.getSession(), previous);
      assert.equal(previous.disposed, false);
      assert.equal(await fs.readFile(filename, "utf8"), before);
      if (s.sessions.length > size) assert.equal(s.sessions.at(-1).disposed, true);
    } finally {
      s.store.registerSession = register;
      s[flag] = false;
    }
  }
});

test("准备恢复期间的新输入与组织字段合并保留，历史来源及时推进", async (t) => {
  const s = await setup(t);
  await s.service.getSession();
  await s.save("target", "旧快照");
  let release;
  s.gate = new Promise(resolve => { release = resolve; });
  s.history = true;
  let markEntered;
  const entered = new Promise(resolve => { markEntered = resolve; });
  s.enter = markEntered;
  const restoring = s.service.restoreUnsentSession("target");
  // 等待工厂进入异步准备，随后模拟原会话的迟到输入保存。
  await entered;
  await s.store.saveDraft("target", s.workspace, "后来输入", 1);
  await s.store.update("target", s.workspace, state => ({ ...state, pinnedAt: 100 }));
  release();
  assert.deepEqual((await restoring).history, [{ role: "user", text: "历史优先" }]);
  const after = await s.store.load("target");
  assert.deepEqual(after.draft, { text: "后来输入", revision: 2 });
  assert.equal(after.pinnedAt, 100);
  assert.equal(after.registration.source, "history");
});

test("目录失效与未注入存储时明确拒绝，保留输入而不初始化Agent", async (t) => {
  const s = await setup(t);
  await s.save("target", "保留输入");
  await fs.rmdir(s.workspace);
  await assert.rejects(s.service.listUnsentSessions(), { code: "ENOENT" });
  await assert.rejects(s.service.restoreUnsentSession("target"), { code: "ENOENT" });
  assert.equal((await s.store.load("target")).draft.text, "保留输入");
  assert.equal(s.calls.length, 0);
  const bare = createSessionService("unused");
  await assert.rejects(bare.listUnsentSessions(), /尚未配置会话状态存储/);
  await assert.rejects(bare.restoreUnsentSession("target"), /尚未配置会话状态存储/);
});

test("默认工厂接通真实SDK：原编号原模型、历史优先和拒绝不安全重建", async (t) => {
  const s = await setup(t);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs/promises");
    const { createSessionService } = require(${JSON.stringify(root + "/src/main/services/session-service.js")});
    const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
    globalThis.fetch = async () => assert.fail("不得请求模型或网络");
    async function check() {
      const base = process.argv[1], workspace = path.join(base, "workspace"), dir = path.join(base, "sessions");
      const store = createSessionStateStore(path.join(base, "state"));
      const make = () => createSessionService(dir, undefined, () => workspace, undefined, store);
      const service = make(), previous = await service.getSession();
      const model = { provider: "deepseek", modelId: "deepseek-v4-pro" };
      await store.registerSession("target", workspace, "empty", model);
      await store.saveDraft("target", workspace, " 原输入\\r\\n", 0);
      const before = await store.load("target");
      await service.restoreUnsentSession("target");
      const restored = await service.getSession();
      assert.equal(restored.sessionId, "target");assert.equal(restored.model.id, model.modelId);
      assert.deepEqual(restored.messages, []);
      await assert.rejects(fs.stat(restored.sessionFile), { code: "ENOENT" });
      assert.deepEqual(await store.load("target"), before);
      // 记录损坏来源/模型或待确认发送时均拒绝，原会话保持可用。
      for (const [id, source, selection, pending] of [
        ["missing-model", "empty", { ...model, modelId: "not-registered" }, false],
        ["lost-history", "history", model, false],
        ["pending", "empty", model, true],
      ]) {
        await store.registerSession(id, workspace, source, selection);
        await store.saveDraft(id, workspace, "保留", 0);
        if (pending) await store.consumeDraft(id, workspace, "保留", 1);
        const saved = await store.load(id);
        await assert.rejects(service.restoreUnsentSession(id));
        assert.equal(await service.getSession(), restored);
        assert.deepEqual(await store.load(id), saved);
      }
      restored.sessionManager.appendModelChange("deepseek", "deepseek-flash");
      restored.sessionManager.appendMessage({ role: "user", content: "临时真实历史", timestamp: Date.now() });
      restored.dispose();
      const reopen = make();
      await reopen.restoreUnsentSession("target");
      const real = await reopen.getSession();
      assert.equal(real.model.id, "deepseek-flash");assert.equal(real.messages[0].content, "临时真实历史");
      assert.equal((await store.load("target")).registration.source, "history");
      assert.equal((await reopen.listUnsentSessions()).some(row => row.id === "target"), false);
      real.dispose(); previous.dispose();
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runFile(process.execPath, ["-e", script, s.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(s.base, "pi-config"), PI_OFFLINE: "1", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid/v1", DEEPSEEK_API_KEY: "test-placeholder", AGENT_WORKSPACE_DIR: s.workspace },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
});

test("实际启动工厂按官方供应商恢复同名模型与输入", async (t) => {
  const s = await setup(t);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs/promises");
    const { createSessionService } = require(${JSON.stringify(root + "/src/main/services/session-service.js")});
    const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
    globalThis.fetch = async () => assert.fail("不得请求模型或网络");
    async function check() {
      const base = process.argv[1], workspace = path.join(base, "workspace");
      const provider = (baseUrl, apiKey) => ({ baseUrl, apiKey, api: "openai-completions", models: [{ id: "same" }] });
      await fs.mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {
        alpha: provider("https://a.example.invalid/v1", "placeholder-A"), beta: provider("https://b.example.invalid/v1", "placeholder-B"),
      } }));
      // 提取实际工厂并注入宿主依赖，不执行 bootstrap 或读取 .env。
      const source = await fs.readFile(${JSON.stringify(root + "/src/main/bootstrap.js")}, "utf8");
      const begin = source.indexOf("async function createConfiguredAgent("), end = source.indexOf("\\n\\n// 在应用入口", begin);
      const factorySource = source.slice(begin, end).replace('import("./pi-agent.mjs")', 'import(' + JSON.stringify(${JSON.stringify(root + "/src/main/pi-agent.mjs")}) + ')');
      let ready = 0;
      const store = createSessionStateStore(path.join(base, "state"));
      const factory = new Function(
        "app", "require", "dialog", "promptSettingsStore", "sessionStateStore", "extensionUi",
        "return (" + factorySource + ");",
      )(
        { whenReady: async () => { ready += 1; }, quit() {} },
        require("node:module").createRequire(${JSON.stringify(root + "/src/main/bootstrap.js")}),
        { showMessageBox: async () => ({ response: 0, checkboxChecked: false }) },
        { read: async () => ({ version: 1, revision: 0, testAgentPrompt: "隔离测试提示词" }) }, store, {},
      );
      await store.registerSession("target", workspace, "empty", { provider: "beta", modelId: "same" });
      await store.saveDraft("target", workspace, "保留输入", 0);
      const service = createSessionService(path.join(base, "sessions"), factory, () => workspace, undefined, store);
      await service.restoreUnsentSession("target");
      const restored = await service.getSession();
      assert.equal(restored.sessionId, "target");assert.equal(restored.model.provider, "beta");
      assert.equal(restored.model.baseUrl, "https://b.example.invalid/v1");
      assert.ok((await restored.modelRuntime.getAuth(restored.model)).auth.apiKey === "placeholder-B");
      assert.equal(ready, 1);assert.deepEqual(restored.messages, []);
      assert.equal((await store.load("target")).draft.text, "保留输入");
      restored.dispose();
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runFile(process.execPath, ["-e", script, s.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(s.base, "pi-config"), PI_OFFLINE: "1", DEEPSEEK_API_KEY: "test-placeholder", AGENT_WORKSPACE_DIR: s.workspace },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
});

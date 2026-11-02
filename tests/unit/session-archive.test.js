const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "session-archive-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace"), other = path.join(base, "other");
  await fs.mkdir(workspace); await fs.mkdir(other);
  const sessionDir = path.join(base, "sessions"), stateDir = path.join(base, "state");
  const store = createSessionStateStore(stateDir);
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const histories = [];
  for (const [id, cwd, time] of [["a", workspace, 2000], ["b", workspace, 1000], ["c", other, 3000]]) {
    const timestamp = new Date(time).toISOString();
    const entries = [
      { type: "session", version: 3, id, cwd, timestamp },
      { type: "custom", id: "binding", parentId: null, timestamp, customType: "desktop-workspace-binding", data: { version: 1, workspaceRoot: cwd } },
      { type: "message", id: "u1", parentId: "binding", timestamp, message: { role: "user", content: `历史-${id}`, timestamp: time } },
    ];
    await fs.mkdir(sessionDir, { recursive: true });
    const filename = path.join(sessionDir, `${id}.jsonl`), content = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
    await fs.writeFile(filename, content); histories.push([filename, content]);
  }
  const f = { base, workspace, other, sessionDir, stateDir, store, histories, created: [], calls: [] };
  const factory = async (dir, resume, sessionPath, cwd, recovery, resumeOptions) => {
    f.calls.push([dir, resume, sessionPath, cwd, recovery, resumeOptions]);
    if (f.failCreate) throw Error("模拟创建失败");
    if (f.gate) { f.enter?.(); await f.gate; }
    const result = await createWorkspaceSession({ sessionDir: dir, resume, sessionPath, workspaceDir: cwd, recovery, archivedSessionIds: resumeOptions?.archivedSessionIds });
    const session = {
      sessionId: result.sessionManager.getSessionId(), sessionManager: result.sessionManager,
      desktopSessionOrigin: result.source, model: { provider: "test", id: "model" },
      get messages() { if (f.failHistory) throw Error("模拟历史读取失败"); return result.sessionManager.buildSessionContext().messages; },
      disposed: false, dispose() { this.disposed = true; },
    };
    f.created.push(session); return session;
  };
  f.make = () => createSessionService(sessionDir, factory, () => workspace, async cwd => { f.savedWorkspace = cwd; }, store);
  f.service = f.make(); return f;
}

async function assertHistoryUnchanged(f) {
  for (const [filename, content] of f.histories) assert.equal(await fs.readFile(filename, "utf8"), content);
}

test("归档其他历史不初始化Agent，恢复不切换，保留输入/快照/模型/置顶与历史", async t => {
  const f = await setup(t);
  await f.store.registerSession("b", f.workspace, "history", { provider: "test", modelId: "model" });
  await f.store.saveDraft("b", f.workspace, "发送原文", 0);
  await f.store.consumeDraft("b", f.workspace, "发送原文", 1);
  await f.store.saveDraft("b", f.workspace, "后来输入", 2);
  await f.service.setSessionPinned("b", true);
  const before = await f.store.load("b");
  const result = await f.service.setSessionArchived("b", true);
  assert.equal(result.changed, false); assert.equal(typeof result.archivedAt, "number");
  assert.equal((await f.service.listSessions()).find(row => row.id === "b").archivedAt, result.archivedAt);
  assert.equal((await f.service.setSessionArchived("b", true)).archivedAt, result.archivedAt);
  assert.equal((await f.service.previewSession("b")).history[0].text, "历史-b");
  await assert.rejects(f.service.openSession("b"), /已归档/);
  assert.equal(f.created.length, 0);
  assert.deepEqual(await f.service.setSessionArchived("b", false), { id: "b", archivedAt: null, changed: false });
  assert.deepEqual(await f.store.load("b"), before);
  assert.equal(f.created.length, 0); await assertHistoryUnchanged(f);
});

test("当前会话归档先准备同目录新会话，写成功才释放，撤销保留新会话", async t => {
  const f = await setup(t); const previous = await f.service.getSession(true);
  assert.equal(previous.sessionId, "a");
  await f.store.saveDraft("a", f.workspace, "保留中文\r\n", 0);
  const result = await f.service.setSessionArchived("a", true);
  assert.equal(result.changed, true); assert.notEqual(result.sessionId, "a");
  assert.equal(result.workspaceDir, f.workspace); assert.deepEqual(result.history, []);
  assert.equal(previous.disposed, true);
  assert.equal((await f.store.load("a")).draft.text, "保留中文\r\n");
  const current = await f.service.getSession();
  await f.service.setSessionArchived("a", false);
  assert.equal(await f.service.getSession(), current); assert.equal(current.disposed, false);
  await assertHistoryUnchanged(f);
});

for (const failure of ["create", "history", "write"]) {
  test(`当前归档${failure}失败保留原会话与状态，可重试，候选释放`, async t => {
    const f = await setup(t); const previous = await f.service.getSession(true);
    await f.store.saveDraft("a", f.workspace, "原输入", 0);
    const before = await f.store.load("a");
    f.failCreate = failure === "create"; f.failHistory = failure === "history";
    const rename = failure === "write" ? t.mock.method(fs, "rename", async () => { throw Error("模拟写入失败"); }) : null;
    await assert.rejects(f.service.setSessionArchived("a", true));
    assert.equal(await f.service.getSession(), previous); assert.equal(previous.disposed, false);
    assert.deepEqual(await f.store.load("a"), before);
    if (failure !== "create") assert.equal(f.created.at(-1).disposed, true);
    rename?.mock.restore(); f.failCreate = false; f.failHistory = false;
    assert.equal((await f.service.setSessionArchived("a", true)).changed, true);
    await assertHistoryUnchanged(f);
  });
}

test("候选准备期间的迟到输入和置顶仍合并到原归档状态", async t => {
  const f = await setup(t); await f.service.getSession(true);
  await f.store.saveDraft("a", f.workspace, "旧输入", 0);
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); f.gate = gate.promise; f.enter = entered.resolve;
  const archiving = f.service.setSessionArchived("a", true); await entered.promise;
  await f.store.saveDraft("a", f.workspace, "后来编辑", 1);
  await f.store.update("a", f.workspace, state => ({ ...state, pinnedAt: 123 }));
  gate.resolve(); await archiving;
  const state = await f.store.load("a"); assert.deepEqual(state.draft, { text: "后来编辑", revision: 2 }); assert.equal(state.pinnedAt, 123);
});

test("启动/项目恢复均跳过归档，全部归档创建新会话，当前项目重复点击保留当前", async t => {
  const f = await setup(t);
  await f.service.setSessionArchived("a", true);
  const started = f.make(); assert.equal((await started.getSession(true)).sessionId, "b");
  await started.openWorkspace(f.other); assert.equal(await started.currentSession(), "c");
  await started.openWorkspace(f.workspace); assert.equal(await started.currentSession(), "b");
  await f.service.setSessionArchived("b", true);
  const fresh = f.make(); const current = await fresh.getSession(true);
  assert.ok(!["a", "b"].includes(current.sessionId)); assert.equal(current.desktopSessionOrigin, "empty");
  await fresh.openWorkspace(f.workspace); assert.equal(await fresh.getSession(), current);
  await fresh.openWorkspace(f.other); await fresh.openWorkspace(f.workspace);
  assert.ok(!["a", "b"].includes(await fresh.currentSession()));
  assert.equal((await f.store.load("a")).archivedAt !== null, true); await assertHistoryUnchanged(f);
});

test("状态读取损坏时启动失败，项目恢复失败保留旧会话，不静默恢复归档", async t => {
  const f = await setup(t); const current = await f.service.getSession(true);
  await f.store.saveDraft("b", f.workspace, "保留", 0);
  const filename = path.join(f.stateDir, "b.json"); await fs.writeFile(filename, "{broken");
  await assert.rejects(f.make().getSession(true), /损坏/);
  await assert.rejects(f.service.openWorkspace(f.other), /损坏/);
  assert.equal(await f.service.getSession(), current); assert.equal(current.disposed, false);
  await assert.rejects(f.service.setSessionArchived("b", true), /损坏/);
  assert.equal(await fs.readFile(filename, "utf8"), "{broken");
});

test("无效参数/不存在/空会话/目录冲突拒绝，损坏前不创造恢复替身", async t => {
  const f = await setup(t);
  for (const archived of [undefined, null, 1, "true"]) await assert.rejects(f.service.setSessionArchived("a", archived), /归档状态无效/);
  for (const id of [undefined, "", "missing", "../a"]) await assert.rejects(f.service.setSessionArchived(id, true));
  await f.store.saveDraft("empty", f.workspace, "未发送", 0);
  await assert.rejects(f.service.setSessionArchived("empty", true), /未找到/);
  await f.store.saveDraft("a", f.other, "保留", 0);
  await assert.rejects(f.service.setSessionArchived("a", true), /工作目录不匹配/);
  assert.equal(f.created.length, 0);
});

test("默认与实际启动工厂均把归档过滤交给真实Pi初始化，不请求模型", async t => {
  const f = await setup(t);
  await f.service.setSessionArchived("a", true);
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
    const { createSessionService } = require(${JSON.stringify(root + "/src/main/services/session-service.js")});
    const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
    globalThis.fetch = async () => assert.fail("不能请求模型");
    async function main() {
      const base = process.argv[1], workspace = path.join(base, "workspace");
      const store = createSessionStateStore(path.join(base, "state"));
      const dir = path.join(base, "sessions");
      const service = createSessionService(dir, undefined, () => workspace, undefined, store);
      const session = await service.getSession(true);
      assert.equal(session.sessionId, "b"); session.dispose();
      const source = await fs.readFile(${JSON.stringify(root + "/src/main/bootstrap.js")}, "utf8");
      const start = source.indexOf("async function createConfiguredAgent("), end = source.indexOf("\\n\\n// 在应用入口", start);
      const body = source.slice(start, end).replace('import("./pi-agent.mjs")', 'import(' + JSON.stringify(${JSON.stringify(root + "/src/main/pi-agent.mjs")}) + ')');
      const factory = new Function("app", "modelSettingsService", "return (" + body + ");")({ whenReady: async () => {} }, undefined);
      const configured = createSessionService(dir, factory, () => workspace, async () => {}, store);
      assert.equal((await configured.getSession(true)).sessionId, "b");
      await configured.openWorkspace(path.join(base, "other"));
      await configured.openWorkspace(workspace);
      assert.equal(await configured.currentSession(), "b");
      (await configured.getSession()).dispose();
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await promisify(execFile)(process.execPath, ["-e", script, f.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(f.base, "pi-config"), PI_OFFLINE: "1", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid/v1", DEEPSEEK_API_KEY: "placeholder", AGENT_WORKSPACE_DIR: f.workspace },
    maxBuffer: 1024 * 1024,
  });
  // 实际SDK打开未归档会话时可追加初始化记录；只核对被跳过的归档原文件。
  const [filename, content] = f.histories.find(([filename]) => path.basename(filename) === "a.jsonl");
  assert.equal(await fs.readFile(filename, "utf8"), content);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");

function setup() {
  const handlers = new Map(), calls = [];
  let busy = false;
  const sessionService = {
    listUnsentSessions(...args) { calls.push(["list", ...args]); return []; },
    restoreUnsentSession(...args) { calls.push(["restore", ...args]); return { sessionId: args[0] }; },
    newChat() { calls.push(["new"]); },
  };
  const chatService = {
    isBusy: () => busy,
    send() { calls.push(["send"]); },
    stop() { calls.push(["stop"]); },
  };
  registerAgentIpc({
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `重复注册：${channel}`);
      handlers.set(channel, handler);
    },
  }, sessionService, chatService, {}, {}, {}, {}, {}, {
    saveDraft(...args) { calls.push(["save", ...args]); return { saved: true }; },
  });
  return {
    handlers, calls, sessionService,
    setBusy(value) { busy = value; },
    invoke: (channel, ...args) => handlers.get(`agent:${channel}`)({}, ...args),
  };
}

function loadPreload(invoke) {
  let agent;
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "agent"); agent = value; } },
        ipcRenderer: { invoke },
      };
    },
  });
  return agent;
}

test("生成期间两个入口均拒绝，不进入列表或恢复服务", () => {
  const s = setup();
  s.setBusy(true);
  assert.throws(() => s.invoke("list-unsent-sessions"), /等待当前回复结束/);
  assert.throws(() => s.invoke("restore-unsent-session", "a"), /等待当前回复结束/);
  assert.deepEqual(s.calls, []);
});

test("IPC只转发必要参数，原样返回结果，不把路径、模型和快照交给服务", async () => {
  const s = setup();
  const rows = [{ id: "a", title: "未发送", workspaceDir: "/test", blockedReason: "" }];
  const restored = { sessionId: "a", workspaceDir: "/test", history: [] };
  s.sessionService.listUnsentSessions = (...args) => { assert.deepEqual(args, []); return rows; };
  s.sessionService.restoreUnsentSession = (...args) => { assert.deepEqual(args, ["a"]); return restored; };
  assert.equal(await s.invoke("list-unsent-sessions", "/forged"), rows);
  assert.equal(await s.invoke("restore-unsent-session", "a", "/forged", { model: "forged", draft: "forged" }), restored);
});

for (const method of ["listUnsentSessions", "restoreUnsentSession"]) {
  for (const fails of [false, true]) {
    test(`${method}全程互斥，${fails ? "失败" : "成功"}后释放，输入保存和停止保持独立`, async () => {
      const s = setup();
      const entered = Promise.withResolvers(), finished = Promise.withResolvers();
      s.sessionService[method] = () => { entered.resolve(); return finished.promise; };
      const channel = method === "listUnsentSessions" ? "list-unsent-sessions" : "restore-unsent-session";
      const pending = s.invoke(channel, "a");
      const error = new Error("模拟操作失败");
      const rejected = fails ? assert.rejects(pending, value => value === error) : null;
      await entered.promise;
      try {
        for (const name of [
          "list-unsent-sessions", "restore-unsent-session", "new-chat", "open-session",
          "open-project", "select-workspace", "switch-model", "inspect-unsent-send", "dismiss-unsent-send",
          "compact-session", "export-conversation", "get-proposal", "apply-proposal",
          "discard-proposal", "list-proposals", "inspect-composer-send", "dismiss-composer-send",
        ]) {
          assert.throws(() => s.invoke(name, "a"), /其他操作完成/);
        }
        assert.throws(() => s.invoke("send-message", "不应发送"), /当前操作结束/);
        assert.deepEqual(await s.invoke("save-composer-draft", "old", "后来输入", 3), { saved: true });
        await s.invoke("stop");
        assert.deepEqual(s.calls, [["save", "old", "后来输入", 3], ["stop"]]);
      } finally {
        if (fails) finished.reject(error); else finished.resolve({ done: true });
        if (rejected) await rejected; else assert.deepEqual(await pending, { done: true });
      }
      await s.invoke("new-chat");
      assert.deepEqual(s.calls.at(-1), ["new"]);
    });
  }
}

test("已有切换操作期间拒绝新入口；同步抛错也释放互斥，可显式重试", async () => {
  const s = setup(), finished = Promise.withResolvers();
  s.sessionService.newChat = () => finished.promise;
  const switching = s.invoke("new-chat");
  try {
    assert.throws(() => s.invoke("list-unsent-sessions"), /其他操作完成/);
    assert.throws(() => s.invoke("restore-unsent-session", "a"), /其他操作完成/);
  } finally {
    finished.resolve(); await switching;
  }
  const failure = new Error("同步读取失败");
  s.sessionService.listUnsentSessions = () => { throw failure; };
  await assert.rejects(s.invoke("list-unsent-sessions"), value => value === failure);
  s.sessionService.listUnsentSessions = () => [];
  assert.deepEqual(await s.invoke("list-unsent-sessions"), []);
  assert.deepEqual(await s.invoke("restore-unsent-session", "a"), { sessionId: "a" });
});

test("预加载限定两个固定通道，丢弃额外参数并原样返回结果或拒绝", async () => {
  const calls = [], rows = [], restored = { sessionId: "a" }, failure = new Error("模拟拒绝");
  const agent = loadPreload((...args) => {
    calls.push(args);
    if (args[1] === "bad") return Promise.reject(failure);
    return Promise.resolve(args[0] === "agent:list-unsent-sessions" ? rows : restored);
  });
  assert.equal(await agent.listUnsentSessions("/forged", { model: "forged" }), rows);
  assert.equal(await agent.restoreUnsentSession("a", "/forged", { draft: "forged" }), restored);
  await assert.rejects(agent.restoreUnsentSession("bad"), value => value === failure);
  assert.deepEqual(calls, [
    ["agent:list-unsent-sessions"],
    ["agent:restore-unsent-session", "a"],
    ["agent:restore-unsent-session", "bad"],
  ]);
});

test("实际preload与IPC贯通临时存储：按原编号恢复，待确认拒绝且保留原会话和输入", async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "unsent-ipc-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace"), other = path.join(base, "other");
  await fs.mkdir(workspace); await fs.mkdir(other);
  const directory = path.join(base, "state"), store = createSessionStateStore(directory);
  const selection = { provider: "local-test", modelId: "test-model" };
  for (const [id, root, text] of [["target", workspace, " 原输入\r\n"], ["pending", workspace, "发送快照"], ["other", other, "其他目录输入"]]) {
    await store.registerSession(id, root, "empty", selection);
    await store.saveDraft(id, root, text, 0);
  }
  await store.consumeDraft("pending", workspace, "发送快照", 1);
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const created = [];
  // 复用真实目录和绑定检查，只模拟Agent本身，不初始化模型或请求网络。
  const service = createSessionService(path.join(base, "sessions"), async (dir, resume, sessionPath, workspaceDir, recovery) => {
    const result = await createWorkspaceSession({ sessionDir: dir, resume, sessionPath, workspaceDir, recovery });
    const session = {
      sessionId: result.sessionManager.getSessionId(),
      desktopSessionOrigin: result.source,
      sessionManager: result.sessionManager,
      model: { provider: selection.provider, id: selection.modelId },
      get messages() { return this.sessionManager.buildSessionContext().messages; },
      disposed: false,
      dispose() { this.disposed = true; },
    };
    created.push(session); return session;
  }, () => workspace, undefined, store);
  const composer = createComposerDraftService(service, store), handlers = new Map();
  let sends = 0;
  registerAgentIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, service, {
    isBusy: () => false, send() { sends += 1; },
  }, {}, {}, {}, {}, {}, composer);
  // 模拟Electron invoke的Promise与同步错误转拒绝，实际处理器和预加载保持原样。
  const agent = loadPreload((channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({}, ...args)));
  const rows = await agent.listUnsentSessions("/forged");
  assert.deepEqual(rows.map(row => row.id), ["pending", "target"]);
  assert.match(rows[0].blockedReason, /待确认/);
  assert.equal(created.length, 0);
  const old = await agent.loadComposerDraft();
  await agent.saveComposerDraft(old.sessionId, "旧会话输入", 0);
  const previous = await service.getSession();
  assert.deepEqual(await agent.restoreUnsentSession("target", other, { model: "forged" }), {
    sessionId: "target", workspaceDir: workspace, history: [],
  });
  assert.equal(previous.disposed, true);
  assert.deepEqual(await agent.loadComposerDraft(), { sessionId: "target", text: " 原输入\r\n", revision: 1 });
  await agent.saveComposerDraft(old.sessionId, "迟到输入", 1);
  assert.equal((await store.load("target")).draft.text, " 原输入\r\n");
  const current = await service.getSession(), filename = path.join(directory, "pending.json"), before = await fs.readFile(filename, "utf8");
  await assert.rejects(agent.restoreUnsentSession("pending"), /待确认发送/);
  await assert.rejects(agent.restoreUnsentSession("other"), /其他工作目录/);
  await assert.rejects(agent.restoreUnsentSession("../bad"), /无效的会话编号/);
  assert.equal(await service.getSession(), current);
  assert.equal(current.disposed, false);
  assert.equal(await fs.readFile(filename, "utf8"), before);
  assert.equal(sends, 0);
});
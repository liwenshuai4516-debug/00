const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runInNewContext } = require("node:vm");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "unsent-review-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  await fs.mkdir(workspace);
  const store = createSessionStateStore(path.join(base, "state"));
  const service = createSessionService(path.join(base, "sessions"), () => {
    assert.fail("核对和清理不得创建 Agent");
  }, () => workspace, undefined, store);
  const model = { provider: "offline", modelId: "model" };
  const seed = async (id = "target", directory = workspace, source = "empty") => {
    await store.registerSession(id, directory, source, model);
    await store.saveDraft(id, directory, "  原发送\r\n第二行 <img src=x onerror=alert(1)> ", 0);
    return store.consumeDraft(id, directory, "  原发送\r\n第二行 <img src=x onerror=alert(1)> ", 1);
  };
  return { base, workspace, store, service, seed, filename: id => path.join(base, "state", `${id}.json`) };
}

test("未打开的受阻条目可只读查看完整原文和新输入，不建 Agent 或改写状态", async t => {
  const s = await setup(t), pending = await s.seed();
  await s.store.saveDraft("target", s.workspace, " 后来输入\r\n ", 2);
  const before = await fs.readFile(s.filename("target"));
  const result = await s.service.inspectUnsentSend("target");
  assert.deepEqual(result, {
    sessionId: "target", workspaceDir: s.workspace, text: " 后来输入\r\n ", pendingSend: pending.pendingSend,
  });
  result.pendingSend.text = "不应写回";
  assert.deepEqual(await fs.readFile(s.filename("target")), before);
});

test("清理只删匹配快照，保留草稿版本、模型、提示词及组织字段，不自动恢复", async t => {
  const s = await setup(t), pending = await s.seed();
  await s.store.saveDraft("target", s.workspace, " 后来输入\n", 2);
  await s.store.update("target", s.workspace, state => ({ ...state, pinnedAt: 123,
    promptSnapshot: { version: 1, revision: 0, origin: "new", testAgentPrompt: "保留原测试职责" },
  }));
  const before = await s.store.load("target");
  assert.deepEqual(await s.service.dismissUnsentSend("target", pending.pendingSend.id), {
    sessionId: "target", sendId: pending.pendingSend.id,
  });
  assert.deepEqual(await s.store.load("target"), { ...before, pendingSend: null });
  assert.equal((await s.service.listUnsentSessions())[0].blockedReason, "");
  await assert.rejects(fs.stat(path.join(s.base, "sessions")), { code: "ENOENT" });
});

test("没有新输入时清理后不再列出，但不删除状态或伪造历史", async t => {
  const s = await setup(t), pending = await s.seed();
  await s.service.dismissUnsentSend("target", pending.pendingSend.id);
  assert.deepEqual(await s.service.listUnsentSessions(), []);
  const state = await s.store.load("target");
  assert.equal(state.pendingSend, null);
  assert.deepEqual(state.draft, pending.draft);
  assert.deepEqual(state.registration, pending.registration);
});

test("跨目录、归档、history/未知来源、缺失记录与非法编号均拒绝且不改写", async t => {
  const s = await setup(t);
  await s.seed("other", s.base);
  await s.seed("archived");
  await s.store.update("archived", s.workspace, state => ({ ...state, archivedAt: 1 }));
  await s.seed("history", s.workspace, "history");
  await s.seed("unknown");
  await s.store.update("unknown", s.workspace, ({ registration, ...state }) => state);
  for (const [id, error] of [["other", /其他工作目录/], ["archived", /已归档/], ["history", /可信空会话/], ["unknown", /可信空会话/], ["missing", /未找到/], ["../bad", /无效的会话编号/]]) {
    const before = await s.store.list();
    await assert.rejects(s.service.inspectUnsentSend(id), error);
    await assert.rejects(s.service.dismissUnsentSend(id, "send-id"), error);
    assert.deepEqual(await s.store.list(), before);
  }
});

test("旧 empty 登记出现真实历史时拒绝专用入口，保留快照与历史文件", async t => {
  const s = await setup(t), pending = await s.seed();
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");
  const manager = SessionManager.create(s.workspace, path.join(s.base, "sessions"));
  manager.appendMessage({ role: "user", content: "已有真实消息", timestamp: Date.now() });
  const file = manager.getSessionFile();
  // 临时夹具把 SDK 历史编号设为受阻条目，模拟旧登记未同步的情况。
  const history = (await fs.readFile(file, "utf8")).split("\n");
  history[0] = JSON.stringify({ ...JSON.parse(history[0]), id: "target" });
  await fs.writeFile(file, history.join("\n"));
  const before = await fs.readFile(file);
  await assert.rejects(s.service.inspectUnsentSend("target"), /已有历史/);
  await assert.rejects(s.service.dismissUnsentSend("target", pending.pendingSend.id), /已有历史/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await s.store.load("target")).pendingSend, pending.pendingSend);
});

test("旧确认与新的发送编号不匹配时保留新快照，重复清理不能再次写入", async t => {
  const s = await setup(t), first = await s.seed();
  await s.service.dismissUnsentSend("target", first.pendingSend.id);
  const cleared = await fs.readFile(s.filename("target"));
  await assert.rejects(s.service.dismissUnsentSend("target", first.pendingSend.id), /发送记录已变化/);
  assert.deepEqual(await fs.readFile(s.filename("target")), cleared);
  await s.store.saveDraft("target", s.workspace, "新发送", 2);
  const next = await s.store.consumeDraft("target", s.workspace, "新发送", 3);
  await assert.rejects(s.service.dismissUnsentSend("target", first.pendingSend.id), /发送记录已变化/);
  assert.deepEqual((await s.store.load("target")).pendingSend, next.pendingSend);
});

test("排队期间归档或替换快照后，使用最新状态拒绝旧确认", async t => {
  for (const field of ["archivedAt", "pendingSend"]) {
    const s = await setup(t), pending = await s.seed();
    const update = s.store.update;
    s.store.update = async (id, directory, change) => {
      await update(id, directory, state => field === "archivedAt"
        ? { ...state, archivedAt: 123 }
        : { ...state, pendingSend: { ...state.pendingSend, id: "new-send" } });
      return update(id, directory, change);
    };
    await assert.rejects(s.service.dismissUnsentSend("target", pending.pendingSend.id), /已归档|发送记录已变化/);
    assert.ok((await s.store.load("target")).pendingSend);
  }
});

test("实际当前会话已有消息但历史尚未落盘时，拒绝把旧empty快照当成空会话", async t => {
  const s = await setup(t), pending = await s.seed();
  const current = {
    sessionId: "target", desktopSessionOrigin: "empty", model: { provider: "offline", id: "model" },
    sessionManager: { getCwd: () => s.workspace, getEntries: () => [{ type: "message", message: { role: "user" } }] },
  };
  const service = createSessionService(path.join(s.base, "sessions"), async () => current, () => s.workspace, undefined, s.store);
  await service.getSession();
  const before = await fs.readFile(s.filename("target"));
  await assert.rejects(service.inspectUnsentSend("target"), /可信空会话/);
  await assert.rejects(service.dismissUnsentSend("target", pending.pendingSend.id), /可信空会话/);
  assert.deepEqual(await fs.readFile(s.filename("target")), before);
  assert.equal(await service.getSession(), current);
});

test("清理与迟到保存合并；写入失败保留快照并可重新核对后重试", async t => {
  const s = await setup(t), pending = await s.seed();
  const rename = fs.rename;
  const mocked = t.mock.method(fs, "rename", async (from, to) => {
    if (to === s.filename("target")) throw new Error("模拟写入失败");
    return rename(from, to);
  });
  await assert.rejects(s.service.dismissUnsentSend("target", pending.pendingSend.id), /模拟写入失败/);
  mocked.mock.restore();
  assert.equal((await s.service.inspectUnsentSend("target")).pendingSend.id, pending.pendingSend.id);
  await Promise.all([
    s.service.dismissUnsentSend("target", pending.pendingSend.id),
    s.store.saveDraft("target", s.workspace, "迟到新输入", 2),
  ]);
  assert.deepEqual((await s.store.load("target")).draft, { text: "迟到新输入", revision: 3 });
  assert.equal((await s.store.load("target")).pendingSend, null);
});

test("实际 preload/IPC 只转发编号，全程互斥且保存和停止保持独立", async t => {
  const s = await setup(t), pending = await s.seed();
  const handlers = new Map();
  let busy = false, stopped = false;
  registerAgentIpc({ handle: (name, handler) => handlers.set(name, handler) }, s.service, {
    isBusy: () => busy, send: () => assert.fail("不能发送"), stop: () => { stopped = true; },
  }, {}, {}, {}, {}, {}, { saveDraft: (id, text, revision) => s.store.saveDraft(id, s.workspace, text, revision) });
  let agent;
  const calls = [];
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { agent = value; } },
      ipcRenderer: { invoke: (...args) => {
        calls.push(args);
        return Promise.resolve().then(() => handlers.get(args[0])({}, ...args.slice(1)));
      } },
    }),
  });
  busy = true;
  await assert.rejects(agent.inspectUnsentSend("target"), /等待当前回复/);
  await assert.rejects(agent.dismissUnsentSend("target", pending.pendingSend.id), /等待当前回复/);
  busy = false;
  await agent.inspectUnsentSend("target", "/forged");
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const original = s.service.dismissUnsentSend;
  s.service.dismissUnsentSend = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const clearing = agent.dismissUnsentSend("target", pending.pendingSend.id, { text: "forged" });
  await entered.promise;
  await assert.rejects(agent.inspectUnsentSend("target"), /其他操作完成/);
  await assert.rejects(agent.newChat(), /其他操作完成/);
  await assert.rejects(agent.sendMessage("不得发送"), /当前操作结束/);
  await agent.saveComposerDraft("target", "互斥期间的新输入", 2);
  await agent.stop();
  assert.equal(stopped, true);
  gate.resolve();
  await clearing;
  assert.equal((await s.store.load("target")).pendingSend, null);
  assert.equal((await s.store.load("target")).draft.text, "互斥期间的新输入");
  assert.deepEqual(calls.find(args => args[0] === "agent:dismiss-unsent-send" && args.length === 3), ["agent:dismiss-unsent-send", "target", pending.pendingSend.id]);
  assert.ok(calls.filter(args => ["agent:inspect-unsent-send", "agent:dismiss-unsent-send"].includes(args[0]))
    .every(args => !args.includes("/forged") && args.length <= 3));
});

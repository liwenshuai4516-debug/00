
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runInNewContext } = require("node:vm");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-dismiss-send-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "state");
  const store = createSessionStateStore(directory);
  let currentId = "a";
  let busy = false;
  let sessionReads = 0;
  let sendCalls = 0;
  const sessions = {
    async getSession() {
      sessionReads += 1;
      return { sessionId: currentId, sessionManager: { getCwd: () => root } };
    },
    async newChat() { currentId = "b"; },
  };
  const service = createComposerDraftService(sessions, store);
  const handlers = new Map();
  registerAgentIpc({
    handle(name, handler) {
      assert.equal(handlers.has(name), false, `重复注册：${name}`);
      handlers.set(name, handler);
    },
  }, sessions, {
    isBusy: () => busy,
    send() { sendCalls += 1; },
  }, undefined, undefined, undefined, undefined, undefined, service);

  async function seed(id = "a") {
    currentId = id;
    await service.loadCurrentDraft();
    await service.saveDraft(id, " \t待核对原文\r\n", 0);
    return store.consumeDraft(id, root, " \t待核对原文\r\n", 1);
  }

  return {
    root, directory, store, service, seed,
    filename: (id) => path.join(directory, `${id}.json`),
    select(id) { currentId = id; },
    setBusy(value) { busy = value; },
    sessionReads: () => sessionReads,
    sendCalls: () => sendCalls,
    invoke: (name, ...args) => handlers.get(`agent:${name}`)({}, ...args),
  };
}

test("未登记会话不能解除限制，即使磁盘已有快照也不改写", async (t) => {
  const s = await setup(t);
  await s.store.saveDraft("other", s.root, "原文", 0);
  const consumed = await s.store.consumeDraft("other", s.root, "原文", 1);
  const before = await fs.readFile(s.filename("other"));
  await assert.rejects(s.service.dismissSend("other", consumed.pendingSend.id), /尚未登记/);
  assert.deepEqual(await fs.readFile(s.filename("other")), before);
  assert.equal(s.sessionReads(), 0);
});

test("无效发送编号或不存在的快照不创建状态文件", async (t) => {
  const s = await setup(t);
  await s.service.loadCurrentDraft();
  for (const id of [undefined, null, "", 0, {}]) {
    await assert.rejects(s.service.dismissSend("a", id), /发送编号无效/);
  }
  await assert.rejects(s.service.dismissSend("a", "missing"), /发送记录已变化/);
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
});

test("明确解除只清理匹配快照，保留原文草稿、版本、组织状态及历史字节", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  await s.service.saveDraft("a", " \t后来输入\r\n\n ", 2);
  await s.store.update("a", s.root, (state) => ({ ...state, pinnedAt: 12, archivedAt: 34 }));
  const before = await s.store.load("a");
  const history = path.join(s.root, "history.jsonl");
  await fs.writeFile(history, "仅用于核对不改写的测试历史\n");
  const historyBefore = await fs.readFile(history);
  const reads = s.sessionReads();

  assert.deepEqual(await s.service.dismissSend("a", consumed.pendingSend.id), {
    sessionId: "a", sendId: consumed.pendingSend.id,
  });
  assert.deepEqual(await s.store.load("a"), { ...before, pendingSend: null });
  assert.deepEqual(await fs.readFile(history), historyBefore);
  assert.equal(s.sessionReads(), reads);
  assert.equal(s.sendCalls(), 0);
});

test("错误编号、重复确认或迟到的旧确认不能清理另一份快照", async (t) => {
  const s = await setup(t);
  const first = await s.seed();
  let before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", "wrong"), /发送记录已变化/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
  await s.service.dismissSend("a", first.pendingSend.id);
  before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", first.pendingSend.id), /发送记录已变化/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);

  await s.service.saveDraft("a", "新一轮原文", 2);
  const next = await s.store.consumeDraft("a", s.root, "新一轮原文", 3);
  before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", first.pendingSend.id), /发送记录已变化/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
  assert.equal((await s.store.load("a")).pendingSend.id, next.pendingSend.id);
});

test("切换后仍按原登记处理A，不查询当前会话或修改B", async (t) => {
  const s = await setup(t);
  const a = await s.seed("a");
  await s.seed("b");
  const before = await fs.readFile(s.filename("b"));
  const reads = s.sessionReads();
  await s.service.dismissSend("a", a.pendingSend.id);
  assert.equal((await s.store.load("a")).pendingSend, null);
  assert.deepEqual(await fs.readFile(s.filename("b")), before);
  assert.equal(s.sessionReads(), reads);
});

test("自动保存与解除共用串行更新，任一顺序均保留新输入和版本", async (t) => {
  for (const saveFirst of [true, false]) {
    const s = await setup(t);
    const consumed = await s.seed();
    const save = () => s.service.saveDraft("a", "  新输入\n", 2);
    const dismiss = () => s.service.dismissSend("a", consumed.pendingSend.id);
    await Promise.all(saveFirst ? [save(), dismiss()] : [dismiss(), save()]);
    const state = await s.store.load("a");
    assert.deepEqual(state.draft, { text: "  新输入\n", revision: 3 });
    assert.equal(state.pendingSend, null);
  }
});

test("目录归属错误或损坏文件拒绝解除，保留原文件字节", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  const state = await s.store.load("a");
  await fs.writeFile(s.filename("a"), JSON.stringify({ ...state, workspaceDir: path.join(s.root, "other") }));
  let before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", consumed.pendingSend.id), /工作目录不匹配/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
  await fs.writeFile(s.filename("a"), "{损坏状态");
  before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", consumed.pendingSend.id), /记录损坏/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
});

test("发布失败保留快照和旧文件，清理临时文件后可显式重试", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  const before = await fs.readFile(s.filename("a"));
  const rename = fs.rename;
  const failure = new Error("模拟解除写入失败");
  const mocked = t.mock.method(fs, "rename", async (from, to) => {
    if (to === s.filename("a")) throw failure;
    return rename(from, to);
  });
  await assert.rejects(s.service.dismissSend("a", consumed.pendingSend.id), (error) => error === failure);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
  assert.deepEqual(await fs.readdir(s.directory), ["a.json"]);
  mocked.mock.restore();
  await s.service.dismissSend("a", consumed.pendingSend.id);
  assert.equal((await s.store.load("a")).pendingSend, null);
});

test("IPC生成期间拒绝解除，保存仍可执行；空闲后按编号解除且不发送", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  s.setBusy(true);
  assert.throws(() => s.invoke("dismiss-composer-send", "a", consumed.pendingSend.id), /等待当前回复结束/);
  await s.invoke("save-composer-draft", "a", "生成中的新输入", 2);
  assert.equal((await s.store.load("a")).pendingSend.id, consumed.pendingSend.id);
  s.setBusy(false);
  assert.deepEqual(await s.invoke("dismiss-composer-send", "a", consumed.pendingSend.id), {
    sessionId: "a", sendId: consumed.pendingSend.id,
  });
  assert.deepEqual((await s.store.load("a")).draft, { text: "生成中的新输入", revision: 3 });
  assert.equal(s.sendCalls(), 0);
});

test("IPC处理期间阻止发送与切换，写入失败后释放互斥供重试", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const dismiss = s.service.dismissSend;
  const mocked = t.mock.method(s.service, "dismissSend", async () => {
    entered.resolve();
    await released.promise;
    throw new Error("模拟解除失败");
  });
  const working = s.invoke("dismiss-composer-send", "a", consumed.pendingSend.id);
  const rejected = assert.rejects(working, /模拟解除失败/);
  try {
    await entered.promise;
    assert.throws(() => s.invoke("send-message", "不能发送"), /等待当前操作结束/);
    assert.throws(() => s.invoke("new-chat"), /等待当前回复结束/);
    assert.throws(() => s.invoke("inspect-composer-send", "a"), /等待当前回复结束/);
    await s.invoke("save-composer-draft", "a", "解除等待期间的新输入", 2);
    assert.equal(s.sendCalls(), 0);
  } finally {
    released.resolve();
    await rejected;
    mocked.mock.restore();
  }
  assert.equal(s.service.dismissSend, dismiss);
  await s.invoke("dismiss-composer-send", "a", consumed.pendingSend.id);
  assert.deepEqual((await s.store.load("a")).draft, { text: "解除等待期间的新输入", revision: 3 });
  await s.invoke("new-chat");
});

test("预加载固定通道仅转发两个编号，结果及拒绝原样返回", async () => {
  let agent;
  const calls = [];
  const result = { sessionId: "a", sendId: "s1" };
  const failure = new Error("模拟解除拒绝");
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { agent = value; } },
        ipcRenderer: {
          invoke(...args) {
            calls.push(args);
            return args[2] === "bad" ? Promise.reject(failure) : Promise.resolve(result);
          },
        },
      };
    },
  });
  assert.equal(await agent.dismissComposerSend("a", "s1", "/forged", { pendingSend: null }), result);
  await assert.rejects(agent.dismissComposerSend("a", "bad"), (error) => error === failure);
  assert.deepEqual(calls, [
    ["agent:dismiss-composer-send", "a", "s1"],
    ["agent:dismiss-composer-send", "a", "bad"],
  ]);
});
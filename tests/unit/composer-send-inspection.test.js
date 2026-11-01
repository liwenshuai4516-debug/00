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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-inspect-send-"));
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

  return {
    root, directory, store, service,
    select(id) { currentId = id; },
    setBusy(value) { busy = value; },
    sessionReads: () => sessionReads,
    sendCalls: () => sendCalls,
    invoke: (name, ...args) => handlers.get(`agent:${name}`)({}, ...args),
  };
}

test("未登记编号不可核对，即使已有磁盘记录也不能读取", async (t) => {
  const { root, store, service } = await setup(t);
  await store.saveDraft("history", root, "私人测试原文", 0);
  await assert.rejects(service.inspectSend("a"), /尚未登记/);
  await assert.rejects(service.inspectSend("history"), /尚未登记/);
  assert.equal(await store.load("a"), null);
});

test("已登记但尚未保存时返回空状态，不创建文件", async (t) => {
  const { service, directory } = await setup(t);
  await service.loadCurrentDraft();
  assert.deepEqual(await service.inspectSend("a"), {
    sessionId: "a", text: "", revision: 0, pendingSend: null,
  });
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("完整返回未确认快照与后来输入，只读且不暴露目录和组织字段", async (t) => {
  const { root, directory, store, service } = await setup(t);
  await service.loadCurrentDraft();
  const original = " \t原文\r\n末尾 \n";
  await service.saveDraft("a", original, 0);
  const consumed = await store.consumeDraft("a", root, original, 1);
  await service.saveDraft("a", " \n下一条\t ", 2);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename);

  const result = await service.inspectSend("a");
  assert.deepEqual(result, {
    sessionId: "a", text: " \n下一条\t ", revision: 3,
    pendingSend: { id: consumed.pendingSend.id, text: original, draftRevision: 1 },
  });
  result.pendingSend.text = "修改返回对象";
  assert.deepEqual(await fs.readFile(filename), before);
  assert.equal((await service.inspectSend("a")).pendingSend.text, original);
});

test("正常收尾后返回空快照，不回填已发送输入或修改后来输入", async (t) => {
  const { root, directory, service, store } = await setup(t);
  await service.loadCurrentDraft();
  await service.saveDraft("a", "已发送", 0);
  const consumed = await store.consumeDraft("a", root, "已发送", 1);
  await service.saveDraft("a", "新输入", 2);
  await store.completeSend("a", root, consumed.pendingSend.id);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename);
  assert.deepEqual(await service.inspectSend("a"), {
    sessionId: "a", text: "新输入", revision: 3, pendingSend: null,
  });
  assert.deepEqual(await fs.readFile(filename), before);
});

test("旧状态记录缺少 pendingSend 时按 null 返回，保留原文件字节", async (t) => {
  const { directory, service, store } = await setup(t);
  await service.loadCurrentDraft();
  await service.saveDraft("a", "旧输入", 0);
  const old = await store.load("a");
  delete old.pendingSend;
  const filename = path.join(directory, "a.json");
  await fs.writeFile(filename, JSON.stringify(old));
  const before = await fs.readFile(filename);
  assert.deepEqual(await service.inspectSend("a"), {
    sessionId: "a", text: "旧输入", revision: 1, pendingSend: null,
  });
  assert.deepEqual(await fs.readFile(filename), before);
});

test("切换后的迟到核对仍读取原编号，不重新查询当前会话", async (t) => {
  const { service, store, select, sessionReads } = await setup(t);
  await service.loadCurrentDraft();
  await service.saveDraft("a", "A 原文", 0);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const load = store.load;
  t.mock.method(store, "load", async (id) => {
    if (id === "a") {
      entered.resolve();
      await released.promise;
    }
    return load(id);
  });
  const inspecting = service.inspectSend("a");
  try {
    await entered.promise;
    select("b");
    await service.loadCurrentDraft();
    await service.saveDraft("b", "B 原文", 0);
  } finally {
    released.resolve();
  }
  const count = sessionReads();
  assert.equal((await inspecting).text, "A 原文");
  assert.equal((await service.inspectSend("a")).sessionId, "a");
  assert.equal(sessionReads(), count);
  assert.equal((await load("b")).draft.text, "B 原文");
});

test("绑定不匹配或文件损坏时拒绝读取，不重置原文件", async (t) => {
  const { root, directory, store, service } = await setup(t);
  await service.loadCurrentDraft();
  await service.saveDraft("a", "保留原文", 0);
  const filename = path.join(directory, "a.json");
  const original = await store.load("a");
  await fs.writeFile(filename, JSON.stringify({ ...original, workspaceDir: path.join(root, "other") }));
  let before = await fs.readFile(filename);
  await assert.rejects(service.inspectSend("a"), /已登记目录不匹配/);
  assert.deepEqual(await fs.readFile(filename), before);
  await fs.writeFile(filename, "{损坏记录");
  before = await fs.readFile(filename);
  await assert.rejects(service.inspectSend("a"), /记录损坏/);
  assert.deepEqual(await fs.readFile(filename), before);
});

test("读取错误原样传出，显式重试仍使用原登记", async (t) => {
  const { store, service } = await setup(t);
  await service.loadCurrentDraft();
  const load = store.load;
  const failure = new Error("模拟读取失败");
  t.mock.method(store, "load", async () => { throw failure; });
  await assert.rejects(service.inspectSend("a"), (error) => error === failure);
  t.mock.method(store, "load", load);
  assert.equal((await service.inspectSend("a")).revision, 0);
});

test("IPC 在生成期间拒绝核对，但继续允许原会话输入保存", async (t) => {
  const { invoke, setBusy } = await setup(t);
  await invoke("load-composer-draft");
  setBusy(true);
  assert.throws(() => invoke("inspect-composer-send", "a"), /等待当前回复结束/);
  await invoke("save-composer-draft", "a", "生成期间的新输入", 0);
  setBusy(false);
  assert.equal((await invoke("inspect-composer-send", "a")).text, "生成期间的新输入");
});

test("IPC 核对全程阻止新发送和会话操作，失败后释放互斥，自动保存独立", async (t) => {
  const { invoke, store, sendCalls } = await setup(t);
  await invoke("load-composer-draft");
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const load = store.load;
  t.mock.method(store, "load", async () => {
    entered.resolve();
    await released.promise;
    throw new Error("模拟核对失败");
  });
  const inspecting = invoke("inspect-composer-send", "a");
  const rejected = assert.rejects(inspecting, /模拟核对失败/);
  try {
    await entered.promise;
    assert.throws(() => invoke("send-message", "不能发送"), /等待当前操作结束/);
    assert.throws(() => invoke("new-chat"), /等待当前回复结束/);
    assert.throws(() => invoke("inspect-composer-send", "a"), /等待当前回复结束/);
    await invoke("save-composer-draft", "a", "核对期间输入", 0);
    assert.equal(sendCalls(), 0);
  } finally {
    released.resolve();
    await rejected;
  }
  t.mock.method(store, "load", load);
  assert.equal((await invoke("inspect-composer-send", "a")).text, "核对期间输入");
  await invoke("new-chat");
});

test("预加载只传会话编号，原样返回核对结果和拒绝", async () => {
  let agent;
  const calls = [];
  const result = { sessionId: "a", text: "", revision: 2, pendingSend: null };
  const failure = new Error("模拟拒绝");
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { agent = value; } },
        ipcRenderer: {
          invoke(...args) {
            calls.push(args);
            return args[1] === "bad" ? Promise.reject(failure) : Promise.resolve(result);
          },
        },
      };
    },
  });
  assert.equal(await agent.inspectComposerSend("a", "/forged", { pendingSend: null }), result);
  await assert.rejects(agent.inspectComposerSend("bad"), (error) => error === failure);
  assert.deepEqual(calls, [
    ["agent:inspect-composer-send", "a"],
    ["agent:inspect-composer-send", "bad"],
  ]);
});
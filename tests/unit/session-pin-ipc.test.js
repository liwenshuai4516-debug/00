const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

function setup() {
  const handlers = new Map();
  let busy = false;
  const calls = [];
  const service = {
    setSessionArchived(...args) { calls.push(args); return { id: args[0], archivedAt: 10, changed: false }; },
    setSessionPinned(...args) { calls.push(args); return { id: args[0], pinnedAt: 10 }; },
    newChat() { return "new"; },
  };
  registerAgentIpc({ handle: (name, callback) => handlers.set(name, callback) }, service,
    { isBusy: () => busy, stop() {} }, {}, {}, {}, {}, {}, { saveDraft() { return "saved"; } });
  return { service, calls, setBusy(value) { busy = value; },
    invoke: (name, ...args) => handlers.get(`agent:${name}`)({}, ...args) };
}

test("置顶IPC只转发编号与布尔值，生成中拒绝", async () => {
  const s = setup();
  assert.deepEqual(await s.invoke("set-session-pinned", "a", true, "/forged", 100), { id: "a", pinnedAt: 10 });
  assert.deepEqual(s.calls, [["a", true]]);
  s.setBusy(true);
  assert.throws(() => s.invoke("set-session-pinned", "a", false), /等待当前回复结束/);
  assert.equal(s.calls.length, 1);
});

for (const fails of [false, true]) {
  test(`置顶全程互斥，${fails ? "失败" : "成功"}后可重试，输入保存不受阻`, async () => {
    const s = setup();
    const gate = Promise.withResolvers();
    s.service.setSessionPinned = () => gate.promise;
    const pending = s.invoke("set-session-pinned", "a", true);
    const result = fails ? assert.rejects(pending, /模拟写入失败/) : pending;
    assert.throws(() => s.invoke("new-chat"), /其他操作完成/);
    assert.throws(() => s.invoke("set-session-pinned", "b", true), /其他操作完成/);
    assert.throws(() => s.invoke("send-message", "文字"), /当前操作结束/);
    assert.equal(await s.invoke("save-composer-draft", "a", "后来输入", 1), "saved");
    await s.invoke("stop");
    if (fails) gate.reject(Error("模拟写入失败")); else gate.resolve({ id: "a", pinnedAt: 10 });
    await result;
    s.service.setSessionPinned = () => ({ id: "a", pinnedAt: null });
    assert.deepEqual(await s.invoke("set-session-pinned", "a", false), { id: "a", pinnedAt: null });
    assert.equal(await s.invoke("new-chat"), "new");
  });
}

test("其他操作及同步异常也正确释放置顶互斥", async () => {
  const s = setup();
  const gate = Promise.withResolvers();
  s.service.newChat = () => gate.promise;
  const pending = s.invoke("new-chat");
  assert.throws(() => s.invoke("set-session-pinned", "a", true), /其他操作完成/);
  gate.resolve(); await pending;
  s.service.setSessionPinned = () => { throw Error("同步失败"); };
  await assert.rejects(s.invoke("set-session-pinned", "a", true), /同步失败/);
  s.service.setSessionPinned = () => "retried";
  assert.equal(await s.invoke("set-session-pinned", "a", true), "retried");
});

test("预加载置顶使用固定通道，丢弃额外参数并传递拒绝", async () => {
  let api;
  const calls = [];
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke(...args) {
        calls.push(args);
        return args[1] === "bad" ? Promise.reject(Error("模拟拒绝")) : Promise.resolve("done");
      } },
    }),
  });
  assert.equal(await api.setSessionPinned("a", false, "/forged", 1), "done");
  await assert.rejects(api.setSessionPinned("bad", true), /模拟拒绝/);
  assert.deepEqual(calls, [["agent:set-session-pinned", "a", false], ["agent:set-session-pinned", "bad", true]]);
});

for (const archived of [false, true]) {
  test(`归档IPC只转发编号和状态，${archived}全程互斥并传递失败`, async () => {
    const s = setup();
    s.setBusy(true);
    assert.throws(() => s.invoke("set-session-archived", "a", archived), /等待当前回复结束/);
    s.setBusy(false);
    assert.deepEqual(await s.invoke("set-session-archived", "a", archived, "/forged", 999), { id: "a", archivedAt: 10, changed: false });
    assert.deepEqual(s.calls, [["a", archived]]);
    const gate = Promise.withResolvers();
    s.service.setSessionArchived = () => gate.promise;
    const pending = s.invoke("set-session-archived", "a", archived);
    const failure = assert.rejects(pending, /归档失败/);
    assert.throws(() => s.invoke("new-chat"), /其他操作完成/);
    assert.throws(() => s.invoke("set-session-pinned", "a", true), /其他操作完成/);
    assert.throws(() => s.invoke("set-session-archived", "a", archived), /其他操作完成/);
    assert.throws(() => s.invoke("send-message", "文字"), /当前操作结束/);
    assert.equal(await s.invoke("save-composer-draft", "a", "原文", 1), "saved");
    gate.reject(Error("归档失败")); await failure;
    assert.equal(await s.invoke("new-chat"), "new");
  });
}

test("归档预加载固定通道，仅编号和布尔值", async () => {
  let api; const calls = [];
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({ changed: false }); } },
    }),
  });
  assert.deepEqual(await api.setSessionArchived("a", false, "/forged", 20), { changed: false });
  assert.deepEqual(calls, [["agent:set-session-archived", "a", false]]);
});

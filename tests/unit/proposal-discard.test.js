const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, rm } = require("node:fs/promises");
const { createProposalStore } = require("../../src/main/services/proposal-store.js");
const { createProposalStorage } = require("../../src/main/storage/proposal-storage.js");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

function proposal() {
  return {
    kind: "edit-proposal", path: "example.js", oldText: "before",
    newText: "after", baseTextHash: "a".repeat(64), written: false,
  };
}

test("放弃落盘后，新实例不恢复该草稿，其他草稿保持完整", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-discard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createProposalStore(createProposalStorage(dir));
  const first = store.add("session-a", proposal());
  const retained = store.add("session-a", proposal());
  const other = store.add("session-b", proposal());
  assert.deepEqual(store.discard("session-a", first.id), {
    id: first.id, path: first.path,
  });
  const restored = createProposalStore(createProposalStorage(dir));
  assert.deepEqual(restored.listPending("session-a"), [{ id: retained.id, path: retained.path }]);
  assert.deepEqual(restored.get("session-b", other.id), other);
  assert.throws(() => restored.get("session-a", first.id), /不存在/);
  assert.throws(() => restored.beginApply("session-a", first.id), /不存在/);
});

test("放弃落盘失败时，内存仍保留原草稿并允许重试", () => {
  let fail = false;
  const store = createProposalStore({
    load: () => [],
    save() { if (fail) throw new Error("模拟快照写入失败"); },
  });
  const item = store.add("session-a", proposal());
  fail = true;
  assert.throws(() => store.discard("session-a", item.id), /模拟快照写入失败/);
  assert.deepEqual(store.get("session-a", item.id), item);
  fail = false;
  store.discard("session-a", item.id);
  assert.deepEqual(store.listPending("session-a"), []);
});

test("拒绝跨会话、已保存和保存结果未确认的草稿", () => {
  const store = createProposalStore();
  const item = store.add("session-a", proposal());
  assert.throws(() => store.discard("session-b", item.id), /不存在/);
  store.beginApply("session-a", item.id);
  assert.throws(() => store.discard("session-a", item.id), /尚未确认/);
  store.markWritten("session-a", item.id);
  assert.throws(() => store.discard("session-a", item.id), /已经保存/);
  assert.equal(store.get("session-a", item.id).written, true);
});

test("聊天服务从当前会话取归属，不加载发送函数或调用模型", async () => {
  const store = createProposalStore();
  const item = store.add("session-a", proposal());
  let current = "session-b";
  const service = createChatService(
    { getSession: async () => ({ sessionId: current }) },
    async () => assert.fail("放弃草稿不应加载模型发送函数"),
    store,
  );
  await assert.rejects(service.discardProposal(item.id), /不存在/);
  current = "session-a";
  await service.discardProposal(item.id);
  assert.deepEqual(await service.listProposals(), []);
});

test("IPC 拒绝生成期间放弃，放弃期间阻止保存与切换", async () => {
  const handlers = new Map();
  const finished = Promise.withResolvers();
  const started = Promise.withResolvers();
  const ids = [];
  let busy = true;
  registerAgentIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { newChat: async () => {} },
    {
      isBusy: () => busy,
      discardProposal(id) { ids.push(id); started.resolve(); return finished.promise; },
    },
    {},
    { apply: () => assert.fail("放弃期间不能保存") },
  );
  const discard = handlers.get("agent:discard-proposal");
  assert.throws(() => discard({}, "p-1"), /请等待当前回复结束/);
  busy = false;
  const pending = discard({}, "p-1");
  await started.promise;
  for (const channel of ["agent:apply-proposal", "agent:new-chat", "agent:discard-proposal"]) {
    assert.throws(() => handlers.get(channel)({}, "p-1"), /其他操作完成/);
  }
  assert.deepEqual(ids, ["p-1"]);
  const rejected = assert.rejects(pending, /模拟失败/);
  finished.reject(new Error("模拟失败"));
  await rejected;
  // 失败也必须释放互斥状态。
  await handlers.get("agent:new-chat")({});
});

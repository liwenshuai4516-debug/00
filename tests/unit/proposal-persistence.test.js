const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { createProposalStorage } = require("../../src/main/storage/proposal-storage.js");
const { createProposalStore } = require("../../src/main/services/proposal-store.js");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { createProposalApplyService } = require("../../src/main/services/proposal-apply-service.js");
const { createProposalReviewService } = require("../../src/main/services/proposal-review-service.js");

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "example.js");
  await writeFile(filename, "before\n");
  const storage = createProposalStorage(path.join(directory, "proposals"));
  const draft = {
    kind: "edit-proposal", path: "example.js",
    oldText: "before", newText: "after",
    baseTextHash: createHash("sha256").update("before\n").digest("hex"),
    written: false,
  };
  return { directory, filename, storage, draft };
}

function createServices(directory, storage) {
  const store = createProposalStore(storage);
  const sessionService = {
    getSession: async () => ({ sessionId: "session-a" }),
    recordWorkspaceEdit: async () => {},
  };
  const chat = createChatService(sessionService, undefined, store);
  return {
    store, chat,
    apply: createProposalApplyService(directory, chat, sessionService),
    review: createProposalReviewService(directory, chat),
  };
}

test("新服务恢复同一编号草稿，保存后再次恢复不再列出", async (t) => {
  const { directory, filename, storage, draft } = await setup(t);
  const first = createServices(directory, storage);
  const proposal = first.store.add("session-a", draft);

  const restarted = createServices(directory, storage);
  assert.deepEqual(await restarted.chat.listProposals(), [
    { id: proposal.id, path: proposal.path },
  ]);
  assert.equal((await restarted.review.review(proposal.id)).id, proposal.id);
  await restarted.apply.apply(proposal.id);
  assert.equal(await readFile(filename, "utf8"), "after\n");

  const again = createServices(directory, storage);
  assert.deepEqual(await again.chat.listProposals(), []);
  await assert.rejects(again.apply.apply(proposal.id), /已经保存/);
});

test("登记落盘失败不公布草稿，聊天仍正常结束", async (t) => {
  const { draft } = await setup(t);
  const store = createProposalStore({
    load: () => [],
    save: () => { throw new Error("模拟存储失败"); },
  });
  const events = [];
  const chat = createChatService(
    { getSession: async () => ({ sessionId: "session-a" }) },
    async () => async (_session, _text, _onText, onToolEvent) => {
      onToolEvent({
        type: "end", name: "propose_workspace_edit",
        isError: false, proposal: draft,
      });
    },
    store,
  );
  assert.deepEqual(await chat.send("修改", () => {}, (event) => events.push(event)), {
    stopped: false,
  });
  assert.equal(events[0].isError, true);
  assert.equal(events[0].proposal, undefined);
  assert.match(events[0].text, /草稿未登记/);
  assert.deepEqual(await chat.listProposals(), []);
  assert.equal(chat.isBusy(), false);
});

test("进行中状态落盘失败时不写工作文件", async (t) => {
  const { directory, filename, storage, draft } = await setup(t);
  let fail = false;
  const services = createServices(directory, {
    load: (id) => storage.load(id),
    save(id, records) {
      if (fail) throw new Error("模拟状态存储失败");
      storage.save(id, records);
    },
  });
  const proposal = services.store.add("session-a", draft);
  fail = true;
  await assert.rejects(services.apply.apply(proposal.id), /模拟状态存储失败/);
  assert.equal(await readFile(filename, "utf8"), "before\n");
  assert.equal(services.store.get("session-a", proposal.id).applying, undefined);
});

test("工作文件变化导致保存失败后，恢复为可重新审阅状态", async (t) => {
  const { directory, filename, storage, draft } = await setup(t);
  const services = createServices(directory, storage);
  const proposal = services.store.add("session-a", draft);
  await writeFile(filename, "编辑器修改\n");

  await assert.rejects(services.apply.apply(proposal.id), /文件已发生变化/);
  const recovered = createServices(directory, storage).store.get("session-a", proposal.id);
  assert.equal(recovered.written, false);
  assert.equal(recovered.applying, false);
  assert.equal(await readFile(filename, "utf8"), "编辑器修改\n");
});

test("已写文件但完成状态落盘失败时返回警告，重启后阻止直接重试", async (t) => {
  const { directory, filename, storage, draft } = await setup(t);
  const services = createServices(directory, {
    load: (id) => storage.load(id),
    save(id, records) {
      if (records.some((proposal) => proposal.written)) {
        throw new Error("模拟完成状态存储失败");
      }
      storage.save(id, records);
    },
  });
  const proposal = services.store.add("session-a", draft);
  const result = await services.apply.apply(proposal.id);
  assert.equal(result.written, true);
  assert.equal(result.contextRecorded, true);
  assert.match(result.warning, /文件已保存/);
  assert.match(result.warning, /草稿状态未确认落盘/);
  assert.equal(await readFile(filename, "utf8"), "after\n");
  await assert.rejects(services.apply.apply(proposal.id), /已经保存/);

  const restarted = createServices(directory, storage);
  await assert.rejects(restarted.review.review(proposal.id), /上次保存未确认完成/);
  await assert.rejects(restarted.apply.apply(proposal.id), /上次保存未确认完成/);
});

test("恢复字段错误或重复编号时拒绝整个会话快照", async (t) => {
  const { storage, draft } = await setup(t);
  for (const records of [
    [{ ...draft, id: "p-1", sessionId: "session-a", oldText: "" }],
    [1, 2].map(() => ({ ...draft, id: "p-1", sessionId: "session-a" })),
  ]) {
    storage.save("session-a", records);
    const store = createProposalStore(storage);
    assert.throws(() => store.listPending("session-a"), /字段无效或编号重复/);
  }
});

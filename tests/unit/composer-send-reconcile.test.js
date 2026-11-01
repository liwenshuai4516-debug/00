const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup() {
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  const calls = [];
  const queue = createComposerDraftQueue(async (id, text, revision) => {
    calls.push([id, text, revision]);
    return { sessionId: id, text, revision: revision + 1 };
  });
  queue.register({ sessionId: "a", text: "  原文\r\n", revision: 3 });
  const ticket = queue.beginSend("a");
  return { queue, ticket, calls };
}

function state(ticket, changes = {}) {
  return {
    sessionId: ticket.sessionId, text: ticket.text, revision: ticket.revision,
    pendingSend: null, ...changes,
  };
}

function pending(ticket) {
  return { id: "send-1", text: ticket.text, draftRevision: ticket.revision };
}

test("发送后输入再主动清空，明确消费前失败也不能恢复旧原文", async () => {
  const { queue, ticket, calls } = await setup();
  queue.setText("a", "后来的输入");
  queue.setText("a", "");
  assert.equal(queue.rejectBeforeConsume(ticket).text, "");
  await queue.flush("a");
  assert.deepEqual(calls, [["a", "", 3]]);
});

test("原文与版本未变才恢复未消费输入，同时保留新输入和主动清空", async () => {
  for (const later of [undefined, "新输入", " \t\n", ""]) {
    const { queue, ticket } = await setup();
    if (later !== undefined) queue.setText("a", later);
    const result = queue.reconcileSend(ticket, state(ticket));
    assert.equal(result.status, "not-consumed");
    assert.equal(result.text, later === undefined ? ticket.text : later);
    assert.equal(result.revision, 3);
    assert.equal(result.pendingSend, null);
    assert.equal(queue.confirmConsumed(ticket, {
      sessionId: "a", sendId: "late", text: "", revision: 4,
    }), false);
  }
});

test("匹配消费快照时解除等待，保留新输入并从消费后的版本保存", async () => {
  const { queue, ticket, calls } = await setup();
  queue.setText("a", " \t下一条\r\n ");
  const result = queue.reconcileSend(ticket, state(ticket, {
    text: "", revision: 4, pendingSend: pending(ticket),
  }));
  assert.equal(result.status, "consumed");
  assert.equal(result.text, " \t下一条\r\n ");
  assert.deepEqual(result.pendingSend, pending(ticket));
  assert.deepEqual(await queue.flush("a"), {
    sessionId: "a", text: " \t下一条\r\n ", revision: 5,
  });
  assert.deepEqual(calls, [["a", " \t下一条\r\n ", 4]]);
});

test("版本已前进且快照已清理时不恢复原文，也不声称模型成功", async () => {
  const { queue, ticket, calls } = await setup();
  const result = queue.reconcileSend(ticket, state(ticket, { text: "", revision: 4 }));
  assert.deepEqual(result, {
    sessionId: "a", text: "", revision: 4, status: "advanced", pendingSend: null,
  });
  await queue.flush("a");
  assert.deepEqual(calls, []);
  assert.throws(() => queue.beginSend("a"), /请输入消息/);
});

test("无效核对结果保持暂停，不把缺少快照字段视为 null", async () => {
  const { queue, ticket, calls } = await setup();
  const missing = state(ticket);
  delete missing.pendingSend;
  for (const inspected of [
    null, missing,
    state(ticket, { sessionId: "b" }),
    state(ticket, { text: null }),
    state(ticket, { revision: -1 }),
    state(ticket, { revision: 3.5 }),
    state(ticket, { pendingSend: { id: "", text: "原文", draftRevision: 1 } }),
    state(ticket, { pendingSend: { id: "old", text: "", draftRevision: 1 } }),
    state(ticket, { pendingSend: { id: "old", text: "原文", draftRevision: 3 } }),
  ]) {
    assert.throws(() => queue.reconcileSend(ticket, inspected), /核对结果无效/);
  }
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.deepEqual(calls, []);
});

test("其他版本、正文或不匹配消费快照不自动覆盖，显式核对可重试", async () => {
  const { queue, ticket, calls } = await setup();
  queue.setText("a", "保留本地编辑");
  for (const inspected of [
    state(ticket, { revision: 2 }),
    state(ticket, { text: "被外部修改" }),
    state(ticket, { revision: 5, text: "" }),
    state(ticket, { revision: 4, text: "被外部修改" }),
    state(ticket, { revision: 4, text: "", pendingSend: { ...pending(ticket), text: "其他正文" } }),
    state(ticket, { revision: 4, text: "", pendingSend: { ...pending(ticket), draftRevision: 1 } }),
  ]) {
    assert.throws(() => queue.reconcileSend(ticket, inspected), /不匹配/);
  }
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.deepEqual(calls, []);
  const result = queue.reconcileSend(ticket, state(ticket));
  assert.equal(result.text, "保留本地编辑");
  await queue.flush("a");
  assert.deepEqual(calls, [["a", "保留本地编辑", 3]]);
});

test("相同正文和版本的新发送不会接受旧凭证或复制凭证的迟到核对", async () => {
  const { queue, ticket } = await setup();
  queue.reconcileSend(ticket, state(ticket));
  const second = queue.beginSend("a");
  assert.deepEqual(second, ticket);
  assert.notEqual(second, ticket);
  assert.equal(queue.reconcileSend(ticket, state(ticket)), false);
  assert.equal(queue.reconcileSend({ ...second }, state(second)), false);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.equal(queue.reconcileSend(second, state(second)).status, "not-consumed");
});

test("事件先确认且新输入已保存时，迟到核对不回退版本或原文", async () => {
  const { queue, ticket } = await setup();
  queue.confirmConsumed(ticket, { sessionId: "a", sendId: "s1", text: "", revision: 4 });
  queue.setText("a", "已保存的新输入");
  await queue.flush("a");
  assert.equal(queue.reconcileSend(ticket, state(ticket)), false);
  assert.deepEqual(queue.finishSend(ticket), {
    sessionId: "a", text: "已保存的新输入", revision: 5,
  });
});

test("本次未消费但存在较早的未确认快照时，返回旧快照供手动处理", async () => {
  const { queue, ticket } = await setup();
  const old = { id: "old-send", text: "较早的发送原文", draftRevision: 1 };
  const result = queue.reconcileSend(ticket, state(ticket, { pendingSend: old }));
  assert.equal(result.status, "not-consumed");
  assert.equal(result.text, ticket.text);
  assert.deepEqual(result.pendingSend, old);
  assert.notEqual(result.pendingSend, old);
});

test("真实临时存储核对三种状态后只保存本地新输入，不清理快照", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-reconcile-send-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  for (const mode of ["not-consumed", "consumed", "advanced"]) {
    const store = createSessionStateStore(path.join(root, mode));
    const service = createComposerDraftService({
      getSession: async () => ({ sessionId: "a", sessionManager: { getCwd: () => root } }),
    }, store);
    const queue = createComposerDraftQueue(service.saveDraft);
    queue.register(await service.loadCurrentDraft());
    queue.setText("a", " \t完整原文\r\n ");
    await queue.flush("a");
    const ticket = queue.beginSend("a");
    queue.setText("a", "后来的输入\n");
    if (mode !== "not-consumed") {
      const consumed = await store.consumeDraft("a", root, ticket.text, ticket.revision);
      if (mode === "advanced") await store.completeSend("a", root, consumed.pendingSend.id);
    }
    const inspected = await service.inspectSend("a");
    assert.equal(queue.reconcileSend(ticket, inspected).status, mode);
    await queue.flush("a");
    const saved = await createSessionStateStore(path.join(root, mode)).load("a");
    assert.equal(saved.draft.text, "后来的输入\n");
    assert.equal(saved.draft.revision, mode === "not-consumed" ? 2 : 3);
    assert.deepEqual(saved.pendingSend, inspected.pendingSend);
  }
});
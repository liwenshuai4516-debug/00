const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");

async function setup(save) {
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  const calls = [];
  const queue = createComposerDraftQueue(async (id, text, revision) => {
    calls.push([id, text, revision]);
    if (save) return save(id, text, revision);
    return { sessionId: id, text, revision: revision + 1 };
  });
  queue.register({ sessionId: "a", text: "  原文\r\n", revision: 3 });
  return { queue, calls };
}

function ack(ticket, sendId = "send-1") {
  return {
    sessionId: ticket.sessionId,
    sendId,
    text: "",
    revision: ticket.revision + 1,
  };
}

test("发送前必须保存完成，固定完整原文和版本并拒绝重复开始", async () => {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const { queue } = await setup(async (id, text, revision) => {
    entered.resolve();
    await released.promise;
    return { sessionId: id, text, revision: revision + 1 };
  });

  queue.setText("a", "  修改\r\n\t ");
  assert.throws(() => queue.beginSend("a"), /先等待输入保存/);
  const saving = queue.flush("a");
  try {
    await entered.promise;
    assert.throws(() => queue.beginSend("a"), /先等待输入保存/);
  } finally {
    released.resolve();
    await saving;
  }
  const ticket = queue.beginSend("a");
  assert.deepEqual(ticket, { sessionId: "a", text: "  修改\r\n\t ", revision: 4 });
  assert.equal(Object.isFrozen(ticket), true);
  assert.throws(() => queue.beginSend("a"), /已有发送/);
});

test("消费确认前只缓存新输入，确认后按新版本保存且不清空新输入", async () => {
  const { queue, calls } = await setup();
  const ticket = queue.beginSend("a");
  queue.setText("a", " \t\n ");
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.deepEqual(calls, []);
  assert.equal(queue.confirmConsumed(ticket, ack(ticket)), true);
  assert.deepEqual(await queue.flush("a"), {
    sessionId: "a", text: " \t\n ", revision: 5,
  });
  assert.deepEqual(calls, [["a", " \t\n ", 4]]);
  assert.deepEqual(queue.finishSend(ticket), {
    sessionId: "a", text: " \t\n ", revision: 5,
  });
});

test("没有新输入时确认后的空串不重复写入，也不能再发送空输入", async () => {
  const { queue, calls } = await setup();
  const ticket = queue.beginSend("a");
  queue.confirmConsumed(ticket, ack(ticket));
  assert.deepEqual(await queue.flush("a"), { sessionId: "a", text: "", revision: 4 });
  queue.finishSend(ticket);
  assert.deepEqual(calls, []);
  assert.throws(() => queue.beginSend("a"), /请输入消息/);
});

test("错误归属、版本、正文、编号和复制凭证均不解除等待", async () => {
  const { queue, calls } = await setup();
  const ticket = queue.beginSend("a");
  for (const invalid of [
    null,
    { ...ack(ticket), sessionId: "b" },
    { ...ack(ticket), revision: 9 },
    { ...ack(ticket), text: "错误正文" },
    { ...ack(ticket), sendId: "" },
  ]) {
    assert.equal(queue.confirmConsumed(ticket, invalid), false);
  }
  assert.equal(queue.confirmConsumed({ ...ticket }, ack(ticket)), false);
  assert.throws(() => queue.finishSend(ticket), /尚未确认输入消费/);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.deepEqual(calls, []);
  assert.equal(queue.confirmConsumed(ticket, ack(ticket)), true);
});

test("重复和旧发送确认不能回退版本，迟到结束或拒绝不影响新发送", async () => {
  const { queue } = await setup();
  const first = queue.beginSend("a");
  queue.confirmConsumed(first, ack(first));
  queue.setText("a", first.text);
  await queue.flush("a");
  assert.equal(queue.confirmConsumed(first, ack(first)), false);
  assert.equal(queue.finishSend(first).revision, 5);

  const second = queue.beginSend("a");
  assert.equal(queue.confirmConsumed(first, ack(first)), false);
  assert.equal(queue.confirmConsumed(second, ack(first)), false);
  assert.equal(queue.finishSend(first), false);
  assert.equal(queue.rejectBeforeConsume(first), false);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  queue.confirmConsumed(second, ack(second, "send-2"));
  assert.equal(queue.finishSend(second).revision, 6);
});

test("明确消费前失败只在本地为空时恢复原文，保留后续正文和空白", async () => {
  for (const later of ["", "后来的输入", " \t\r\n"]) {
    const { queue, calls } = await setup();
    const ticket = queue.beginSend("a");
    queue.setText("a", later);
    const restored = queue.rejectBeforeConsume(ticket);
    assert.equal(restored.text, later === "" ? ticket.text : later);
    assert.equal(restored.revision, ticket.revision);
    assert.equal(queue.confirmConsumed(ticket, ack(ticket)), false);
    await queue.flush("a");
    assert.deepEqual(calls, later === "" ? [] : [["a", later, 3]]);
  }
});

test("结果未返回消费确认时维持等待；返回值可补确认，消费后禁止失败恢复", async () => {
  const { queue } = await setup();
  const ticket = queue.beginSend("a");
  queue.setText("a", "保留新输入");
  assert.throws(() => queue.finishSend(ticket), /尚未确认输入消费/);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);

  // 模拟事件缺失，但 sendMessage 返回值仍带有 draft 确认。
  const result = { outcome: "unconfirmed", draft: ack(ticket), error: "模拟连接中断" };
  assert.equal(queue.confirmConsumed(ticket, result.draft), true);
  assert.throws(() => queue.rejectBeforeConsume(ticket), /输入已消费/);
  assert.equal((await queue.flush("a")).text, "保留新输入");
  assert.equal(queue.finishSend(ticket).text, "保留新输入");
});

test("A 等待消费确认不阻止 B 保存，错会话确认不改变 B", async () => {
  const { queue, calls } = await setup();
  queue.register({ sessionId: "b", text: "B", revision: 7 });
  const ticket = queue.beginSend("a");
  queue.setText("b", "B 的新输入");
  assert.equal(queue.confirmConsumed(ticket, { ...ack(ticket), sessionId: "b" }), false);
  assert.deepEqual(await queue.flush("b"), {
    sessionId: "b", text: "B 的新输入", revision: 8,
  });
  assert.deepEqual(calls, [["b", "B 的新输入", 7]]);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
});

test("真实存储消费后保存新输入，不恢复已发送原文或改动待确认快照", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-queue-consume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createSessionStateStore(root);
  const original = "  原文\r\n";
  await store.saveDraft("a", root, original, 0);
  // 与临时存储已有版本保持一致，登记真实初值。
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  const realQueue = createComposerDraftQueue(async (id, text, revision) => {
    const saved = await store.saveDraft(id, root, text, revision);
    return { sessionId: id, ...saved.draft };
  });
  realQueue.register({ sessionId: "a", text: original, revision: 1 });
  const ticket = realQueue.beginSend("a");
  realQueue.setText("a", "  下一条\n");
  await assert.rejects(realQueue.flush("a"), /等待输入消费确认/);
  const consumed = await store.consumeDraft("a", root, ticket.text, ticket.revision);
  realQueue.confirmConsumed(ticket, {
    sessionId: "a", sendId: consumed.pendingSend.id, ...consumed.draft,
  });
  await realQueue.flush("a");
  realQueue.finishSend(ticket);
  const loaded = await createSessionStateStore(root).load("a");
  assert.equal(loaded.draft.text, "  下一条\n");
  assert.equal(loaded.draft.revision, 3);
  assert.equal(loaded.pendingSend.text, original);
});
const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(t) {
  const { createComposerPersistence } = await import("../../src/renderer/components/composer-persistence.js");
  class Input extends EventTarget { value = ""; }
  const input = new Input();
  const records = new Map([
    ["a", { sessionId: "a", text: "A 原文", revision: 2, pendingSend: null }],
    ["b", { sessionId: "b", text: "B 原文", revision: 5, pendingSend: null }],
  ]);
  let current = "a";
  const calls = [], views = [];
  const api = {
    async loadComposerDraft() {
      calls.push(["load", current]);
      const { sessionId, text, revision } = records.get(current);
      return { sessionId, text, revision };
    },
    async inspectComposerSend(id) {
      calls.push(["inspect", id]);
      return structuredClone(records.get(id));
    },
    async saveComposerDraft(id, text, revision) {
      calls.push(["save", id, text, revision]);
      const record = records.get(id);
      assert.equal(revision, record.revision);
      Object.assign(record, { text, revision: revision + 1 });
      return { sessionId: id, text, revision: record.revision };
    },
    async dismissComposerSend(id, sendId) {
      calls.push(["dismiss", id, sendId]);
      assert.equal(records.get(id).pendingSend.id, sendId);
      records.get(id).pendingSend = null;
      return { sessionId: id, sendId };
    },
  };
  const controller = createComposerPersistence(input, api, view => views.push(view));
  t.after(() => controller.dispose());
  return {
    input, records, calls, views, api, controller,
    select(id) { current = id; },
    edit(text) { input.value = text; input.dispatchEvent(new Event("input")); },
    consume(ticket) {
      const record = records.get(ticket.sessionId);
      assert.equal(record.revision, ticket.revision);
      record.text = "";
      record.revision += 1;
      record.pendingSend = { id: "send-1", text: ticket.text, draftRevision: ticket.revision };
      return { sessionId: ticket.sessionId, sendId: "send-1", text: "", revision: record.revision };
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("立即补保存完整原文与程序赋值，重复补保存不重复写入", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  s.input.value = "  未派发事件的原文\r\n第二行 \t";
  await s.controller.flushAll();
  assert.equal(s.records.get("a").text, s.input.value);
  assert.equal(s.records.get("a").revision, 3);
  await s.controller.flushAll();
  assert.equal(s.calls.filter(([kind]) => kind === "save").length, 1);
});

test("补保存包含离开后保存失败的旧会话，输入和状态仍归当前会话", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const save = s.api.saveComposerDraft;
  let fail = true, attempted = false;
  s.api.saveComposerDraft = async (...args) => {
    if (args[0] === "a" && fail) { attempted = true; throw Error("旧会话保存失败"); }
    return save(...args);
  };
  s.edit("A 待保存");
  s.select("b"); await s.controller.switchTo("b");
  await settle();
  assert.equal(attempted, true);
  assert.equal(s.records.get("a").text, "A 原文");
  s.edit("B 新输入");
  const count = s.views.length;
  fail = false;
  await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "A 待保存");
  assert.equal(s.records.get("b").text, "B 新输入");
  assert.equal(s.input.value, "B 新输入");
  assert.ok(s.views.slice(count).every(view => view.sessionId === "b"));
});

test("等待已有慢保存和调用前的最新编辑，不能提前报告完成", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const save = s.api.saveComposerDraft;
  s.api.saveComposerDraft = async (...args) => {
    entered.resolve(); await gate.promise; return save(...args);
  };
  s.edit("第一版");
  const writing = s.controller.flush();
  await entered.promise;
  s.edit("等待期间的新版本");
  let done = false;
  const closing = s.controller.flushAll().then(() => { done = true; });
  await settle(); assert.equal(done, false);
  gate.resolve(); await Promise.all([writing, closing]);
  assert.equal(s.records.get("a").text, "等待期间的新版本");
  assert.equal(s.records.get("a").revision, 4);
});

test("保存失败抛错但不释放组件，保留原文并允许显式重试", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const save = s.api.saveComposerDraft;
  s.api.saveComposerDraft = async () => { throw Error("模拟磁盘失败"); };
  s.edit("必须保留的输入");
  await assert.rejects(s.controller.flushAll(), /模拟磁盘失败/);
  assert.equal(s.input.value, "必须保留的输入");
  assert.equal(s.records.get("a").revision, 2);
  assert.equal(s.views.at(-1).retryable, true);
  s.api.saveComposerDraft = save;
  await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "必须保留的输入");
  s.edit("失败后仍可编辑"); await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "失败后仍可编辑");
});

test("读取未完成时拒绝补保存，失败读取的本地输入与主动清空也不能跳过", async t => {
  for (const text of ["本地输入", ""]) {
    const s = await setup(t);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    const load = s.api.loadComposerDraft;
    s.api.loadComposerDraft = async () => {
      entered.resolve(); await gate.promise; throw Error("模拟读取失败");
    };
    const reading = s.controller.switchTo("a");
    const rejected = assert.rejects(reading, /模拟读取失败/);
    await entered.promise;
    await assert.rejects(s.controller.flushAll(), /请等待/);
    s.edit("先编辑"); s.edit(text);
    gate.resolve(); await rejected;
    await assert.rejects(s.controller.flushAll(), /尚未完成读取的本地输入/);
    assert.equal(s.input.value, text);
    assert.equal(s.calls.some(([kind]) => kind === "save"), false);
    s.api.loadComposerDraft = load;
    await s.controller.retry(); await s.controller.flushAll();
    assert.equal(s.records.get("a").text, text);
  }
});

test("没有本地编辑的失败读取可跳过，不读取其他会话也不猜测版本", async t => {
  const s = await setup(t);
  s.api.loadComposerDraft = async () => { throw Error("模拟读取失败"); };
  await assert.rejects(s.controller.switchTo("a"), /模拟读取失败/);
  await s.controller.flushAll();
  assert.equal(s.calls.length, 0);
  assert.equal(s.records.get("a").text, "A 原文");
  assert.equal(s.records.get("b").text, "B 原文");
});

test("尚无会话且无输入可完成，有未绑定原文必须拒绝且保留", async t => {
  const s = await setup(t);
  await s.controller.flushAll();
  s.input.value = "  \n";
  await assert.rejects(s.controller.flushAll(), /尚未绑定会话/);
  assert.equal(s.input.value, "  \n");
  assert.equal(s.calls.length, 0);
});

test("已落盘未确认快照不被解除或重发，仍保存后来输入与主动清空", async t => {
  const s = await setup(t);
  const pending = { id: "old", text: "未确认原文", draftRevision: 1 };
  s.records.get("a").pendingSend = structuredClone(pending);
  await s.controller.switchTo("a");
  s.edit("后来输入"); await s.controller.flushAll();
  s.edit(""); await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "");
  assert.deepEqual(s.records.get("a").pendingSend, pending);
  assert.equal(s.calls.some(([kind]) => kind === "dismiss"), false);
  assert.equal(s.views.at(-1).canSend, false);
});

test("准备发送、消费未确认及已确认但未收尾均拒绝补保存，收尾后保存新输入", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const save = s.api.saveComposerDraft;
  s.api.saveComposerDraft = async (...args) => {
    entered.resolve(); await gate.promise; return save(...args);
  };
  s.edit("待发送正文");
  const preparing = s.controller.prepareSend();
  await entered.promise;
  await assert.rejects(s.controller.flushAll(), /请等待/);
  gate.resolve(); const ticket = await preparing;
  s.edit("生成时的新输入");
  await assert.rejects(s.controller.flushAll(), /请等待/);
  const ack = s.consume(ticket);
  assert.equal(s.controller.confirmConsumed(ticket, ack), true);
  await assert.rejects(s.controller.flushAll(), /请等待/);
  s.records.get("a").pendingSend = null;
  await s.controller.finishSend(ticket, { outcome: "completed", draft: ack });
  await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "生成时的新输入");
});

test("解除进行中拒绝保存确认，结束后可重试", async t => {
  const s = await setup(t);
  s.records.get("a").pendingSend = { id: "old", text: "旧快照", draftRevision: 1 };
  await s.controller.switchTo("a");
  const gate = Promise.withResolvers();
  const dismiss = s.api.dismissComposerSend;
  s.api.dismissComposerSend = async (...args) => { await gate.promise; return dismiss(...args); };
  const working = s.controller.dismissPendingSend("old");
  await assert.rejects(s.controller.flushAll(), /请等待/);
  gate.resolve(); await working; await s.controller.flushAll();
  assert.equal(s.input.value, "A 原文");
  assert.equal(s.calls.filter(([kind]) => kind === "dismiss").length, 1);
});

test("组件释放后不能报告补保存成功", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  s.edit("尚未保存"); s.controller.dispose();
  await assert.rejects(s.controller.flushAll(), /已释放/);
  assert.equal(s.input.value, "尚未保存");
  assert.equal(s.calls.some(([kind]) => kind === "save"), false);
});
const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(t) {
  const { createComposerPersistence } = await import("../../src/renderer/components/composer-persistence.js");
  class Input extends EventTarget { value = ""; }
  const input = new Input();
  const snapshot = { id: "old-send", text: "  待核对原文\r\n", draftRevision: 1 };
  const records = new Map([
    ["a", { sessionId: "a", text: "  后来输入\n", revision: 2, pendingSend: snapshot }],
    ["b", { sessionId: "b", text: "B 输入", revision: 0, pendingSend: null }],
  ]);
  let current = "a";
  const calls = [];
  const views = [];
  const api = {
    async loadComposerDraft() {
      const { sessionId, text, revision } = records.get(current);
      return { sessionId, text, revision };
    },
    async inspectComposerSend(id) {
      calls.push(["inspect", id]);
      return structuredClone(records.get(id));
    },
    async saveComposerDraft(id, text, revision) {
      const state = records.get(id);
      assert.equal(revision, state.revision);
      state.text = text;
      state.revision += 1;
      return { sessionId: id, text, revision: state.revision };
    },
    async dismissComposerSend(id, sendId) {
      calls.push(["dismiss", id, sendId]);
      assert.equal(records.get(id).pendingSend.id, sendId);
      records.get(id).pendingSend = null;
      return { sessionId: id, sendId };
    },
  };
  const controller = createComposerPersistence(input, api, (view) => views.push(view));
  t.after(() => controller.dispose());
  await controller.switchTo("a");
  return {
    input, records, calls, views, api, controller,
    view: () => views.at(-1),
    select(id) { current = id; },
    edit(text) { input.value = text; input.dispatchEvent(new Event("input")); },
    dismissCalls: () => calls.filter(([kind]) => kind === "dismiss").length,
  };
}

test("读取只展示快照，错误编号或无快照不调用解除接口", async (t) => {
  const s = await setup(t);
  assert.equal(s.view().canDismiss, true);
  assert.equal(s.view().canSend, false);
  assert.equal(s.dismissCalls(), 0);
  await assert.rejects(s.controller.dismissPendingSend("wrong"), /状态已变化/);
  s.select("b");
  await s.controller.switchTo("b");
  assert.equal(s.view().canDismiss, false);
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /状态已变化/);
  assert.equal(s.dismissCalls(), 0);
});

test("解除期间保留新输入与主动清空，编号确认后不覆盖正文和保存版本", async (t) => {
  for (const text of ["  新输入\r\n", ""]) {
    const s = await setup(t);
    const gate = Promise.withResolvers();
    const dismiss = s.api.dismissComposerSend;
    s.api.dismissComposerSend = async (...args) => { await gate.promise; return dismiss(...args); };
    const working = s.controller.dismissPendingSend("old-send");
    assert.equal(s.view().canDismiss, false);
    assert.equal(s.view().canSend, false);
    await assert.rejects(s.controller.dismissPendingSend("old-send"), /状态已变化/);
    await assert.rejects(s.controller.prepareSend(), /尚未就绪/);
    s.edit("后来主动编辑"); s.edit(text);
    await s.controller.flush();
    gate.resolve(); await working;
    assert.equal(s.input.value, text);
    assert.equal(s.records.get("a").text, text);
    assert.equal(s.records.get("a").revision, 3);
    assert.equal(s.view().pendingSend, null);
    assert.equal(s.view().canSend, true);
    assert.equal(s.dismissCalls(), 1);
  }
});

test("解除前失败，核对后保留同一快照供重新确认，不改当前输入", async (t) => {
  const s = await setup(t);
  s.api.dismissComposerSend = async (id, sendId) => {
    s.calls.push(["dismiss", id, sendId]);
    throw new Error("模拟写入失败");
  };
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /模拟写入失败/);
  assert.equal(s.view().pendingSend.id, "old-send");
  assert.equal(s.view().canDismiss, true);
  assert.equal(s.view().canSend, false);
  assert.equal(s.input.value, "  后来输入\n");
  assert.equal(s.dismissCalls(), 1);
});

test("写入成功但返回丢失时只读核对，确定空快照后解除且不重复请求", async (t) => {
  const s = await setup(t);
  const dismiss = s.api.dismissComposerSend;
  s.api.dismissComposerSend = async (...args) => {
    await dismiss(...args);
    throw new Error("模拟返回丢失");
  };
  s.edit(" \n新输入\t ");
  await s.controller.dismissPendingSend("old-send");
  assert.equal(s.view().pendingSend, null);
  assert.equal(s.view().canSend, true);
  assert.equal(s.input.value, " \n新输入\t ");
  await s.controller.flush();
  assert.equal(s.records.get("a").text, " \n新输入\t ");
  assert.equal(s.dismissCalls(), 1);
});

test("返回与核对都失败时保持限制，普通重试只核对且不自动再次清理", async (t) => {
  const s = await setup(t);
  const dismiss = s.api.dismissComposerSend;
  const inspect = s.api.inspectComposerSend;
  s.api.dismissComposerSend = async (...args) => { await dismiss(...args); throw new Error("返回丢失"); };
  s.api.inspectComposerSend = async () => { throw new Error("核对不可用"); };
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /核对不可用/);
  s.edit("仍可单独保存的新输入");
  await s.controller.flush();
  assert.equal(s.view().retryable, true);
  assert.equal(s.view().canSend, false);
  assert.equal(s.view().canDismiss, false);
  assert.match(s.view().message, /解除结果尚未确认/);
  s.api.inspectComposerSend = inspect;
  await s.controller.retry();
  assert.equal(s.view().pendingSend, null);
  assert.equal(s.view().canSend, true);
  assert.equal(s.records.get("a").text, "仍可单独保存的新输入");
  assert.equal(s.dismissCalls(), 1);
});

test("核对发现新快照时替换展示，旧确认不能清理新快照", async (t) => {
  const s = await setup(t);
  s.api.dismissComposerSend = async (id, sendId) => {
    s.calls.push(["dismiss", id, sendId]);
    s.records.get(id).pendingSend = { id: "new-send", text: "另一份原文", draftRevision: 1 };
    throw new Error("发送记录已变化");
  };
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /发送记录已变化/);
  assert.equal(s.view().pendingSend.id, "new-send");
  assert.equal(s.view().pendingSend.text, "另一份原文");
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /状态已变化/);
  assert.equal(s.dismissCalls(), 1);
  assert.equal(s.input.value, "  后来输入\n");
});

test("错误归属的返回和缺失pendingSend的核对不能误解锁", async (t) => {
  const s = await setup(t);
  const inspect = s.api.inspectComposerSend;
  s.api.dismissComposerSend = async () => ({ sessionId: "b", sendId: "old-send" });
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /编号不匹配/);
  assert.equal(s.view().canSend, false);
  s.api.inspectComposerSend = async () => ({ sessionId: "a" });
  await assert.rejects(s.controller.dismissPendingSend("old-send"), /核对结果无效/);
  assert.equal(s.view().retryable, true);
  s.api.inspectComposerSend = inspect;
  await s.controller.retry();
  assert.equal(s.view().pendingSend.id, "old-send");
  assert.equal(s.view().canSend, false);
});

test("A的迟到解除不回填或发布到B，切回A仍保留自己的输入", async (t) => {
  const s = await setup(t);
  const gate = Promise.withResolvers();
  const dismiss = s.api.dismissComposerSend;
  s.api.dismissComposerSend = async (...args) => { await gate.promise; return dismiss(...args); };
  const working = s.controller.dismissPendingSend("old-send");
  s.select("b"); await s.controller.switchTo("b");
  s.edit("B 后来的输入");
  const count = s.views.length;
  gate.resolve(); await working;
  assert.equal(s.input.value, "B 后来的输入");
  assert.equal(s.views.length, count);
  assert.equal(s.view().sessionId, "b");
  s.select("a"); await s.controller.switchTo("a");
  assert.equal(s.input.value, "  后来输入\n");
  assert.equal(s.view().pendingSend, null);
});
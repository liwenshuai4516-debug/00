const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(t, initial = "") {
  const { createComposerPersistence } = await import(
    "../../src/renderer/components/composer-persistence.js"
  );
  class Input extends EventTarget { value = initial; }
  const input = new Input();
  const records = new Map([
    ["a", { sessionId: "a", text: "  A 原文\r\n", revision: 2, pendingSend: null }],
    ["b", { sessionId: "b", text: "B 原文", revision: 5, pendingSend: null }],
  ]);
  let current = "a";
  const calls = [];
  const views = [];
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
      record.text = text;
      record.revision += 1;
      return { sessionId: id, text, revision: record.revision };
    },
  };
  const controller = createComposerPersistence(input, api, (view) => views.push(view));
  t.after(() => controller.dispose());
  return {
    input, records, calls, views, api, controller,
    view: () => views.at(-1),
    select(id) { current = id; },
    edit(text) { input.value = text; input.dispatchEvent(new Event("input")); },
    consume(ticket) {
      const record = records.get(ticket.sessionId);
      assert.equal(record.text, ticket.text);
      assert.equal(record.revision, ticket.revision);
      record.text = "";
      record.revision += 1;
      record.pendingSend = { id: "s1", text: ticket.text, draftRevision: ticket.revision };
      return { sessionId: ticket.sessionId, sendId: "s1", text: "", revision: record.revision };
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("读取完整输入，同会话刷新不重新回填；输入状态只向当前会话发布", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  assert.equal(s.input.value, "  A 原文\r\n");
  assert.equal(s.view().canSend, true);
  s.edit("本地输入");
  await s.controller.switchTo("a");
  assert.equal(s.input.value, "本地输入");
  assert.equal(s.calls.filter(([name]) => name === "load").length, 1);
  await s.controller.flush();
  assert.equal(s.records.get("a").text, "本地输入");
  assert.match(s.view().message, /已保存/);
});

test("加载前编辑后清空及加载期间输入优先，读取和队列登记仍执行", async (t) => {
  for (const text of ["", "加载期间输入\n"]) {
    const s = await setup(t);
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    const load = s.api.loadComposerDraft;
    s.api.loadComposerDraft = async () => {
      const result = await load();
      entered.resolve();
      await released.promise;
      return result;
    };
    if (text === "") { s.edit("预先输入"); s.edit(""); }
    const loading = s.controller.switchTo("a");
    await entered.promise;
    if (text !== "") s.edit(text);
    released.resolve();
    await loading;
    assert.equal(s.input.value, text);
    await s.controller.flush();
    assert.equal(s.records.get("a").text, text);
    assert.equal(s.calls.some(([name]) => name === "inspect"), true);
  }
});

test("A 慢读取跨 B 再回 A 不覆盖新编辑，切换后保存仍归原编号", async (t) => {
  const s = await setup(t);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const load = s.api.loadComposerDraft;
  s.api.loadComposerDraft = async () => {
    const result = await load();
    if (result.sessionId === "a") { entered.resolve(); await released.promise; }
    return result;
  };
  const first = s.controller.switchTo("a");
  await entered.promise;
  s.edit("A 新编辑");
  s.select("b");
  await s.controller.switchTo("b");
  s.edit("B 新编辑");
  s.select("a");
  const again = s.controller.switchTo("a");
  released.resolve();
  await Promise.all([first, again]);
  assert.equal(s.input.value, "A 新编辑");
  await s.controller.flush();
  await settle();
  assert.equal(s.records.get("a").text, "A 新编辑");
  assert.equal(s.records.get("b").text, "B 新编辑");
  assert.equal(s.view().sessionId, "a");
});

test("停顿300毫秒保存，持续输入最长1秒发起保存", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  s.edit("第一版");
  t.mock.timers.tick(299);
  await settle();
  assert.equal(s.calls.filter(([name]) => name === "save").length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(s.records.get("a").text, "第一版");
  for (let i = 0; i < 5; i += 1) {
    s.edit(`持续输入${i}`);
    t.mock.timers.tick(200);
    await settle();
  }
  assert.equal(s.records.get("a").text, "持续输入4");
});

test("保存失败保留输入，不自动重试，显式重试保存最新编辑", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const save = s.api.saveComposerDraft;
  let failures = 0;
  s.api.saveComposerDraft = async () => { failures += 1; throw new Error("模拟写入失败"); };
  s.edit("失败前输入");
  await assert.rejects(s.controller.flush(), /模拟写入失败/);
  assert.equal(s.view().retryable, true);
  assert.equal(s.view().canSend, false);
  s.edit("失败后继续编辑");
  await settle();
  assert.equal(failures, 1);
  s.api.saveComposerDraft = save;
  await s.controller.retry();
  assert.equal(s.records.get("a").text, "失败后继续编辑");
  assert.equal(s.view().retryable, false);
});

test("发送前先保存原文，等待确认的新输入不写旧版本，确认后补保存", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  s.edit("  待发送原文\r\n ");
  const ticket = await s.controller.prepareSend();
  assert.equal(ticket.text, "  待发送原文\r\n ");
  assert.equal(s.records.get("a").text, ticket.text);
  assert.equal(s.input.value, "");
  s.edit(" \t下一条\n ");
  assert.equal(await s.controller.flush(), null);
  assert.equal(s.records.get("a").text, ticket.text);
  const ack = s.consume(ticket);
  s.controller.confirmConsumed(ticket, ack);
  await settle();
  assert.equal(s.records.get("a").text, " \t下一条\n ");
  s.records.get("a").pendingSend = null;
  await s.controller.finishSend(ticket, { outcome: "completed", draft: ack });
  assert.equal(s.input.value, " \t下一条\n ");
  assert.equal(s.view().canSend, true);
});

test("正常完成和主动停止不恢复原文，未确认或清理警告保留快照", async (t) => {
  for (const outcome of ["completed", "stopped", "unconfirmed", "warning"]) {
    const s = await setup(t);
    await s.controller.switchTo("a");
    const ticket = await s.controller.prepareSend();
    const ack = s.consume(ticket);
    const retained = ["unconfirmed", "warning"].includes(outcome);
    if (!retained) s.records.get("a").pendingSend = null;
    await s.controller.finishSend(ticket, {
      outcome: outcome === "warning" ? "completed" : outcome,
      draft: ack, ...(outcome === "warning" ? { warning: "模拟收尾失败" } : {}),
    });
    assert.equal(s.input.value, "");
    assert.equal(s.view().canSend, !retained);
    assert.equal(Boolean(s.view().pendingSend), retained);
    assert.equal(s.records.get("a").text, "");
  }
});

test("消费前异常核对后恢复原文，但不覆盖等待期间的主动清空", async (t) => {
  for (const clear of [false, true]) {
    const s = await setup(t);
    await s.controller.switchTo("a");
    const ticket = await s.controller.prepareSend();
    if (clear) { s.edit("新输入"); s.edit(""); }
    const result = await s.controller.recoverSend(ticket);
    assert.equal(result.status, "not-consumed");
    assert.equal(s.input.value, clear ? "" : ticket.text);
    assert.equal(s.records.get("a").text, s.input.value);
  }
});

test("核对失败保留等待与输入，显式重试采用消费状态并保存新输入", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const ticket = await s.controller.prepareSend();
  s.consume(ticket);
  s.edit("新输入");
  const inspect = s.api.inspectComposerSend;
  s.api.inspectComposerSend = async () => { throw new Error("请求尚未结束"); };
  await assert.rejects(s.controller.recoverSend(ticket), /尚未结束/);
  assert.equal(s.input.value, "新输入");
  assert.equal(s.view().canSend, false);
  s.api.inspectComposerSend = inspect;
  assert.equal((await s.controller.retry()).status, "consumed");
  assert.equal(s.records.get("a").text, "新输入");
  assert.equal(s.view().pendingSend.text, ticket.text);
});

test("核对期间切换 B，A 的失败恢复不能回填 B", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const ticket = await s.controller.prepareSend();
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const inspect = s.api.inspectComposerSend;
  s.api.inspectComposerSend = async (id) => {
    if (id === "a") { entered.resolve(); await released.promise; }
    return inspect(id);
  };
  const recovering = s.controller.recoverSend(ticket);
  await entered.promise;
  s.select("b");
  await s.controller.switchTo("b");
  s.edit("B 新输入");
  released.resolve();
  await recovering;
  assert.equal(s.input.value, "B 新输入");
  s.select("a");
  await s.controller.switchTo("a");
  assert.equal(s.input.value, ticket.text);
});

test("读取中版本变化须重读，一致后才登记队列，不沿用旧版本", async (t) => {
  const s = await setup(t);
  const inspect = s.api.inspectComposerSend;
  let changed = false;
  s.api.inspectComposerSend = async (id) => {
    if (!changed) {
      changed = true;
      Object.assign(s.records.get(id), { text: "外部新版本", revision: 3 });
    }
    return inspect(id);
  };
  await assert.rejects(s.controller.switchTo("a"), /内容已变化/);
  assert.equal(s.view().canSend, false);
  await s.controller.retry();
  assert.equal(s.input.value, "外部新版本");
  s.edit("继续编辑");
  await s.controller.flush();
  assert.equal(s.records.get("a").revision, 4);
});

test("初次读取包含未确认快照时禁止发送，后来的输入仍可保存", async (t) => {
  const s = await setup(t);
  s.records.get("a").pendingSend = { id: "old", text: "旧快照", draftRevision: 0 };
  await s.controller.switchTo("a");
  assert.equal(s.view().canSend, false);
  assert.equal(s.view().pendingSend.text, "旧快照");
  await assert.rejects(s.controller.prepareSend(), /待确认/);
  s.edit("新的未发送输入");
  await s.controller.flush();
  assert.equal(s.records.get("a").text, "新的未发送输入");
  assert.equal(s.records.get("a").pendingSend.text, "旧快照");
});

test("释放组件后移除输入监听和定时保存，不继续发布页面状态", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  s.edit("待保存输入");
  const views = s.views.length;
  s.controller.dispose();
  s.edit("释放后的输入");
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(s.calls.some(([name]) => name === "save"), false);
  assert.equal(s.views.length, views);
});

test("慢保存期间切换会话，准备发送失败但不清空目标输入", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const save = s.api.saveComposerDraft;
  s.api.saveComposerDraft = async (...args) => {
    if (args[0] === "a") { entered.resolve(); await released.promise; }
    return save(...args);
  };
  s.edit("A 准备发送");
  const preparing = s.controller.prepareSend();
  const rejected = assert.rejects(preparing, /会话已变化/);
  await entered.promise;
  s.select("b");
  await s.controller.switchTo("b");
  released.resolve();
  await rejected;
  assert.equal(s.input.value, "B 原文");
  assert.equal(s.records.get("a").text, "A 准备发送");
  assert.equal(s.records.get("a").pendingSend, null);
});

test("发送完成后的输入保存失败只报告输入状态，不恢复原文或改写请求结果", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const ticket = await s.controller.prepareSend();
  const ack = s.consume(ticket);
  s.edit("新的待保存输入");
  s.api.saveComposerDraft = async () => { throw new Error("模拟补保存失败"); };
  s.records.get("a").pendingSend = null;
  assert.equal(await s.controller.finishSend(ticket, { outcome: "completed", draft: ack }), true);
  assert.equal(s.input.value, "新的待保存输入");
  assert.equal(s.view().pendingSend, null);
  assert.equal(s.view().retryable, true);
  assert.match(s.view().message, /补保存失败/);
});

test("读取期间或同会话刷新前的程序赋值仍同步队列，不发送旧正文", async (t) => {
  const s = await setup(t);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const load = s.api.loadComposerDraft;
  s.api.loadComposerDraft = async () => {
    const stored = await load();
    entered.resolve();
    await released.promise;
    return stored;
  };
  const reading = s.controller.switchTo("a");
  await entered.promise;
  s.input.value = "程序设置的新输入";
  released.resolve();
  await reading;
  await s.controller.flush();
  assert.equal(s.records.get("a").text, "程序设置的新输入");
  s.input.value = "刷新前程序设置";
  await s.controller.switchTo("a");
  const ticket = await s.controller.prepareSend();
  assert.equal(ticket.text, "刷新前程序设置");
});
test("模板追加保留原输入，通过原队列保存，切换会话后互不覆盖", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const original = s.input.value;
  s.controller.appendTemplate("测试模板正文");
  const expected = `${original}\n\n测试模板正文`;
  assert.equal(s.input.value, expected);
  await s.controller.flush();
  assert.equal(s.records.get("a").text, expected);

  s.select("b");
  await s.controller.switchTo("b");
  assert.equal(s.input.value, "B 原文");
  s.select("a");
  await s.controller.switchTo("a");
  assert.equal(s.input.value, expected);

  s.edit("");
  s.controller.appendTemplate("空输入模板");
  assert.equal(s.input.value, "空输入模板");
  await s.controller.flush();
  assert.equal(s.records.get("a").text, "空输入模板");
});

test("输入未加载、待确认发送或只读时拒绝模板，保持原文", async (t) => {
  const s = await setup(t);
  assert.throws(() => s.controller.appendTemplate("不应写入"), /不可插入模板/);
  await s.controller.switchTo("a");
  const original = s.input.value;
  s.input.readOnly = true;
  assert.throws(() => s.controller.appendTemplate("不应写入"), /不可插入模板/);
  s.input.readOnly = false;
  s.records.get("b").pendingSend = { id: "pending", text: "待确认原文", draftRevision: 4 };
  s.select("b");
  await s.controller.switchTo("b");
  assert.throws(() => s.controller.appendTemplate("不应写入"), /不可插入模板/);
  assert.equal(s.input.value, "B 原文");
  assert.equal(s.records.get("a").text, original);
});
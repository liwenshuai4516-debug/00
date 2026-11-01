const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createChatService } = require("../../src/main/services/chat-service.js");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-chat-draft-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createSessionStateStore(root);
  const text = "  原文\r\n第二行  ";
  await store.saveDraft("a", root, text, 0);

  const session = {
    sessionId: "a",
    sessionManager: { getCwd: () => root },
    async abort() {},
  };
  const sessions = { getSession: async () => session };
  const calls = [];
  let sender = async () => {};

  const service = createChatService(
    sessions,
    async () => async (...args) => {
      calls.push(args);
      await sender(...args);
    },
    undefined,
    store,
  );

  return {
    root, store, text, session, sessions, service, calls,
    setSender(value) { sender = value; },
    send: (metadata = { sessionId: "a", revision: 1 }, onConsumed = () => {}) =>
      service.send(text, () => {}, () => {}, () => {}, metadata, onConsumed),
  };
}

test("先持久化并通知版本，再调用模型；完成按原会话保留新输入", async (t) => {
  const f = await setup(t);
  let confirmed = false;

  f.setSender(async (session, text) => {
    assert.equal(confirmed, true);
    assert.equal(session, f.session);
    assert.equal(text, f.text.trim());

    const state = await f.store.load("a");
    assert.equal(state.pendingSend.text, f.text);
    await f.store.saveDraft("a", f.root, "下一条输入", 2);
    f.sessions.getSession = async () => assert.fail("收尾不能重新查询当前会话");
  });

  const result = await f.send(undefined, (ack) => {
    assert.equal(ack.sessionId, "a");
    assert.equal(ack.revision, 2);
    assert.equal(ack.text, "");
    confirmed = true;
    ack.sendId = "回调不能改写服务内部编号";
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.stopped, false);
  assert.equal(result.draft.sessionId, "a");
  assert.equal(result.warning, undefined);

  const state = await f.store.load("a");
  assert.deepEqual(state.draft, { text: "下一条输入", revision: 3 });
  assert.equal(state.pendingSend, null);
  assert.equal(f.service.isBusy(), false);
});

test("参数、会话、版本或消费写入失败时不调用模型且不改原输入", async (t) => {
  const f = await setup(t);

  for (const metadata of [
    null,
    {},
    { sessionId: "a", revision: -1 },
    { sessionId: "b", revision: 1 },
    { sessionId: "a", revision: 0 },
  ]) {
    await assert.rejects(f.send(metadata), /发送会话|当前会话|待发送输入/);
    assert.equal(f.service.isBusy(), false);
  }

  const rename = t.mock.method(fs, "rename", async () => {
    throw new Error("模拟消费写入失败");
  });
  try {
    await assert.rejects(f.send(), /模拟消费写入失败/);
  } finally {
    rename.mock.restore();
  }

  assert.equal(f.calls.length, 0);
  const state = await f.store.load("a");
  assert.deepEqual(state.draft, { text: f.text, revision: 1 });
  assert.equal(state.pendingSend, null);
});

test("初始化期间停止仍消费并收尾，不调用模型，参数在等待前固定", async (t) => {
  const f = await setup(t);
  const entered = Promise.withResolvers();
  const ready = Promise.withResolvers();
  f.sessions.getSession = () => {
    entered.resolve();
    return ready.promise;
  };

  const metadata = { sessionId: "a", revision: 1 };
  const pending = f.send(metadata);
  try {
    await entered.promise;
    metadata.sessionId = "b";
    metadata.revision = 99;
    await f.service.stop();
  } finally {
    ready.resolve(f.session);
  }

  assert.equal((await pending).outcome, "stopped");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.load("a")).pendingSend, null);
  assert.deepEqual((await f.store.load("a")).draft, { text: "", revision: 2 });
});

test("消费写入期间保持忙碌，停止后不调用模型，也不提前 abort", async (t) => {
  const f = await setup(t);
  const entered = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const original = f.store.consumeDraft;

  t.mock.method(f.store, "consumeDraft", async (...args) => {
    entered.resolve();
    await ready.promise;
    return original(...args);
  });
  f.session.abort = () => assert.fail("模型尚未开始");

  const pending = f.send();
  try {
    await entered.promise;
    assert.equal(f.service.isBusy(), true);
    await assert.rejects(f.send(), /已有消息正在生成/);
    await f.service.stop();
  } finally {
    ready.resolve();
  }

  assert.equal((await pending).outcome, "stopped");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.load("a")).pendingSend, null);
});

test("生成期间主动停止清理快照，保留新输入", async (t) => {
  const f = await setup(t);
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  f.session.abort = async () => finished.resolve();

  f.setSender(async () => {
    entered.resolve();
    await finished.promise;
    throw new Error("模拟主动中断");
  });

  const pending = f.send();
  try {
    await entered.promise;
    await f.store.saveDraft("a", f.root, "停止前的新输入", 2);
    await f.service.stop();
  } finally {
    finished.resolve();
  }

  const result = await pending;
  assert.equal(result.outcome, "stopped");
  assert.equal(result.stopped, true);
  const state = await f.store.load("a");
  assert.equal(state.pendingSend, null);
  assert.equal(state.draft.text, "停止前的新输入");
});

test("消费后模型异常返回未确认，保留快照和新输入，不自动重试", async (t) => {
  const f = await setup(t);
  f.setSender(async () => {
    await f.store.saveDraft("a", f.root, "新输入", 2);
    throw new Error("连接中断，无法确认远端结果");
  });

  const result = await f.send();
  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.error, /连接中断/);
  const state = await f.store.load("a");
  assert.equal(state.pendingSend.id, result.draft.sendId);
  assert.equal(state.pendingSend.text, f.text);
  assert.equal(state.draft.text, "新输入");
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.isBusy(), false);
});

test("正常回复后收尾失败返回附加提示，不变成请求失败", async (t) => {
  const f = await setup(t);
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();

  t.mock.method(f.store, "completeSend", () => {
    entered.resolve();
    return finished.promise;
  });

  const pending = f.send();
  try {
    await entered.promise;
    assert.equal(f.service.isBusy(), true);
    await assert.rejects(f.send(), /已有消息正在生成/);
  } finally {
    finished.reject(new Error("模拟清理失败"));
  }

  const result = await pending;
  assert.equal(result.outcome, "completed");
  assert.match(result.warning, /快照清理失败.*模拟清理失败/);
  assert.equal(result.error, undefined);
  assert.ok((await f.store.load("a")).pendingSend);
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.isBusy(), false);
});

test("消费确认回调异常时不调用模型，保留快照并释放忙碌状态", async (t) => {
  const f = await setup(t);
  const result = await f.send(undefined, () => {
    throw new Error("模拟页面确认失败");
  });

  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.error, /页面确认失败/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.load("a")).pendingSend.text, f.text);
  assert.equal(f.service.isBusy(), false);
});
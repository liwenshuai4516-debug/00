const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAgentWatchdog } = require("../../src/main/services/agent-watchdog.js");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createSessionService } = require("../../src/main/services/session-service.js");
const idleMs = 10 * 60 * 1000;

test("无进展十分钟只取消一次，三十秒后报告停止未确认，清理后不再触发", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = 0, unresponsive = 0;
  const watchdog = createAgentWatchdog({
    onTimeout: () => cancelled++, onUnresponsive: () => unresponsive++, isWaitingForInput: () => false,
  });
  t.mock.timers.tick(idleMs - 1);
  assert.equal(cancelled, 0);
  t.mock.timers.tick(1);
  assert.equal(cancelled, 1);
  watchdog.touch();
  t.mock.timers.tick(30000);
  assert.equal(unresponsive, 1);
  watchdog.dispose();
  t.mock.timers.tick(idleMs * 2);
  assert.equal(cancelled, 1);
  assert.equal(unresponsive, 1);
});

test("进展重置超时，等待用户期间不取消，结束交互后重新计算十分钟", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = 0, waiting = false;
  const watchdog = createAgentWatchdog({
    onTimeout: () => cancelled++, onUnresponsive: () => {}, isWaitingForInput: () => waiting,
  });
  t.mock.timers.tick(idleMs - 1);
  watchdog.touch();
  t.mock.timers.tick(idleMs - 1);
  assert.equal(cancelled, 0);
  waiting = true;
  t.mock.timers.tick(1);
  assert.equal(cancelled, 0);
  waiting = false;
  watchdog.touch();
  t.mock.timers.tick(idleMs - 1);
  assert.equal(cancelled, 0);
  watchdog.dispose();
  t.mock.timers.tick(idleMs * 2);
  assert.equal(cancelled, 0);
});

async function fixture(t, sender) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-watchdog-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createSessionStateStore(directory);
  await store.saveDraft("a", directory, "原始任务", 0);
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let aborts = 0, sends = 0, childStops = 0;
  const session = {
    sessionId: "a", sessionManager: { getCwd: () => directory },
    abort: async () => { aborts++; finish.resolve(); },
    desktopSubagents: { stop: async () => { childStops++; } },
  };
  const statuses = [];
  const service = createChatService({ getSession: async () => session }, async () => async (...args) => {
    sends++;
    entered.resolve();
    if (sender) await sender(...args);
    else await finish.promise;
  }, undefined, store);
  const send = () => service.send("原始任务", () => {}, () => {}, value => statuses.push(value), { sessionId: "a", revision: 1 });
  return { directory, store, session, service, send, entered, finish, statuses,
    counts: () => ({ aborts, sends, childStops }) };
}

test("超时停止父子任务并释放会话，保留发送快照和后续输入，不自动重发", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const pending = f.send();
  await f.entered.promise;
  await f.store.saveDraft("a", f.directory, "下一条输入", 2);
  t.mock.timers.tick(idleMs);
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.error, /看门狗已停止.*手动继续/);
  assert.equal(f.service.isBusy(), false);
  assert.deepEqual(f.counts(), { aborts: 1, sends: 1, childStops: 1 });
  const state = await f.store.load("a");
  assert.equal(state.pendingSend.text, "原始任务");
  assert.equal(state.draft.text, "下一条输入");
  t.mock.timers.tick(idleMs * 2);
  assert.equal(f.statuses.length, 1, "结束后不再报告未响应");
});

test("停止未退出时维持互斥锁，拒绝重复生成；迟到退出后才恢复可用", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const abortGate = Promise.withResolvers();
  f.session.abort = () => abortGate.promise;
  const pending = f.send();
  await f.entered.promise;
  t.mock.timers.tick(idleMs);
  await Promise.resolve();
  t.mock.timers.tick(30000);
  assert.equal(f.service.isBusy(), true);
  await assert.rejects(f.send(), /已有消息正在生成/);
  assert.match(f.statuses.at(-1), /退出仍未确认/);
  f.finish.resolve();
  assert.equal(f.service.isBusy(), true, "发送函数返回也必须等停止确认");
  abortGate.resolve();
  assert.equal((await pending).outcome, "unconfirmed");
  assert.equal(f.service.isBusy(), false);
});

test("取消失败不释放锁，不重试取消也不重放请求", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  let aborts = 0;
  f.session.abort = async () => { aborts++; f.finish.resolve(); throw new Error("工具取消失败"); };
  const pending = f.send();
  await f.entered.promise;
  t.mock.timers.tick(idleMs);
  const result = await pending;
  assert.match(result.error, /停止未确认/);
  assert.equal(result.outcome, "unconfirmed");
  assert.equal(f.service.isBusy(), true);
  await assert.rejects(f.send(), /已有消息正在生成/);
  assert.equal(aborts, 1);
  assert.ok((await f.store.load("a")).pendingSend);
});

test("子任务进展、工具输出和思考事件均延后超时；正常完成清理计时", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const finish = Promise.withResolvers();
  const f = await fixture(t, async (session, _text, _delta, tool, _status, output) => {
    for (const progress of [
      () => session.desktopAgentProgress(),
      () => tool({ type: "start", toolCallId: "tool-1", name: "bash" }),
      () => output({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "思考" } }),
    ]) {
      t.mock.timers.tick(idleMs - 1);
      progress();
    }
    await finish.promise;
  });
  const pending = f.send();
  await f.entered.promise;
  assert.equal(f.counts().aborts, 0);
  finish.resolve();
  assert.equal((await pending).outcome, "completed");
  t.mock.timers.tick(idleMs * 2);
  assert.equal(f.counts().aborts, 0);
  assert.equal(f.session.desktopAgentProgress, undefined);
});

test("异常结束先停止遗留父子任务，保留快照，不自动重试", async t => {
  const f = await fixture(t, async () => { throw new Error("模拟异常终止"); });
  const result = await f.send();
  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.error, /模拟异常终止/);
  assert.deepEqual(f.counts(), { aborts: 1, sends: 1, childStops: 1 });
  assert.equal(f.service.isBusy(), false);
  assert.ok((await f.store.load("a")).pendingSend);
});

test("一方同步取消报错仍中止另一方，并保留互斥锁", async t => {
  const f = await fixture(t, async () => { throw new Error("模拟运行异常"); });
  f.session.desktopSubagents.stop = () => { throw new Error("同步取消失败"); };
  const result = await f.send();
  assert.equal(f.counts().aborts, 1);
  assert.match(result.error, /停止未确认/);
  assert.equal(f.service.isBusy(), true);
});

test("进程重启恢复已有会话并提示未确认运行，不清理快照或发送任务", async t => {
  const f = await fixture(t);
  await f.store.consumeDraft("a", f.directory, "原始任务", 1);
  let restored = 0;
  const sessions = createSessionService(f.directory, async () => { restored++; return f.session; },
    () => f.directory, undefined, f.store);
  const session = await sessions.getSession(true);
  assert.equal(session, f.session);
  assert.match(session.desktopRestoreWarning, /上次运行未确认.*不会自动重发/);
  assert.equal(await sessions.getSession(true), session);
  assert.equal(restored, 1);
  assert.ok((await f.store.load("a")).pendingSend);
  assert.equal(f.counts().sends, 0);
});

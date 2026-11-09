const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { parseWatchdogCommand, createHandoff } = require("../../src/main/services/watchdog-recovery.js");

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "watchdog-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createSessionStateStore(directory);
  let aborts = 0, childStops = 0, replacements = 0;
  const create = id => ({
    sessionId: id, sessionFile: path.join(directory, `${id}.jsonl`),
    model: { provider: "mock", id: "fixture" }, thinkingLevel: "high",
    sessionManager: { getCwd: () => directory }, messages: [],
    abort: async () => { aborts++; }, desktopSubagents: { stop: async () => { childStops++; } },
  });
  let current = create("original");
  const source = current;
  const sessions = {
    getSession: async () => current,
    continueInNewSession: async previous => {
      assert.equal(previous, current);
      replacements++;
      current = create(`next-${replacements}`);
      return current;
    },
  };
  const sent = [], statuses = [], outputs = [];
  const clocks = [];
  let sender = async () => {};
  const service = createChatService(sessions, async () => async (...args) => {
    sent.push({ session: args[0], text: args[1] });
    return sender(...args);
  }, undefined, store, async () => async () => ({ disposition: "queued" }), undefined, callbacks => {
    clocks.push(callbacks);
    return { touch() {}, dispose() {} };
  });
  async function send(text) {
    const state = await store.load(current.sessionId);
    const saved = await store.saveDraft(current.sessionId, directory, text, state?.draft.revision ?? 0);
    return service.send(text, () => {}, () => {}, value => statuses.push(value),
      { sessionId: current.sessionId, revision: saved.draft.revision }, () => {}, output => outputs.push(output));
  }
  return { directory, source, store, sessions, service, sent, statuses, outputs, clocks, send,
    get current() { return current; }, setSender: value => { sender = value; },
    counts: () => ({ aborts, childStops, replacements }) };
}

test("只有用户输入的指令前缀生效，引用、否定和正文提及不会启动", () => {
  assert.deepEqual(parseWatchdogCommand("启动看门狗"), { enabled: true, task: "" });
  assert.deepEqual(parseWatchdogCommand("启动看门狗，执行测试"), { enabled: true, task: "执行测试" });
  assert.deepEqual(parseWatchdogCommand("关闭看门狗\n继续检查"), { enabled: false, task: "继续检查" });
  for (const text of ["不要启动看门狗", "说明：启动看门狗", "`启动看门狗`", "启动看门狗是什么意思"]) {
    assert.equal(parseWatchdogCommand(text), null);
  }
});

test("启动和关闭指令不请求模型，开关随会话保存且不改写输入版本", async t => {
  const f = await setup(t);
  assert.match((await f.send("启动看门狗")).completionStatus, /已启动/);
  assert.equal(f.sent.length, 0);
  let state = await f.store.load("original");
  assert.equal(state.watchdogEnabled, true);
  assert.equal(state.pendingSend, null);
  assert.equal(state.draft.revision, 2);
  const reopened = createSessionStateStore(f.directory);
  assert.equal((await reopened.load("original")).watchdogEnabled, true);
  assert.equal(await reopened.load("unrelated"), null);
  await f.send("停止看门狗");
  state = await f.store.load("original");
  assert.equal(state.watchdogEnabled, false);
  assert.equal(f.sent.length, 0);
});

test("重开同一会话后仍读取已启用开关，自动恢复而不要求重复启动", async t => {
  const f = await setup(t);
  await f.send("启动看门狗");
  delete f.source.desktopWatchdogEnabled;
  let calls = 0;
  const reopened = createChatService(f.sessions, async () => async () => {
    if (++calls === 1) throw new Error("连接意外中断");
  }, undefined, f.store);
  const result = await reopened.send("继续任务", () => {}, () => {});
  assert.equal(result.stopped, false);
  assert.match(result.completionStatus, /自动恢复 1 次/);
  assert.equal(calls, 2);
});

test("十分钟超时后确认退出才自动继续；保存新输入，完成后只清理原发送快照", async t => {
  const f = await setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), aborted = Promise.withResolvers();
  f.source.abort = async () => { await aborted.promise; };
  f.setSender(async (_session, _text, _delta, _tool, _status, output) => {
    if (f.sent.length === 1) { entered.resolve(); await release.promise; }
    else output({ type: "agent_settled", sessionId: "original", aborted: false });
  });
  const pending = f.send("启动看门狗\n执行长时间测试");
  await entered.promise;
  await f.store.saveDraft("original", f.directory, "后续输入", 2);
  f.clocks[0].onTimeout();
  release.resolve();
  await Promise.resolve();
  assert.equal(f.sent.length, 1);
  assert.equal(f.service.isBusy(), true);
  aborted.resolve();
  const result = await pending;
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].text, "执行长时间测试");
  assert.match(f.sent[1].text, /继续当前尚未完成的任务/);
  assert.match(f.sent[1].text, /不盲目重放/);
  assert.equal(result.stopped, false);
  assert.equal(result.outcome, "completed");
  assert.match(result.completionStatus, /自动恢复 1 次/);
  assert.equal((await f.store.load("original")).pendingSend, null);
  assert.equal((await f.store.load("original")).draft.text, "后续输入");
  assert.equal(f.service.isBusy(), false);
});

test("运行中普通指令立即开启和关闭，不交给 Pi steer 或等下一条排队", async t => {
  const f = await setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.setSender(async () => { entered.resolve(); await release.promise; });
  const pending = f.send("执行任务");
  await entered.promise;
  assert.match((await f.service.steer("启动看门狗")).status, /已启动/);
  assert.equal((await f.store.load("original")).watchdogEnabled, true);
  assert.match((await f.service.steer("关闭看门狗")).status, /已关闭/);
  assert.equal((await f.store.load("original")).watchdogEnabled, false);
  release.resolve();
  assert.equal((await pending).outcome, "completed");
  assert.equal(f.sent.length, 1);
});

test("自动模式中的手动停止取消当前任务，不产生自动继续", async t => {
  const f = await setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.source.abort = async () => release.resolve();
  f.setSender(async () => { entered.resolve(); await release.promise; });
  const pending = f.send("启动看门狗，执行任务");
  await entered.promise;
  await f.service.stop();
  assert.equal((await pending).outcome, "stopped");
  assert.equal(f.sent.length, 1);
});

test("超时后的停止等待期间手动停止，覆盖自动继续意图", async t => {
  const f = await setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), stopGate = Promise.withResolvers();
  f.source.abort = async () => { await stopGate.promise; release.resolve(); };
  f.setSender(async () => { entered.resolve(); await release.promise; });
  const pending = f.send("启动看门狗，执行任务");
  await entered.promise;
  f.clocks[0].onTimeout();
  const stop = f.service.stop();
  stopGate.resolve();
  await stop;
  assert.equal((await pending).stopped, true);
  assert.equal(f.sent.length, 1);
});

test("上下文超限错误交接新对话，保留目标、用户补充及工具记录，返回会话变化", async t => {
  const f = await setup(t);
  f.source.messages = [
    { role: "user", content: [{ type: "text", text: "验收全部模块" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "run tests" } }] },
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "第一批已完成" }] },
  ];
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.setSender(async (session, _text, _delta, _tool, _status, output) => {
    if (session === f.source) {
      entered.resolve(); await release.promise;
      throw new Error("maximum context length exceeded");
    }
    output({ type: "agent_settled", sessionId: session.sessionId, aborted: false });
  });
  const pending = f.send("启动看门狗，完成剩余检查");
  await entered.promise;
  await f.service.steer("优先检查登录模块");
  release.resolve();
  const result = await pending;
  assert.equal(result.sessionChanged, true);
  assert.equal(result.outcome, "completed");
  assert.equal(f.current.sessionId, "next-1");
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /完成剩余检查/);
  assert.match(f.sent[1].text, /验收全部模块/);
  assert.match(f.sent[1].text, /第一批已完成/);
  assert.match(f.sent[1].text, /优先检查登录模块/);
  assert.match(f.sent[1].text, /call-1/);
  assert.match(f.sent[1].text, /original.jsonl/);
  assert.equal((await f.store.load("next-1")).watchdogEnabled, true);
  assert.equal((await f.store.load("original")).pendingSend, null);
  assert.equal(f.outputs.at(-1).requestSessionId, "original");
});

test("上下文达到百分之九十时提前交接，不向旧上下文发送新推理", async t => {
  const f = await setup(t);
  f.source.getContextUsage = () => ({ percent: 91 });
  const result = await f.send("启动看门狗，执行长期任务");
  assert.equal(result.sessionChanged, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].session.sessionId, "next-1");
  assert.equal(f.counts().replacements, 1);
});

test("工具轮次后达到阈值会交接，但正常最终回复到达阈值不会额外续跑", async t => {
  for (const stopReason of ["toolUse", "stop"]) {
    const f = await setup(t);
    let percent = 10;
    f.source.getContextUsage = () => ({ percent });
    f.setSender(async (session, _text, _delta, _tool, _status, output) => {
      if (session !== f.source) return;
      percent = 95;
      output({ type: "message_end", message: { role: "assistant", stopReason } });
      output({ type: "turn_end", message: { role: "assistant", stopReason } });
    });
    const result = await f.send("启动看门狗，执行任务");
    assert.equal(result.outcome, "completed");
    assert.equal(f.counts().replacements, stopReason === "toolUse" ? 1 : 0);
    assert.equal(f.sent.length, stopReason === "toolUse" ? 2 : 1);
  }
});

test("交接前把完整超长用户任务保存到原历史，摘录截断也能查询完整目标", async t => {
  const f = await setup(t);
  const entries = [];
  f.source.getContextUsage = () => ({ percent: 95 });
  f.source.sessionManager.appendCustomEntry = (type, data) => entries.push({ type, data });
  const task = "超长目标".repeat(5000);
  assert.equal((await f.send(`启动看门狗，${task}`)).outcome, "completed");
  assert.equal(entries[0].type, "desktop-watchdog-handoff");
  assert.equal(entries[0].data.task, task);
  assert.match(f.sent[0].text, /完整本轮目标.*desktop-watchdog-handoff/);
});

test("SDK 异常终止事件触发继续，即使发送函数没有抛错", async t => {
  const f = await setup(t);
  f.setSender(async (_session, _text, _delta, _tool, _status, output) => {
    if (f.sent.length === 1) output({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
  });
  assert.equal((await f.send("启动看门狗，执行任务")).outcome, "completed");
  assert.equal(f.sent.length, 2);
});

test("Pi 原生重试已成功时不再自动继续，避免重复执行已完成的任务", async t => {
  const f = await setup(t);
  f.setSender(async (_session, _text, _delta, _tool, _status, output) => {
    output({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "临时连接中断" } });
    output({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "任务已完成" }] } });
  });
  assert.equal((await f.send("启动看门狗，执行任务")).outcome, "completed");
  assert.equal(f.sent.length, 1);
  assert.equal(f.counts().aborts, 0);
});

test("输出长度截断后自动继续，最终完整结束后不再发送", async t => {
  const f = await setup(t);
  f.setSender(async (_session, _text, _delta, _tool, _status, output) => {
    output({ type: "message_end", message: { role: "assistant", stopReason: f.sent.length === 1 ? "length" : "stop" } });
  });
  assert.equal((await f.send("启动看门狗，执行任务")).outcome, "completed");
  assert.equal(f.sent.length, 2);
});

test("连续三次自动恢复无新进展就停止，保留快照，不无限调用模型", async t => {
  const f = await setup(t);
  f.setSender(async () => { throw new Error("连接中断"); });
  const result = await f.send("启动看门狗，执行任务");
  assert.equal(f.sent.length, 4);
  assert.match(result.error, /连续 3 次/);
  assert.equal(result.outcome, "unconfirmed");
  assert.ok((await f.store.load("original")).pendingSend);
  assert.equal(f.service.isBusy(), false);
});

test("凭据、额度和限流错误直接报告，不自动重试", async t => {
  for (const message of ["HTTP 401 invalid api key", "No API key found for provider", "insufficient_quota", "HTTP 429 rate limit"]) {
    const f = await setup(t);
    f.setSender(async () => { throw new Error(message); });
    const result = await f.send("启动看门狗，执行任务");
    assert.equal(result.outcome, "unconfirmed");
    assert.equal(result.error, message);
    assert.equal(f.sent.length, 1);
  }
});

test("取消失败时自动模式也保留锁定，不在新会话继续", async t => {
  const f = await setup(t);
  f.source.abort = async () => { throw new Error("取消失败"); };
  f.setSender(async () => { throw new Error("连接中断"); });
  const result = await f.send("启动看门狗，执行任务");
  assert.match(result.error, /停止未确认/);
  assert.equal(f.service.isBusy(), true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.counts().replacements, 0);
});

test("交接摘录有长度上限，排除隐藏思考，保留真实历史入口", () => {
  const prompt = createHandoff({ sessionId: "a", sessionFile: "/tmp/a.jsonl",
    messages: Array.from({ length: 30 }, () => ({ role: "assistant", content: [
      { type: "text", text: "数据".repeat(10000) }, { type: "thinking", thinking: "不可转发思考" },
    ] })) }, "任务".repeat(15000), "补充".repeat(10000));
  assert.ok(prompt.length < 40000);
  assert.ok(!prompt.includes("不可转发思考"));
  assert.match(prompt, /\/tmp\/a.jsonl/);
});

test("自动新会话沿用真实目录、模型和思考等级，原历史与用户输入保持原归属", async t => {
  const f = await setup(t);
  const old = f.source;
  let disposed = 0, options;
  old.isIdle = true;
  old.dispose = () => { disposed++; };
  const next = { ...old, sessionId: "next", dispose() {} };
  let calls = 0;
  const sessions = createSessionService(f.directory, async (...args) => {
    calls++;
    if (calls === 1) return old;
    options = args;
    return next;
  }, () => f.directory, undefined, f.store);
  await sessions.getSession();
  await f.store.saveDraft("original", f.directory, "用户后续输入", 0);
  assert.equal(await sessions.continueInNewSession(old), next);
  assert.equal(await sessions.getSession(), next);
  assert.equal(disposed, 1);
  assert.equal(options[3], f.directory);
  assert.deepEqual(options[5].modelSelection, { provider: "mock", modelId: "fixture" });
  assert.equal(options[5].thinkingLevel, "high");
  assert.equal((await f.store.load("original")).draft.text, "用户后续输入");
  assert.equal((await f.store.load("next")).watchdogEnabled, true);
});

test("新对话准备失败保留原会话；原任务未退出时不创建新对话", async t => {
  const f = await setup(t);
  let calls = 0;
  const sessions = createSessionService(f.directory, async () => {
    if (++calls === 1) return f.source;
    throw new Error("模拟新会话创建失败");
  }, () => f.directory, undefined, f.store);
  await sessions.getSession();
  f.source.isIdle = false;
  await assert.rejects(sessions.continueInNewSession(f.source), /仍在运行/);
  assert.equal(calls, 1);
  f.source.isIdle = true;
  await assert.rejects(sessions.continueInNewSession(f.source), /创建失败/);
  assert.equal(await sessions.getSession(), f.source);
});

test("新对话模型不匹配时释放候选并保留原会话，不静默更换模型", async t => {
  const f = await setup(t);
  let disposed = 0, calls = 0;
  const sessions = createSessionService(f.directory, async () => {
    if (++calls === 1) return f.source;
    return { ...f.source, sessionId: "wrong", model: { provider: "mock", id: "another" }, dispose: () => disposed++ };
  }, () => f.directory, undefined, f.store);
  await sessions.getSession();
  await assert.rejects(sessions.continueInNewSession(f.source), /目录或模型不匹配/);
  assert.equal(await sessions.getSession(), f.source);
  assert.equal(disposed, 1);
});

test("新对话准备期间关闭看门狗，不再发送继续指令", async t => {
  const f = await setup(t);
  const preparing = Promise.withResolvers(), prepared = Promise.withResolvers();
  const replace = f.sessions.continueInNewSession;
  f.sessions.continueInNewSession = async previous => {
    preparing.resolve();
    await prepared.promise;
    return replace(previous);
  };
  f.source.getContextUsage = () => ({ percent: 95 });
  const pending = f.send("启动看门狗，执行任务");
  await preparing.promise;
  await f.service.steer("关闭看门狗");
  prepared.resolve();
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.load("next-1")).watchdogEnabled, false);
});

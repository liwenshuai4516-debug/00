const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { createOutputEventAdapter, outputMessage } = require("../../src/main/adapters/output-event-adapter.js");
const { toHistory } = require("../../src/main/adapters/message-adapter.js");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

const skills = [{ name: "demo", filePath: "/work/.pi/skills/demo/SKILL.md" }];
const session = { resourceLoader: { getSkills: () => ({ skills }) }, sessionManager: { getCwd: () => "/work" } };

test("增量事件去除累计快照与签名，最终消息保留输出块而不泄露隐藏思考", () => {
  const project = createOutputEventAdapter(() => session, () => null, "测试");
  const call = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" }, thoughtSignature: "hidden" };
  const raw = { role: "assistant", content: [
    { type: "thinking", thinking: "公开思考", thinkingSignature: "hidden" },
    { type: "thinking", thinking: "REDACTED_PAYLOAD", redacted: true, thinkingSignature: "hidden" },
    call, { type: "image", data: "BASE64_PAYLOAD" },
  ], provider: "mock", model: "test", stopReason: "toolUse" };
  const update = project({ type: "message_update", message: raw, assistantMessageEvent: {
    type: "toolcall_end", contentIndex: 2, toolCall: call, partial: raw,
  } });
  assert.equal(update.assistantMessageEvent.toolCall.id, "c1");
  assert.equal("partial" in update.assistantMessageEvent, false);
  const redacted = project({ type: "message_update", message: raw, assistantMessageEvent: {
    type: "thinking_delta", contentIndex: 1, delta: "REDACTED_PAYLOAD", partial: raw,
  } });
  assert.deepEqual(redacted.assistantMessageEvent, { type: "thinking_delta", contentIndex: 1, redacted: true });
  const final = project({ type: "message_end", message: raw });
  assert.equal(final.message.content[0].thinking, "公开思考");
  assert.equal(final.message.content[1].thinking, "");
  assert.doesNotMatch(JSON.stringify([update, redacted, final]), /hidden|REDACTED_PAYLOAD|BASE64_PAYLOAD|Signature/);
  assert.equal(raw.content[1].thinking, "REDACTED_PAYLOAD");
});

test("技能标记仅来自真实展开及已加载技能 read，进度与乱序结束按调用编号关联", async () => {
  const { parseSkillBlock } = await import("@mariozechner/pi-coding-agent");
  const project = createOutputEventAdapter(() => session, parseSkillBlock, "/skill:demo 参数");
  const expanded = `<skill name="demo" location="${skills[0].filePath}">\n指令\n</skill>\n\n参数`;
  assert.equal(project({ type: "message_end", message: { role: "user", content: expanded } }).message.skill.source, "explicit");
  assert.equal(project({ type: "message_end", message: { role: "user", content: "/skill:demo 参数" } }), null);
  assert.equal(createOutputEventAdapter(() => session, parseSkillBlock, "自然输入")({ type: "message_end", message: { role: "user", content: expanded } }), null);
  const start = project({ type: "tool_execution_start", toolCallId: "skill", toolName: "read", args: { path: ".pi/skills/demo/SKILL.md" } });
  assert.equal(start.skill.name, "demo");
  assert.equal(project({ type: "tool_execution_start", toolCallId: "plain", toolName: "read", args: { path: ".pi/skills/other/SKILL.md" } }).skill, undefined);
  const end = project({ type: "tool_execution_end", toolCallId: "skill", toolName: "read", parentToolCallId: "parent", result: { content: [{ type: "text", text: "指令" }], details: { secret: true } }, isError: false, durationMs: 5 });
  assert.equal(end.skill.source, "read"); assert.equal(end.parentToolCallId, "parent"); assert.equal(end.durationMs, 5);
  assert.equal("details" in end.result, false);
  assert.deepEqual(project({ type: "agent_end", willRetry: true }), { type: "agent_end", willRetry: true });
  assert.deepEqual(project({ type: "agent_settled", aborted: false }), { type: "agent_settled", aborted: false });
});

test("丰富历史保留纯工具/思考响应、嵌套摘要与技能记录，默认文本转换仍兼容", async () => {
  const { parseSkillBlock } = await import("@mariozechner/pi-coding-agent");
  const raw = [
    { role: "user", content: `<skill name="demo" location="${skills[0].filePath}">\n指令\n</skill>\n\n参数` },
    { role: "assistant", content: [{ type: "thinking", thinking: "分析" }, { type: "toolCall", id: "c", name: "read", arguments: { path: skills[0].filePath } }] },
    { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "结果" }], isError: false,
      nestedCalls: { complete: false, calls: [{ id: "child", name: "bash", status: "unfinished", private: "隐藏" }] } },
  ];
  const history = toHistory(raw, { includeTrace: true, parseSkillBlock, skills, cwd: "/work" });
  assert.equal(history.length, 3); assert.equal(history[0].text, "/skill:demo 参数");
  assert.equal(history[1].text, ""); assert.equal(history[1].output.content[0].thinking, "分析");
  assert.equal(history[2].output.skill.name, "demo");
  assert.equal(history[2].output.nestedCalls.complete, false);
  assert.doesNotMatch(JSON.stringify(outputMessage(raw[2])), /private|隐藏/);
  assert.equal(toHistory(raw).length, 2);
});

test("停止后继续转发工具结束与 settled，旧正文停止转发", async () => {
  const started = Promise.withResolvers(), stopped = Promise.withResolvers();
  const text = [], output = [];
  const service = createChatService({ getSession: async () => ({ abort: () => stopped.resolve() }) }, async () => async (_session, _text, onText, _tool, _status, onOutput) => {
    onText("开始"); started.resolve(); await stopped.promise;
    onText("停止后正文"); onOutput({ type: "tool_execution_end" }); onOutput({ type: "agent_settled", aborted: true });
  });
  const pending = service.send("开始", value => text.push(value), () => {}, undefined, undefined, undefined, value => output.push(value));
  await started.promise; await service.stop(); await pending;
  assert.deepEqual(text, ["开始"]); assert.deepEqual(output.map(item => item.type), ["tool_execution_end", "agent_settled"]);
});

test("输出只发送来源窗口，预加载固定通道不暴露 Electron 事件并可单独解绑", async () => {
  const handlers = new Map(), received = [];
  let output, destroyed = false;
  registerAgentIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {}, {
    isBusy: () => false, send(_text, _onText, _tool, _status, _draft, _ack, onOutput) { output = onOutput; },
  });
  await handlers.get("agent:send-message")({ sender: { isDestroyed: () => destroyed, send: (...args) => received.push(args) } }, "测试");
  output({ type: "turn_start" }); destroyed = true; output({ type: "turn_end" });
  assert.deepEqual(received, [["agent:output-event", { type: "turn_start" }]]);
  const ipcRenderer = new EventEmitter(); let api;
  runInNewContext(readFileSync(require.resolve("../../src/preload/preload.js"), "utf8"), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(_name, value) { api = value; } } }),
  });
  const events = [], unrelated = () => {};
  ipcRenderer.on("agent:output-event", unrelated);
  const unsubscribe = api.onOutputEvent((...args) => events.push(args));
  ipcRenderer.emit("agent:output-event", { secret: true }, { type: "turn_start" });
  unsubscribe();
  assert.deepEqual(events, [[{ type: "turn_start" }]]);
  assert.deepEqual(ipcRenderer.listeners("agent:output-event"), [unrelated]);
});

test("插话投递：队列移除后再出现用户消息时补发投递事件", () => {
  const project = createOutputEventAdapter(() => session, () => null, "测试");
  assert.deepEqual(project({ type: "queue_update", steering: ["插话一"] }), { type: "queue_update", steering: ["插话一"] });
  // 正常发送的用户消息由页面本地回显，不重复补发。
  assert.equal(project({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "正常发送" }] } }), null);
  // Pi 在投递前先发 queue_update 移除条目，随后才是用户消息。
  assert.deepEqual(project({ type: "queue_update", steering: [] }), { type: "queue_update", steering: [] });
  assert.deepEqual(
    project({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "插话一" }] } }),
    { type: "steer_delivered", text: "插话一" },
  );
  // 只补一次，后续同样文本的用户消息不再触发。
  assert.equal(project({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "插话一" }] } }), null);
});

test("生成中插话只使用活动请求的会话，未生成时拒绝", async () => {
  const calls = [];
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const session = { sessionId: "s1", abort: () => finish() };
  const service = createChatService(
    { getSession: async () => session },
    async () => async () => { await gate; },
    undefined,
    undefined,
    async () => async (target, text) => {
      calls.push([target, text]);
      return { disposition: "queued" };
    },
  );

  await assert.rejects(() => service.steer("太早"), /当前没有正在生成的回复/);
  const pending = service.send("开始", () => {}, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await service.steer("插话"), { queued: true });
  assert.deepEqual(calls, [[session, "插话"]]);
  await service.stop();
  await pending;
  await assert.rejects(() => service.steer("结束后"), /当前没有正在生成的回复/);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");

async function model() {
  const { createTrajectoryModel } = await import("../../src/renderer/components/trajectory-model.js");
  return createTrajectoryModel();
}

test("历史按用户消息分组，保留耗时、token 与工具参数", async () => {
  const trajectory = await model();
  const base = 1_000_000;
  trajectory.loadHistory([
    { role: "user", text: "改一下 a.js", ts: base },
    {
      role: "assistant",
      output: {
        role: "assistant", ts: base + 10, durationMs: 1200, provider: "p", model: "m",
        usage: { input: 100, output: 20, totalTokens: 120 },
        content: [
          { type: "thinking", thinking: "先看文件" },
          { type: "text", text: "我来修改。" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.js" } },
        ],
      },
    },
    {
      role: "tool",
      output: {
        role: "toolResult", ts: base + 1215, durationMs: 30, toolCallId: "c1", toolName: "read",
        content: [{ type: "text", text: "one\ntwo" }], isError: false,
      },
    },
    {
      role: "assistant",
      output: {
        role: "assistant", ts: base + 1250, durationMs: 800,
        usage: { input: 200, output: 30, totalTokens: 230 },
        content: [{ type: "text", text: "已修改。" }],
      },
    },
    { role: "user", text: "再跑测试", ts: base + 3000 },
    {
      role: "assistant",
      output: {
        role: "assistant", ts: base + 3010, durationMs: 600, usage: { input: 300, output: 10, totalTokens: 310 },
        content: [{ type: "text", text: "测试通过。" }],
      },
    },
  ], "s1");

  const snapshot = trajectory.snapshot();
  assert.equal(snapshot.sessionId, "s1");
  assert.equal(snapshot.hasTimeline, true);
  assert.equal(snapshot.requests.length, 2);
  assert.deepEqual(snapshot.totals, { requests: 2, durationMs: 2660, input: 600, output: 60, total: 660 });

  const [first, second] = snapshot.requests;
  assert.equal(first.userText, "改一下 a.js");
  assert.equal(second.userText, "再跑测试");
  assert.deepEqual(first.records.map((record) => record.kind), ["user", "assistant", "tool", "assistant"]);
  const tool = first.records.find((record) => record.kind === "tool");
  assert.equal(tool.toolName, "read");
  assert.deepEqual(tool.args, { path: "a.js" });
  assert.equal(tool.result, "one\ntwo");
  assert.equal(tool.durationMs, 30);
  assert.equal(first.records[1].thinking, "先看文件");
  assert.equal(first.usage.total, 350);
  assert.equal(second.usage.total, 310);
});

test("旧历史缺少时间戳时不伪造时间轴", async () => {
  const trajectory = await model();
  trajectory.loadHistory([
    { role: "user", text: "你好" },
    { role: "assistant", output: { role: "assistant", content: [{ type: "text", text: "回复" }], durationMs: 50 } },
  ]);
  const snapshot = trajectory.snapshot();
  assert.equal(snapshot.hasTimeline, false);
  assert.equal(snapshot.requests[0].startedAt, null);
  assert.equal(snapshot.requests[0].records[1].ts, null);
});

test("实时事件按请求累积，settled 后关闭本轮", async () => {
  const trajectory = await model();
  trajectory.beginRequest("hello");
  trajectory.accept({ type: "agent_start" });
  trajectory.accept({
    type: "message_end",
    message: {
      role: "assistant", ts: 2000, durationMs: 300, provider: "p", model: "m",
      usage: { input: 10, output: 5, totalTokens: 15 },
      content: [{ type: "text", text: "hi" }],
    },
  });
  trajectory.accept({
    type: "tool_execution_end", toolCallId: "c1", toolName: "bash",
    args: { command: "ls" }, durationMs: 30, isError: false,
    result: { content: [{ type: "text", text: "a\nb" }] },
  });
  trajectory.accept({ type: "steer_delivered", text: "插话" });
  trajectory.accept({ type: "agent_settled", aborted: false });

  const snapshot = trajectory.snapshot();
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0].status, "done");
  assert.deepEqual(snapshot.requests[0].records.map((record) => record.kind), ["user", "assistant", "tool", "user"]);
  assert.equal(snapshot.requests[0].records[2].result, "a\nb");
  assert.equal(snapshot.hasTimeline, true);
});

test("开始下一轮会关闭未收尾的上一轮，历史载入会清空实时数据", async () => {
  const trajectory = await model();
  trajectory.beginRequest("第一轮");
  trajectory.beginRequest("第二轮");
  assert.equal(trajectory.snapshot().requests[0].status, "done");
  assert.equal(trajectory.snapshot().requests.length, 2);

  trajectory.loadHistory([{ role: "user", text: "历史", ts: 1000 }], "s2");
  const snapshot = trajectory.snapshot();
  assert.equal(snapshot.sessionId, "s2");
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0].userText, "历史");
});

test("没有用户消息的历史从首条助手记录开始一轮", async () => {
  const trajectory = await model();
  trajectory.loadHistory([
    { role: "assistant", output: { role: "assistant", ts: 5000, durationMs: 100, content: [{ type: "text", text: "恢复的回复" }] } },
  ]);
  const snapshot = trajectory.snapshot();
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0].startedAt, 5000);
  assert.equal(snapshot.requests[0].records[0].kind, "assistant");
});

test("实时工具开始时显示运行中，结束后补结果；未结束标记结果未确认", async () => {
  const trajectory = await model();
  trajectory.beginRequest("执行");
  trajectory.accept({
    type: "tool_execution_start", toolCallId: "c1", toolName: "bash",
    args: { command: "sleep 1" },
  });
  let tool = trajectory.snapshot().requests[0].records.find((record) => record.kind === "tool");
  assert.equal(tool.status, "running");
  assert.equal(tool.result, "");

  trajectory.accept({
    type: "tool_execution_end", toolCallId: "c1", toolName: "bash", durationMs: 1000,
    isError: false, result: { content: [{ type: "text", text: "done" }] },
  });
  tool = trajectory.snapshot().requests[0].records.find((record) => record.kind === "tool");
  assert.equal(tool.status, "done");
  assert.equal(tool.durationMs, 1000);
  assert.equal(tool.result, "done");

  trajectory.accept({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "a" } });
  trajectory.accept({ type: "agent_settled", aborted: false });
  const unfinished = trajectory.snapshot().requests[0].records.find((record) => record.id && record.status === "unfinished");
  assert.equal(unfinished.kind, "tool");
  assert.equal(unfinished.toolName, "read");
});

test("历史结束时未返回结果的工具调用标记为未确认", async () => {
  const trajectory = await model();
  trajectory.loadHistory([
    { role: "user", text: "执行", ts: 1000 },
    {
      role: "assistant",
      output: {
        role: "assistant", ts: 1010, durationMs: 20,
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 99" } }],
      },
    },
  ]);
  const records = trajectory.snapshot().requests[0].records;
  const tool = records.find((record) => record.kind === "tool");
  assert.equal(tool.toolName, "bash");
  assert.equal(tool.status, "unfinished");
  assert.deepEqual(tool.args, { command: "sleep 99" });
});

test("历史耗时构成按等待、模型、工具、回放和失败拆分", async () => {
  const trajectory = await model();
  trajectory.loadHistory([
    { role: "user", text: "执行", ts: 0 },
    {
      role: "assistant",
      output: {
        role: "assistant", ts: 10, durationMs: 100,
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "node resources/testing/ui/execute.cjs" } }],
      },
    },
    {
      role: "tool",
      output: {
        role: "toolResult", ts: 110, durationMs: 10, toolCallId: "c1", toolName: "bash",
        summaryFile: "/work/qa/ui/runs/r/summary.json", isError: true,
        content: [{ type: "text", text: "fail" }],
      },
    },
    { role: "user", text: "继续", ts: 1000 },
    { role: "assistant", output: { role: "assistant", ts: 1010, durationMs: 50, content: [{ type: "text", text: "ok" }] } },
  ]);
  const [first, second] = trajectory.snapshot().requests;
  assert.deepEqual(first.timing, {
    totalMs: 120,
    waitingMs: 10,
    modelMs: 100,
    toolMs: 10,
    replayMs: 10,
    toolOtherMs: 0,
    toolErrorMs: 10,
    retryMs: 0,
    retryCount: 0,
    compactionMs: 0,
    source: "history",
    available: true,
  });
  assert.equal(second.timing.waitingMs, 10);
  assert.equal(second.timing.modelMs, 50);
});

test("实时重试与整理进入耗时构成", async () => {
  const trajectory = await model();
  const base = Date.now();
  trajectory.beginRequest("重试");
  trajectory.accept({
    type: "message_end",
    message: { role: "assistant", ts: base + 10, durationMs: 100, content: [{ type: "text", text: "first" }] },
  });
  trajectory.accept({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 50, ts: base + 120 });
  trajectory.accept({ type: "compaction_start", ts: base + 200 });
  trajectory.accept({ type: "compaction_end", ts: base + 300, aborted: false });
  trajectory.accept({ type: "agent_settled", aborted: false, ts: base + 300 });
  trajectory.endRequest();
  const timing = trajectory.snapshot().requests[0].timing;
  assert.equal(timing.retryMs, 50);
  assert.equal(timing.retryCount, 1);
  assert.equal(timing.compactionMs, 100);
  assert.equal(timing.modelMs, 100);
  assert.equal(timing.source, "live");
});

test("实时助手按内容索引累积，最终替换同一记录并只计算一次用量", async () => {
  const trajectory = await model();
  trajectory.reset("live");
  trajectory.accept({ type: "message_start", ts: 1000, message: { role: "assistant", ts: 1000 } });
  const id = trajectory.snapshot().requests[0].records[0].id;
  const update = (ts, type, contentIndex, extra) => trajectory.accept({ type: "message_update", ts, assistantMessageEvent: { type, contentIndex, ...extra } });
  update(1100, "text_delta", 2, { delta: "" });
  update(1200, "thinking_delta", 0, { delta: "思考" });
  update(1300, "text_delta", 2, { delta: "临时正文" });
  update(1400, "toolcall_start", 1, { id: "c1", toolName: "read" });
  update(1500, "toolcall_delta", 1, { delta: '{"path":"a"}' });
  const before = trajectory.snapshot();
  assert.equal(before.requests[0].records[0].text, "临时正文");
  assert.equal(before.requests[0].records[0].observedTiming.firstTokenAt, 1200);
  const content = [
    { type: "thinking", thinking: "最终思考" },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
    { type: "text", text: "最终正文" },
  ];
  trajectory.accept({ type: "message_end", ts: 2000, message: {
    role: "assistant", ts: 1000, durationMs: 950, stopReason: "toolUse",
    usage: { input: 10, output: 217, totalTokens: 227 }, content,
  } });
  const request = trajectory.snapshot().requests[0];
  assert.equal(request.records.length, 1);
  assert.equal(request.records[0].id, id);
  assert.equal(request.records[0].text, "最终正文");
  assert.equal(request.records[0].status, "done");
  assert.equal(request.records[0].durationMs, 950);
  assert.deepEqual(request.records[0].content, content);
  assert.deepEqual(request.records[0].observedTiming, { startedAt: 1000, firstTokenAt: 1200, completedAt: 2000 });
  assert.equal(request.usage.total, 227);
  assert.equal(before.requests[0].records[0].observedTiming.completedAt, null, "旧快照不随新事件改变");
});

test("隐藏思考不计首 Token，停止及历史恢复不补造首 Token 时间", async () => {
  const trajectory = await model();
  trajectory.accept({ type: "message_start", ts: 1000, message: { role: "assistant" } });
  trajectory.accept({ type: "message_update", ts: 1500, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, redacted: true, delta: "隐藏" } });
  trajectory.accept({ type: "agent_settled", ts: 1600, aborted: true });
  const record = trajectory.snapshot().requests[0].records[0];
  assert.equal(record.status, "unfinished");
  assert.equal(record.thinking, "");
  assert.equal(record.observedTiming.firstTokenAt, null);
  assert.equal(record.observedTiming.completedAt, null);
  trajectory.loadHistory([{ role: "assistant", output: { role: "assistant", ts: 1000, durationMs: 200, content: [{ type: "text", text: "历史" }] } }], "history");
  assert.equal(trajectory.snapshot().requests[0].records[0].observedTiming, undefined);
});

test("工具保持调用编号与调用时 Schema，结果结束不丢失关联", async () => {
  const trajectory = await model();
  const schema = { name: "read", description: "读取文件", parameters: { type: "object" } };
  trajectory.accept({ type: "tool_execution_start", ts: 1000, toolCallId: "c", toolName: "read", schema });
  const id = trajectory.snapshot().requests[0].records[0].id;
  trajectory.accept({ type: "tool_execution_end", ts: 1500, toolCallId: "c", toolName: "read", durationMs: 500, result: { content: [{ type: "text", text: "完成" }] } });
  const record = trajectory.snapshot().requests[0].records[0];
  assert.equal(record.id, id);
  assert.equal(record.toolCallId, "c");
  assert.deepEqual(record.schema, schema);
});

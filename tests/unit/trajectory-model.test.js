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

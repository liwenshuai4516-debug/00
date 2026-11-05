const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWorkspaceChangesExtension } = require("../../src/main/resources/workspace-changes-extension.mjs");

function harness(capture) {
  const handlers = new Map();
  const pi = { on: (name, handler) => handlers.set(name, handler) };
  createWorkspaceChangesExtension({ capture })(pi);
  return handlers.get("tool_call");
}

test("write 与 edit 在执行前捕获目标", async () => {
  const calls = [];
  const handler = harness(async (value) => { calls.push(value); });
  const ctx = { cwd: "/work", sessionManager: { getSessionId: () => "s1" } };

  await handler({ toolName: "write", input: { path: "a.txt", content: "x" } }, ctx);
  await handler({ toolName: "edit", input: { path: "b.txt", edits: [] } }, ctx);

  assert.deepEqual(calls.map((call) => [call.sessionId, call.cwd, call.toolName, call.input.path]), [
    ["s1", "/work", "write", "a.txt"],
    ["s1", "/work", "edit", "b.txt"],
  ]);
});

test("读取类工具和缺失路径不触发捕获", async () => {
  const calls = [];
  const handler = harness(async (value) => { calls.push(value); });
  await handler({ toolName: "read", input: { path: "a.txt" } }, { cwd: "/work" });
  await handler({ toolName: "write", input: {} }, { cwd: "/work" });
  assert.deepEqual(calls, []);
});

test("捕获失败不能阻止原始工具执行", async () => {
  const handler = harness(async () => { throw new Error("磁盘不可读"); });
  await assert.doesNotReject(handler({
    toolName: "write",
    input: { path: "a.txt" },
  }, { cwd: "/work", sessionManager: { getSessionId: () => "s1" } }));
});

test("会话读取异常时仍按工作目录提交捕获", async () => {
  const calls = [];
  const handler = harness(async (value) => { calls.push(value); });
  await handler({ toolName: "write", input: { path: "a.txt" } }, {
    cwd: "/work",
    sessionManager: { getSessionId: () => { throw new Error("已释放"); } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "");
});

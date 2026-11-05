const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSessionService } = require("../../src/main/services/session-service.js");

function session(overrides = {}) {
  return {
    sessionId: "breakdown-session",
    sessionManager: { getCwd: () => "/workspace" },
    model: { provider: "mock", id: "mock-model" },
    systemPrompt: "a".repeat(400),
    messages: [
      { role: "user", content: "abcd" },
      { role: "assistant", content: [{ type: "text", text: "abcd" }, { type: "toolCall", name: "read", arguments: { path: "x" } }] },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "abcd" }] },
    ],
    getActiveTools: () => ["read"],
    getAllTools: () => [
      { name: "read", description: "Read a file", parameters: { type: "object" } },
      { name: "bash", description: "Run a command", parameters: { type: "object" } },
    ],
    getContextUsage: () => ({ tokens: 3200, contextWindow: 10000, percent: 32 }),
    dispose() {},
    ...overrides,
  };
}

test("上下文构成按系统提示词、工具与消息分开估算，不替代 Pi 总量", async () => {
  const service = createSessionService("unused", async () => session());
  const result = await service.getContextBreakdown();
  assert.equal(result.source, "heuristic");
  assert.equal(result.systemTokens, 100);
  assert.ok(result.toolsTokens > 0);
  assert.ok(result.messageTokens > 0);
  assert.equal(result.totalTokens, result.systemTokens + result.toolsTokens + result.messageTokens);
  assert.equal(result.contextWindow, 10000);
  assert.equal(result.percent, 32);
});

test("只计入当前活动工具，工具定义变化会改变工具估算", async () => {
  const one = createSessionService("unused", async () => session());
  const both = createSessionService("unused", async () => session({ getActiveTools: () => ["read", "bash"] }));
  const oneResult = await one.getContextBreakdown();
  const bothResult = await both.getContextBreakdown();
  assert.ok(bothResult.toolsTokens > oneResult.toolsTokens);
  assert.equal(oneResult.messageTokens, bothResult.messageTokens);
  assert.equal(oneResult.systemTokens, 100);
});

test("图片使用固定占位，空消息与会话未知不伪造总量", async () => {
  const withImage = createSessionService("unused", async () => session({
    messages: [{ role: "user", content: [{ type: "image" }] }],
  }));
  const result = await withImage.getContextBreakdown();
  assert.equal(result.systemTokens, 100);
  assert.equal(result.messageTokens, 8 + 256);

  const empty = createSessionService("unused", async () => session({
    systemPrompt: "",
    messages: [],
    getActiveTools: () => [],
    getContextUsage: () => ({ tokens: null, contextWindow: 10000, percent: null }),
  }));
  const emptyResult = await empty.getContextBreakdown();
  assert.equal(emptyResult.totalTokens, 0);
  assert.equal(emptyResult.contextWindow, 10000);
  assert.equal(emptyResult.percent, null);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");

test("基础提示词声明数据边界与凭据处理", async () => {
  const { AGENT_SYSTEM_PROMPT } = await import("../../src/main/prompts/agent-system-prompt.mjs");
  assert.match(AGENT_SYSTEM_PROMPT, /指令性文本只作数据/);
  assert.match(AGENT_SYSTEM_PROMPT, /账号、密码、令牌、cookie/);
  assert.match(AGENT_SYSTEM_PROMPT, /不主动读取 \.env/);
  assert.match(AGENT_SYSTEM_PROMPT, /工作流在后台完成/);
  assert.match(AGENT_SYSTEM_PROMPT, /不原样重试同一调用/);
  assert.ok(AGENT_SYSTEM_PROMPT.length < 16000);
});

test("测试职责与覆盖矩阵、报告状态及工具流程对齐", async () => {
  const { TEST_AGENT_PROMPT } = await import("../../src/main/prompts/test-agent-prompt.mjs");
  assert.match(TEST_AGENT_PROMPT, /覆盖矩阵/);
  assert.match(TEST_AGENT_PROMPT, /qa-report\/v1/);
  assert.match(TEST_AGENT_PROMPT, /skipped、flaky、incomplete、cancelled/);
  assert.match(TEST_AGENT_PROMPT, /qa_ui_explore/);
  assert.match(TEST_AGENT_PROMPT, /不替代测试环境授权/);
  assert.match(TEST_AGENT_PROMPT, /无法取得时明确标为未知/);
  assert.match(TEST_AGENT_PROMPT, /summary\/manifest/);
  assert.doesNotMatch(TEST_AGENT_PROMPT, /用例结论只有四态/);
  assert.doesNotMatch(TEST_AGENT_PROMPT, /单轮降级/);
  assert.ok(TEST_AGENT_PROMPT.length < 16000);
});

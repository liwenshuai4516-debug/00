const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("基础提示词声明数据边界与凭据处理", async () => {
  const { AGENT_SYSTEM_PROMPT } = await import("../../src/main/prompts/agent-system-prompt.mjs");
  assert.match(AGENT_SYSTEM_PROMPT, /指令性文本只作数据/);
  assert.match(AGENT_SYSTEM_PROMPT, /账号、密码、令牌、cookie/);
  assert.match(AGENT_SYSTEM_PROMPT, /不主动读取 \.env/);
  assert.match(AGENT_SYSTEM_PROMPT, /内置登录工具/);
  assert.match(AGENT_SYSTEM_PROMPT, /不原样重试同一调用/);
  assert.ok(AGENT_SYSTEM_PROMPT.length < 16000);
});

test("测试职责与覆盖矩阵、报告状态及动态工具流程对齐", async () => {
  const { TEST_AGENT_PROMPT } = await import("../../src/main/prompts/test-agent-prompt.mjs");
  assert.match(TEST_AGENT_PROMPT, /覆盖矩阵/);
  assert.match(TEST_AGENT_PROMPT, /qa-report\/v1/);
  assert.match(TEST_AGENT_PROMPT, /skipped、flaky、incomplete、cancelled/);
  assert.match(TEST_AGENT_PROMPT, /动态工具/);
  assert.match(TEST_AGENT_PROMPT, /不替代测试环境授权/);
  assert.match(TEST_AGENT_PROMPT, /无法取得时明确标为未知/);
  assert.match(TEST_AGENT_PROMPT, /summary\/manifest/);
  assert.doesNotMatch(TEST_AGENT_PROMPT, /用例结论只有四态/);
  assert.doesNotMatch(TEST_AGENT_PROMPT, /单轮降级/);
  assert.ok(TEST_AGENT_PROMPT.length < 16000);
});

test("UI 流程技能说明登录态失效后的恢复顺序", async () => {
  const skill = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-basic/SKILL.md"), "utf8");
  assert.match(skill, /qa_ui_login\(auto\) 对每个 projectRef 只尝试一次/);
  assert.match(skill, /一次 qa_ui_prepare\(mode=run\) 会绑定该登录态/);
  assert.match(skill, /重新调用 qa_ui_project 获取新的 projectRef/);
  assert.match(skill, /finalize 只登记资产/);
  assert.match(skill, /不要重新 prepare 同一 case 来重试/);
});

test("UI 录制技能要求审批入口生成 case，审批技能只负责执行规程", async () => {
  const record = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-record/SKILL.md"), "utf8");
  assert.match(record, /页面出现提交、审批、同意、驳回、确认、上传定稿等入口/);
  assert.match(record, /不能因为未加载 qa-approval-workflow/);
  assert.match(record, /必须生成至少一条入口/);
  const approval = await fs.readFile(path.resolve(__dirname, "../../.pi/skills/qa-approval-workflow/SKILL.md"), "utf8");
  assert.match(approval, /不替代 `qa-ui-record` 的入口盘点和 case 生成/);
  assert.match(approval, /必须位于实际测试工作区的 `\.pi\/skills\/qa-approval-workflow\/SKILL\.md`/);
});

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
  const basic = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-basic/SKILL.md"), "utf8");
  assert.match(basic, /qa_ui_login\(auto\) 对每个 projectRef 只尝试一次/);
  assert.match(basic, /重新调用 qa_ui_project 获取新的 projectRef/);
  const execute = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-execute/SKILL.md"), "utf8");
  assert.match(execute, /run 准备会绑定当前登录态/);
  assert.match(execute, /不要重新 prepare 同一 case 来重试/);
  const record = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-record/SKILL.md"), "utf8");
  assert.match(record, /qa_ui_finalize 只登记资产/);
});

test("qa-ui-basic 只做流程编排，执行细节由执行技能维护", async () => {
  const basic = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-basic/SKILL.md"), "utf8");
  assert.match(basic, /qa-ui-record/);
  assert.match(basic, /qa-ui-execute/);
  assert.match(basic, /qa-test-report/);
  assert.match(basic, /具体步骤由对应执行技能维护/);
  assert.doesNotMatch(basic, /browser_snapshot|generator_read_log|replayCommand/);
  const record = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-record/SKILL.md"), "utf8");
  assert.match(record, /文件命名由工具生成/);
  assert.match(record, /generator_write_test/);
  const execute = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-execute/SKILL.md"), "utf8");
  assert.match(execute, /## 会话内 MCP 回放/);
  assert.match(execute, /--grep/);
});

test("UI 录制技能要求审批入口生成 case，审批技能只负责执行规程", async () => {
  const record = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-record/SKILL.md"), "utf8");
  assert.match(record, /页面出现提交、审批、同意、驳回、确认、上传定稿等入口/);
  assert.match(record, /不能因为未加载 qa-approval-workflow/);
  assert.match(record, /必须生成至少一条入口/);
  const approval = await fs.readFile(path.resolve(__dirname, "../../.pi/skills/qa-approval-workflow/SKILL.md"), "utf8");
  assert.match(approval, /不替代 `qa-ui-record` 的入口盘点和 case 生成/);
  assert.match(approval, /必须位于实际测试工作区的 `\.pi\/skills\/qa-approval-workflow\/SKILL\.md`/);
  assert.match(approval, /当前应用权限模式/);
  assert.match(approval, /`qa_ui_login` 的 auto 只使用项目配置中的账号/);
  assert.match(approval, /多角色场景需用 start\/complete/);
});

test("qa_ui_project 合并工作区准备，不再保留独立准备技能", async () => {
  const basic = await fs.readFile(path.resolve(__dirname, "../../resources/testing/ui/skills/qa-ui-basic/SKILL.md"), "utf8");
  assert.match(basic, /qa_ui_project 一次完成工作区校验/);
  assert.match(basic, /不再单独调用工作区准备技能/);
  assert.match(basic, /directoryAction、createdDirectories、cleanupPending/);
  const extension = await fs.readFile(path.resolve(__dirname, "../../src/main/capabilities/ui-testing/extension.mjs"), "utf8");
  assert.match(extension, /一次调用校验当前会话工作区、创建或复用 qa\/data\/ui\/cases/);
  await assert.rejects(
    fs.access(path.resolve(__dirname, "../../.pi/skills/qa-workspace-prepare/SKILL.md")),
  );
});

const { test } = require("node:test");
const assert = require("node:assert/strict");

test("资源译文仅匹配原始描述，不改命令或未知资源说明", async () => {
  const { translatePiDescription } = await import("../../src/renderer/components/settings/pi-resource-translations.js");
  assert.equal(translatePiDescription("Automate browser interactions, test web pages and work with Playwright tests."), "自动操作浏览器、测试网页，并使用 Playwright 测试。");
  assert.match(translatePiDescription("Technical guidance for operator-requested delegation to builtin or custom\nsubagents: bounded handoffs, parallel review, scripted workflows, async work,\nforked context, isolation, and coordinated execution."), /用户主动要求的子智能体委派/);
  assert.equal(translatePiDescription("Review/fix loop until clean"), "反复审查和修复，直到没有待处理问题。");
  assert.equal(translatePiDescription("中文描述，Use when 用户要求测试。"), "中文描述，适用于 用户要求测试。");
  assert.equal(translatePiDescription("New custom description /skill:custom"), "New custom description /skill:custom");
  assert.equal(translatePiDescription("已有中文说明"), "已有中文说明");
  assert.equal(translatePiDescription(""), "暂无描述");
});

test("扩展中文名称保留真实身份，未知扩展不冒充内置能力", async () => {
  const { getPiExtensionLabel } = await import("../../src/renderer/components/settings/pi-resource-translations.js");
  assert.equal(getPiExtensionLabel({ path: "builtin:codemode", name: "codemode" }).name, "代码执行");
  assert.equal(getPiExtensionLabel({ path: "builtin:tool-search", name: "tool-search" }).name, "工具搜索");
  assert.equal(getPiExtensionLabel({ path: "builtin:mcp", name: "mcp" }).name, "MCP 服务连接");
  assert.equal(getPiExtensionLabel({ path: "/packages/pi-subagents/index.js", name: "pi-subagents" }).name, "子智能体协作");
  assert.deepEqual(getPiExtensionLabel({ path: "/extensions/mcp.ts", name: "mcp" }), { name: "mcp" });
  assert.deepEqual(getPiExtensionLabel({ path: "/extensions/constructor.ts", name: "constructor" }), { name: "constructor" });
});

test("已知诊断中文化，未知错误及技术标识保留排错依据", async () => {
  const { translatePiDiagnostic } = await import("../../src/renderer/components/settings/pi-resource-translations.js");
  assert.equal(translatePiDiagnostic("Skill path does not exist"), "技能路径不存在。");
  assert.equal(translatePiDiagnostic('name "/review" collision'), "名称“/review”重复，已采用优先加载的资源。");
  assert.equal(translatePiDiagnostic("description exceeds 1024 characters (1200)"), "技能描述超过 1024 个字符，当前为 1200 个字符。");
  assert.equal(translatePiDiagnostic("ENOENT: /temporary/missing.ts"), "ENOENT: /temporary/missing.ts");
});

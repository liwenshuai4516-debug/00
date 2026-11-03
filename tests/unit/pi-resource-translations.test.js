const { test } = require("node:test");
const assert = require("node:assert/strict");

test("技能中文名覆盖主要资源来源，未知名称及特殊属性不冒充已知技能", async () => {
  const { getPiSkillName } = await import("../../src/renderer/components/settings/pi-resource-translations.js");
  assert.equal(getPiSkillName("qa-case-design"), "测试用例设计");
  assert.equal(getPiSkillName("api-discovery"), "接口发现与集成");
  assert.equal(getPiSkillName("playwright-browser"), "浏览器自动化");
  assert.equal(getPiSkillName("pi-subagents"), "子智能体协作");
  assert.equal(getPiSkillName("mcp-scripting"), "MCP 工具脚本编写");
  assert.equal(getPiSkillName("dingtalk-drive"), "钉钉文件与钉盘");
  assert.equal(getPiSkillName("自定义中文技能"), "自定义中文技能");
  assert.equal(getPiSkillName("custom-skill"), "custom-skill");
  assert.equal(getPiSkillName("constructor"), "constructor");
});

test("资源译文仅匹配原始描述，不改命令或未知资源说明", async () => {
  const { translatePiDescription } = await import("../../src/renderer/components/settings/pi-resource-translations.js");
  assert.equal(translatePiDescription("Automate browser interactions, test web pages and work with Playwright tests."), "自动操作浏览器、测试网页，并使用 Playwright 测试。");
  assert.match(translatePiDescription("Technical guidance for operator-requested delegation to builtin or custom\nsubagents: bounded handoffs, parallel review, scripted workflows, async work,\nforked context, isolation, and coordinated execution."), /用户主动要求的子智能体委派/);
  assert.equal(translatePiDescription("Review/fix loop until clean"), "反复审查和修复，直到没有待处理问题。");
  assert.match(translatePiDescription("Inspect Playwright trace files from the command line — list actions, view requests, console, errors, snapshots and screenshots."), /操作列表、网络请求、控制台、错误、页面快照和截图/);
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

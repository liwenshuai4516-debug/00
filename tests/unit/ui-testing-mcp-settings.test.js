const { test } = require("node:test");
const assert = require("node:assert/strict");


test("UI 测试会话启用内置 MCP 并移除 proxy-only 适配器", async () => {
  const { SettingsManager } = await import("@mariozechner/pi-coding-agent");
  const { enableBuiltinMcpForUiTesting } = await import("../../src/main/resources/pi-resources.mjs");
  const settings = SettingsManager.inMemory({
    packages: ["npm:pi-mcp-adapter", "npm:other"],
    extensions: ["-builtin:mcp", "-other"],
  });

  assert.equal(enableBuiltinMcpForUiTesting(settings), true);
  const effective = settings.getSettings();
  assert.deepEqual(effective.packages, ["npm:other"]);
  assert.deepEqual(effective.extensions, ["-other"]);
  assert.equal(enableBuiltinMcpForUiTesting(settings), false);
});

test("没有禁用内置 MCP 或适配器时保持原设置", async () => {
  const { SettingsManager } = await import("@mariozechner/pi-coding-agent");
  const { enableBuiltinMcpForUiTesting } = await import("../../src/main/resources/pi-resources.mjs");
  const settings = SettingsManager.inMemory({
    packages: ["npm:other"],
    extensions: ["-other"],
  });

  assert.equal(enableBuiltinMcpForUiTesting(settings), false);
  assert.deepEqual(settings.getSettings().extensions, ["-other"]);
  assert.deepEqual(settings.getSettings().packages, ["npm:other"]);
});

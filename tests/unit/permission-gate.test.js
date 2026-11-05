const { test } = require("node:test");
const assert = require("node:assert/strict");

async function loadExtension(initialMode = "ask") {
  const { createPermissionExtension } = await import("../../src/main/resources/permission-gate.mjs");
  const handlers = {};
  const state = { mode: initialMode };
  const tools = [
    { name: "read", annotations: { readOnlyHint: true } },
    { name: "bash" },
    { name: "custom_read", annotations: { readOnlyHint: true } },
    { name: "mcp__desktop_playwright_test__browser_snapshot" },
    { name: "mcp__desktop_playwright_test__browser_click" },
  ];
  const pi = {
    on(event, handler) { handlers[event] = handler; },
    getAllTools() { return tools; },
  };
  createPermissionExtension({ currentMode: () => state.mode })(pi);
  return { handlers, handler: handlers.tool_call, state };
}

test("每次确认下读工具直接执行，写工具需要确认", async () => {
  const { handler, state } = await loadExtension("ask");
  let prompts = 0;
  const ctx = { hasUI: true, ui: { async confirm() { prompts += 1; return true; } } };
  assert.equal(await handler({ toolName: "read", input: { path: "a" } }, ctx), undefined);
  assert.equal(prompts, 0);
  assert.equal(await handler({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx), undefined);
  assert.equal(prompts, 1);
  state.mode = "full-access";
  assert.equal(await handler({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx), undefined);
  assert.equal(prompts, 1);
});

test("只读模式阻止写工具，未知工具也不会放行", async () => {
  const { handler } = await loadExtension("read-only");
  const ctx = { hasUI: true, ui: { async confirm() { return true; } } };
  const blocked = await handler({ toolName: "bash", input: { command: "ls" } }, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /只读/);
  const unknown = await handler({ toolName: "custom_write", input: {} }, ctx);
  assert.equal(unknown.block, true);
  assert.equal(await handler({ toolName: "custom_read", input: {} }, ctx), undefined);
});

test("确认拒绝、无 UI 或确认异常都按失败关闭处理", async () => {
  const { handler } = await loadExtension("ask");
  const denied = await handler({ toolName: "bash", input: { command: "echo 1" } }, {
    hasUI: true,
    ui: { async confirm() { return false; } },
  });
  assert.equal(denied.block, true);
  assert.match(denied.reason, /未批准/);

  const noUi = await handler({ toolName: "bash", input: { command: "echo 1" } }, { hasUI: false, ui: {} });
  assert.equal(noUi.block, true);
  assert.match(noUi.reason, /界面不可用/);

  const failed = await handler({ toolName: "bash", input: { command: "echo 1" } }, {
    hasUI: true,
    ui: { async confirm() { throw new Error("bridge failed"); } },
  });
  assert.equal(failed.block, true);
});

test("完全权限直接放行写入、QA 准备和录制操作，不依赖界面", async () => {
  const { handler, state } = await loadExtension("full-access");
  const noUi = { hasUI: false, ui: {} };
  for (const toolName of ["bash", "write", "qa_ui_prepare", "mcp__desktop_playwright_test__browser_click"]) {
    assert.equal(await handler({ toolName, input: {} }, noUi), undefined, toolName);
  }
  state.mode = "ask";
  assert.equal((await handler({ toolName: "qa_ui_prepare", input: {} }, noUi)).block, true);
});

test("每次确认下浏览器观察工具不弹窗，点击类操作仍需确认", async () => {
  const { handler } = await loadExtension("ask");
  let prompts = 0;
  const ctx = { hasUI: true, ui: { async confirm() { prompts += 1; return true; } } };
  assert.equal(await handler({
    toolName: "mcp__desktop_playwright_test__browser_snapshot",
    input: {},
  }, ctx), undefined);
  assert.equal(await handler({
    toolName: "mcp__desktop_playwright_test__browser_verify_text_visible",
    input: {},
  }, ctx), undefined);
  assert.equal(prompts, 0);
  assert.equal(await handler({
    toolName: "mcp__desktop_playwright_test__browser_click",
    input: {},
  }, ctx), undefined);
  assert.equal(prompts, 1);
});

test("系统提示词按当前模式注入，模式切换后下一轮立即更新", async () => {
  const { handlers, state } = await loadExtension("full-access");
  const event = { systemPromptOptions: { sections: {} } };
  handlers.before_agent_start(event);
  const section = event.systemPromptOptions.sections["app-permission"];
  assert.match(section, /完全权限/);
  assert.match(section, /视为已授权/);
  assert.match(section, /不要逐项询问/);

  state.mode = "read-only";
  handlers.before_agent_start(event);
  assert.match(event.systemPromptOptions.sections["app-permission"], /只读/);
  assert.match(event.systemPromptOptions.sections["app-permission"], /不要尝试/);

  state.mode = "ask";
  handlers.before_agent_start(event);
  assert.match(event.systemPromptOptions.sections["app-permission"], /每次确认/);
  assert.match(event.systemPromptOptions.sections["app-permission"], /逐次弹窗确认/);
});

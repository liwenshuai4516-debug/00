const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("真实资源加载器注册改动捕获扩展，只拦截 write/edit", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "changes-registration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  try {
    await fs.mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    const workspace = path.join(base, "workspace");
    await fs.mkdir(workspace);

    const { createPiResources } = await import("../../src/main/resources/pi-resources.mjs");
    const calls = [];
    const changes = { capture: async (value) => { calls.push(value); } };
    const resources = await createPiResources({
      cwd: workspace,
      appendSystemPrompt: [],
      workspaceChanges: changes,
    });

    const extensions = resources.resourceLoader.getExtensions();
    assert.equal(extensions.errors.length, 0);
    const extension = extensions.extensions.find((entry) =>
      String(entry.path).includes("desktop-workspace-changes"));
    assert.ok(extension, "未找到桌面改动扩展");

    const handlers = extension.handlers.get("tool_call") ?? [];
    assert.equal(handlers.length, 1);
    const context = { cwd: workspace, sessionManager: { getSessionId: () => "s1" } };
    for (const handler of handlers) {
      await handler({ toolName: "write", input: { path: "a.txt" } }, context);
      await handler({ toolName: "edit", input: { path: "b.txt" } }, context);
      await handler({ toolName: "read", input: { path: "a.txt" } }, context);
    }

    assert.deepEqual(calls.map((call) => [call.sessionId, call.cwd, call.toolName, call.input.path]), [
      ["s1", workspace, "write", "a.txt"],
      ["s1", workspace, "edit", "b.txt"],
    ]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(base, { recursive: true, force: true });
  }
});

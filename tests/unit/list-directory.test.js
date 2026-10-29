const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
} = require("node:fs/promises");

// 每个测试使用独立目录，并在结束后清理。
async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-directory-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);

  const { createListDirectoryTool } = await import(
    "../../src/main/tools/list-directory.mjs"
  );

  return {
    workspace,
    outside,
    tool: createListDirectoryTool(workspace),
  };
}

test("可以列出工作目录中的子目录", async (t) => {
  const { workspace, tool } = await setup(t);
  await mkdir(path.join(workspace, "docs"));
  await writeFile(path.join(workspace, "docs", "guide.md"), "说明");

  const result = await tool.execute("test", { path: "docs" });

  assert.deepEqual(result.details.items, [
    { name: "guide.md", type: "file" },
  ]);
});

test("隐藏点文件、依赖目录和会话目录", async (t) => {
  const { workspace, tool } = await setup(t);
  await writeFile(path.join(workspace, ".env"), "测试配置");
  await mkdir(path.join(workspace, "node_modules"));
  await mkdir(path.join(workspace, "sessions"));

  const result = await tool.execute("test", { path: "." });

  assert.deepEqual(result.details.items, []);

  await assert.rejects(
    tool.execute("test", { path: "sessions" }),
    /不对 Agent 开放/,
  );
});

test("拒绝通过父目录访问工作目录外的位置", async (t) => {
  const { tool } = await setup(t);

  await assert.rejects(
    tool.execute("test", { path: "../outside" }),
    /工作目录之外/,
  );
});

test("拒绝通过符号链接访问工作目录外的位置", async (t) => {
  const { workspace, outside, tool } = await setup(t);
  await symlink(outside, path.join(workspace, "external"), "dir");

  await assert.rejects(
    tool.execute("test", { path: "external" }),
    /工作目录之外/,
  );
});
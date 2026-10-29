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

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-read-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const workspace = path.join(base, "workspace");
  await mkdir(workspace);

  const { createReadTextFileTool } = await import(
    "../../src/main/tools/read-text-file.mjs"
  );

  return { base, workspace, tool: createReadTextFileTool(workspace) };
}

test("正确读取中文文本并保留换行", async (t) => {
  const { workspace, tool } = await setup(t);
  const text = "项目说明\n第二行";

  await writeFile(path.join(workspace, "guide.md"), text);

  const result = await tool.execute("test", { path: "guide.md" });

  assert.deepEqual(result.details, { path: "guide.md", text });
});

test("拒绝读取隐藏文件和会话文件", async (t) => {
  const { workspace, tool } = await setup(t);
  await writeFile(path.join(workspace, ".env"), "测试配置");
  await mkdir(path.join(workspace, "sessions"));
  await writeFile(path.join(workspace, "sessions", "chat.jsonl"), "测试消息");

  for (const file of [".env", "sessions/chat.jsonl"]) {
    await assert.rejects(
      tool.execute("test", { path: file }),
      /不对 Agent 开放/,
    );
  }
});

test("拒绝父目录路径和指向目录外的符号链接", async (t) => {
  const { base, workspace, tool } = await setup(t);
  const outside = path.join(base, "outside.txt");

  await writeFile(outside, "目录外内容");
  await symlink(outside, path.join(workspace, "external.txt"));

  for (const file of ["../outside.txt", "external.txt"]) {
    await assert.rejects(
      tool.execute("test", { path: file }),
      /工作目录之外/,
    );
  }
});

test("拒绝超过大小限制的文件", async (t) => {
  const { workspace, tool } = await setup(t);
  await writeFile(path.join(workspace, "large.txt"), Buffer.alloc(32769, 65));

  await assert.rejects(
    tool.execute("test", { path: "large.txt" }),
    /超过 32 KiB/,
  );
});

test("拒绝包含空字节或无效 UTF-8 的文件", async (t) => {
  const { workspace, tool } = await setup(t);

  for (const bytes of [Buffer.from([65, 0]), Buffer.from([255])]) {
    await writeFile(path.join(workspace, "invalid.txt"), bytes);

    await assert.rejects(
      tool.execute("test", { path: "invalid.txt" }),
      /UTF-8 文本/,
    );
  }
});

test("拒绝把目录当作文件读取", async (t) => {
  const { tool } = await setup(t);

  await assert.rejects(
    tool.execute("test", { path: "." }),
    /请选择普通文件/,
  );
});
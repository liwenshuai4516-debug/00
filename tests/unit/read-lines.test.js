const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, writeFile, symlink, rm,
} = require("node:fs/promises");

async function setup(t) {
  // 所有文件都位于临时目录，不读取真实项目数据。
  const base = await mkdtemp(
    path.join(os.tmpdir(), "agent-read-lines-"),
  );
  t.after(() => rm(base, { recursive: true, force: true }));

  const workspace = path.join(base, "workspace");
  await mkdir(workspace);

  const { createReadLinesTool } = await import(
    "../../src/main/tools/read-lines.mjs"
  );

  return {
    base,
    workspace,
    tool: createReadLinesTool(workspace),
  };
}

function read(tool, extra = {}, signal) {
  return tool.execute(
    "test",
    {
      path: "file.txt",
      startLine: 1,
      lineCount: 2,
      ...extra,
    },
    signal,
  );
}

test("大于 32 KiB 的文件可分页，行号与续读位置正确", async (t) => {
  const { workspace, tool } = await setup(t);
  const lines = Array.from(
    { length: 400 },
    (_, i) => `第${i + 1}行：${"内容".repeat(30)}`,
  );

  const source = lines.join("\r\n") + "\r\n";
  assert.ok(Buffer.byteLength(source) > 32768);
  await writeFile(path.join(workspace, "file.txt"), source);

  const first = (await read(tool)).details;
  assert.equal(first.totalLines, 400);
  assert.deepEqual(first.lines, [
    { line: 1, text: lines[0] },
    { line: 2, text: lines[1] },
  ]);
  assert.equal(first.nextLine, 3);

  const last = (await read(tool, { startLine: 399 })).details;
  assert.equal(last.nextLine, null);
  assert.deepEqual(
    last.lines.map((line) => line.line),
    [399, 400],
  );
});

test("输出按字节分页，不截断完整行", async (t) => {
  const { workspace, tool } = await setup(t);
  const file = path.join(workspace, "file.txt");
  const line = "中".repeat(3000);

  await writeFile(file, [line, line, line].join("\n"));

  const result = (
    await read(tool, { lineCount: 200 })
  ).details;

  assert.deepEqual(result.lines, [{ line: 1, text: line }]);
  assert.equal(result.nextLine, 2);

  await writeFile(file, "中".repeat(6000));
  await assert.rejects(read(tool), /该行超过 16 KiB/);
});

test("支持空文件和混合换行，拒绝越界行号", async (t) => {
  const { workspace, tool } = await setup(t);
  const file = path.join(workspace, "file.txt");

  await writeFile(file, "");
  assert.deepEqual((await read(tool)).details, {
    path: "file.txt",
    totalLines: 0,
    lines: [],
    nextLine: null,
  });

  await writeFile(file, "甲\r\n乙\r丙\n\n");
  const result = (
    await read(tool, { lineCount: 200 })
  ).details;

  assert.deepEqual(
    result.lines.map((line) => line.text),
    ["甲", "乙", "丙", ""],
  );

  await assert.rejects(
    read(tool, { startLine: 5 }),
    /超过文件范围/,
  );
});

test("沿用隐藏路径、会话目录和目录外访问限制", async (t) => {
  const { base, workspace, tool } = await setup(t);

  await writeFile(path.join(workspace, ".env"), "测试数据");
  await mkdir(path.join(workspace, "sessions"));
  await writeFile(
    path.join(workspace, "sessions", "test.txt"),
    "测试数据",
  );

  const outside = path.join(base, "outside.txt");
  await writeFile(outside, "测试数据");
  await symlink(outside, path.join(workspace, "link.txt"));

  for (const filename of [
    ".env",
    "sessions/test.txt",
    "../outside.txt",
    "link.txt",
  ]) {
    await assert.rejects(
      read(tool, { path: filename }),
      /不对 Agent 开放|工作目录之外/,
    );
  }
});

test("拒绝超限文件、目录、二进制和无效 UTF-8", async (t) => {
  const { workspace, tool } = await setup(t);
  const file = path.join(workspace, "file.txt");

  await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 65));
  await assert.rejects(read(tool), /超过 1 MiB/);

  await assert.rejects(
    read(tool, { path: "." }),
    /普通文件/,
  );

  for (const data of [
    Buffer.from([65, 0]),
    Buffer.from([255]),
  ]) {
    await writeFile(file, data);
    await assert.rejects(read(tool), /UTF-8/);
  }
});

test("检查行参数，并响应取消", async (t) => {
  const { workspace, tool } = await setup(t);
  await writeFile(path.join(workspace, "file.txt"), "测试");

  for (const extra of [
    { startLine: 0 },
    { startLine: 1.5 },
    { lineCount: 0 },
    { lineCount: 201 },
  ]) {
    await assert.rejects(read(tool, extra), /必须是/);
  }

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    read(tool, {}, controller.signal),
    { name: "AbortError" },
  );
});

test("工具已注册且名称无重复", async (t) => {
  const { workspace } = await setup(t);
  const { createAgentTools } = await import(
    "../../src/main/tools/index.mjs"
  );

  const names = createAgentTools(workspace).map(
    (tool) => tool.name,
  );

  assert.ok(names.includes("read_workspace_lines"));
  assert.equal(new Set(names).size, names.length);
});
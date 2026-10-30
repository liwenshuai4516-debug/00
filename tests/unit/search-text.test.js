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
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-search-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const workspace = path.join(base, "workspace");
  await mkdir(workspace);

  const { createSearchTextTool } = await import(
    "../../src/main/tools/search-text.mjs"
  );

  return { base, workspace, tool: createSearchTextTool(workspace) };
}

test("递归搜索并返回准确行号", async (t) => {
  const { workspace, tool } = await setup(t);
  await mkdir(path.join(workspace, "src"));
  await writeFile(
    path.join(workspace, "src", "main.js"),
    "// 第一行\nconst sessionService = {};\n",
  );

  const result = await tool.execute("test", {
    path: ".",
    query: "sessionService",
  });

  assert.deepEqual(result.details.matches, [
    {
      path: path.join("src", "main.js"),
      line: 2,
      preview: "const sessionService = {};",
    },
  ]);
});

test("不搜索隐藏文件、依赖目录、会话目录和符号链接", async (t) => {
  const { base, workspace, tool } = await setup(t);
  await writeFile(path.join(workspace, ".env"), "needle");

  for (const name of ["node_modules", "sessions"]) {
    await mkdir(path.join(workspace, name));
    await writeFile(path.join(workspace, name, "test.txt"), "needle");
  }

  const outside = path.join(base, "outside.txt");
  await writeFile(outside, "needle");
  await symlink(outside, path.join(workspace, "external.txt"));

  const result = await tool.execute("test", {
    path: ".",
    query: "needle",
  });

  assert.deepEqual(result.details.matches, []);
  assert.equal(result.details.searchedFiles, 0);
});

test("拒绝从工作目录之外开始搜索", async (t) => {
  const { tool } = await setup(t);

  await assert.rejects(
    tool.execute("test", { path: "..", query: "needle" }),
    /工作目录之外/,
  );
});

test("将搜索词作为原始字符串，不作为正则表达式", async (t) => {
  const { workspace, tool } = await setup(t);
  await writeFile(path.join(workspace, "example.txt"), "a.b\naxb");

  const result = await tool.execute("test", {
    path: ".",
    query: "a.b",
  });

  assert.equal(result.details.matches.length, 1);
  assert.equal(result.details.matches[0].line, 1);
});

test("大文件被跳过，并在结果中说明", async (t) => {
  const { workspace, tool } = await setup(t);

  await writeFile(
    path.join(workspace, "large.txt"),
    "x".repeat(1024 * 1024 + 1),
  );

  const result = await tool.execute("test", {
    path: ".",
    query: "x",
  });

  assert.deepEqual(result.details.matches, []);
  assert.equal(result.details.skippedCount, 1);
  assert.match(result.details.skipped[0].reason, /超过 1 MiB/);
});


test("达到匹配上限时标记结果可能不完整", async (t) => {
  const { workspace, tool } = await setup(t);
  await writeFile(
    path.join(workspace, "many.txt"),
    Array(31).fill("needle").join("\n"),
  );

  const result = await tool.execute("test", {
    path: ".",
    query: "needle",
  });

  assert.equal(result.details.matches.length, 30);
  assert.equal(result.details.truncated, true);
});

test("搜索大于 32 KiB 的文件并返回准确行号", async (t) => {
  const { workspace, tool } = await setup(t);

  // 关键词放在较大文件的末尾，验证没有提前截断读取。
  const lines = Array(500).fill("普通内容".repeat(10));
  lines.push("const targetValue = 42;");

  const source = lines.join("\r\n");
  assert.ok(Buffer.byteLength(source) > 32 * 1024);

  await writeFile(path.join(workspace, "large.js"), source);

  const { details } = await tool.execute("test", {
    path: ".",
    query: "targetValue",
  });

  assert.deepEqual(details.matches, [{
    path: "large.js",
    line: 501,
    preview: "const targetValue = 42;",
  }]);

  assert.equal(details.searchedFiles, 1);
  assert.equal(details.skippedCount, 0);
});

test("恰好 1 MiB 的文件仍可搜索，超长行只返回片段", async (t) => {
  const { workspace, tool } = await setup(t);

  await writeFile(
    path.join(workspace, "boundary.txt"),
    "needle" + "x".repeat(1024 * 1024 - 6),
  );

  const { details } = await tool.execute("test", {
    path: ".",
    query: "needle",
  });

  assert.equal(details.matches.length, 1);
  assert.equal(details.matches[0].line, 1);
  assert.equal(details.matches[0].preview.length, 240);
  assert.equal(details.skippedCount, 0);
});

test("跳过二进制和无效 UTF-8，并继续搜索正常文件", async (t) => {
  const { workspace, tool } = await setup(t);

  await writeFile(path.join(workspace, "a.bin"), Buffer.from([65, 0]));
  await writeFile(path.join(workspace, "b.bin"), Buffer.from([255]));
  await writeFile(path.join(workspace, "c.txt"), "needle");

  const { details } = await tool.execute("test", {
    path: ".",
    query: "needle",
  });

  assert.equal(details.matches[0].path, "c.txt");
  assert.equal(details.searchedFiles, 1);
  assert.equal(details.skippedCount, 2);

  assert.ok(
    details.skipped.every((item) => /UTF-8/.test(item.reason)),
  );
});

test("搜索收到取消信号时向上传播，不当作跳过文件", async (t) => {
  const { tool } = await setup(t);

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    tool.execute(
      "test",
      { path: ".", query: "needle" },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});
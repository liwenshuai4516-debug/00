const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp,
  writeFile,
  readFile,
  rm,
} = require("node:fs/promises");

async function setup(t, source = 'const title = "旧标题";\n') {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-proposal-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const filename = path.join(workspace, "example.js");
  await writeFile(filename, source);

  const { createProposeEditTool } = await import(
    "../../src/main/tools/propose-edit.mjs"
  );

  return { workspace, filename, tool: createProposeEditTool(workspace) };
}

test("生成草稿，但保持文件原文不变", async (t) => {
  const { filename, tool } = await setup(t);
  const original = await readFile(filename, "utf8");

  const result = await tool.execute("test", {
    path: "example.js",
    oldText: "旧标题",
    newText: "新标题",
  });

  assert.equal(result.details.kind, "edit-proposal");
  assert.equal(result.details.written, false);
  assert.equal(result.details.oldText, "旧标题");
  assert.equal(result.details.newText, "新标题");
  assert.match(result.details.baseTextHash, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(filename, "utf8"), original);
});

test("找不到原文时拒绝生成草稿", async (t) => {
  const { tool } = await setup(t);

  await assert.rejects(
    tool.execute("test", {
      path: "example.js",
      oldText: "不存在的原文",
      newText: "新内容",
    }),
    /找不到原文/,
  );
});

test("原文重复或重叠出现时拒绝替换", async (t) => {
  const { tool } = await setup(t, "aaa");

  await assert.rejects(
    tool.execute("test", {
      path: "example.js",
      oldText: "aa",
      newText: "b",
    }),
    /出现多次/,
  );
});

test("拒绝空原文和没有变化的草稿", async (t) => {
  const { tool } = await setup(t);

  await assert.rejects(
    tool.execute("test", {
      path: "example.js",
      oldText: "",
      newText: "新内容",
    }),
    /原文不能为空/,
  );

  await assert.rejects(
    tool.execute("test", {
      path: "example.js",
      oldText: "旧标题",
      newText: "旧标题",
    }),
    /内容相同/,
  );
});

test("不能为隐藏文件生成草稿", async (t) => {
  const { workspace, tool } = await setup(t);
  await writeFile(path.join(workspace, ".env"), "test=value");

  await assert.rejects(
    tool.execute("test", {
      path: ".env",
      oldText: "value",
      newText: "changed",
    }),
    /不对 Agent 开放/,
  );
});

test("拒绝修改后超过大小限制的草稿", async (t) => {
  const { tool } = await setup(t, "X" + "a".repeat(32767));

  await assert.rejects(
    tool.execute("test", {
      path: "example.js",
      oldText: "X",
      newText: "XYZ",
    }),
    /修改后的文本超过/,
  );
});
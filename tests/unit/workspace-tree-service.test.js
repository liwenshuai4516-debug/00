const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, symlink, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createWorkspaceTreeReader, MAX_TREE_ENTRIES } = require("../../src/main/services/workspace-tree-service.js");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tree-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "tree-outside-"));
  await mkdir(path.join(root, "docs"));
  await mkdir(path.join(root, "docs", "cases"));
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".pi"));
  await writeFile(path.join(root, "docs", "需求.md"), "# 需求\n");
  await writeFile(path.join(root, "docs", "cases", "a.md"), "a");
  await writeFile(path.join(root, "README.md"), "readme");
  await writeFile(path.join(root, ".env"), "SECRET=1");
  await writeFile(path.join(root, "node_modules", "x.js"), "x");
  await writeFile(path.join(outside, "outside.md"), "outside");
  await symlink(path.join(outside, "outside.md"), path.join(root, "link.md"));
  return { root, outside };
}

test("文件树只列一层，目录在前并跳过工程目录与凭据", async () => {
  const { root, outside } = await fixture();
  try {
    const list = createWorkspaceTreeReader(async () => root);
    const result = await list("");
    assert.equal(result.path, "");
    assert.equal(result.truncated, false);
    assert.deepEqual(result.entries.map((entry) => [entry.name, entry.type]), [
      [".pi", "dir"],
      ["docs", "dir"],
      ["README.md", "file"],
    ]);

    const docs = await list("docs");
    assert.deepEqual(docs.entries.map((entry) => entry.path), ["docs/cases", "docs/需求.md"]);
    assert.equal(docs.entries[1].size, Buffer.byteLength("# 需求\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("文件树拒绝越界、文件与不可读路径", async () => {
  const { root, outside } = await fixture();
  try {
    const list = createWorkspaceTreeReader(async () => root);
    await assert.rejects(() => list("../"), /只能浏览当前工作目录/);
    await assert.rejects(() => list(path.join(outside, "outside.md")), /只能浏览当前工作目录/);
    await assert.rejects(() => list("README.md"), /只能浏览目录/);
    await assert.rejects(() => list("missing"), /目录不存在或不可读/);
    await assert.rejects(() => list("x".repeat(1025)), /路径过长/);
    assert.equal(await list(42).then((result) => result.path), "");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("目录项超过上限时标记截断", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tree-many-"));
  try {
    await Promise.all(
      Array.from({ length: MAX_TREE_ENTRIES + 3 }, (_, index) =>
        writeFile(path.join(root, `f${String(index).padStart(3, "0")}.txt`), "")),
    );
    const list = createWorkspaceTreeReader(async () => root);
    const result = await list("");
    assert.equal(result.entries.length, MAX_TREE_ENTRIES);
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("没有工作目录时不列目录", async () => {
  const list = createWorkspaceTreeReader(async () => undefined);
  await assert.rejects(() => list(""), /当前会话还没有工作目录/);
});

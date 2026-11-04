const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, symlink, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createWorkspaceSearch, MAX_SEARCH_RESULTS } = require("../../src/main/services/workspace-search-service.js");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "search-outside-"));
  await mkdir(path.join(root, "docs"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "a.md"), "# a");
  await writeFile(path.join(root, "app.test.js"), "test");
  await writeFile(path.join(root, "docs", "b.md"), "b");
  await writeFile(path.join(root, "docs", "c.txt"), "c");
  await writeFile(path.join(root, "src", "app.js"), "app");
  await writeFile(path.join(root, ".env"), "SECRET=1");
  await writeFile(path.join(root, "node_modules", "x.js"), "x");
  await writeFile(path.join(root, ".git", "y"), "y");
  await writeFile(path.join(outside, "outside.md"), "outside");
  await symlink(path.join(outside, "outside.md"), path.join(root, "link.md"));
  return { root, outside };
}

test("文件引用搜索跳过工程目录、凭据与符号链接", async () => {
  const { root, outside } = await fixture();
  try {
    const search = createWorkspaceSearch(async () => root);
    const result = await search("");
    // 空查询按相对路径长度排序，目录与文件一起返回。
    assert.deepEqual(result.items.map((item) => item.path), [
      "src",
      "a.md",
      "docs",
      "docs/b.md",
      "docs/c.txt",
      "src/app.js",
      "app.test.js",
    ]);
    assert.deepEqual(
      result.items.filter((item) => item.type === "dir").map((item) => item.path),
      ["src", "docs"],
    );
    assert.equal(result.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("查询按路径过滤，名称匹配优先", async () => {
  const { root, outside } = await fixture();
  try {
    const search = createWorkspaceSearch(async () => root);
    const app = await search("app");
    assert.deepEqual(app.items.map((item) => item.path), ["src/app.js", "app.test.js"]);
    const docs = await search("docs");
    assert.deepEqual(docs.items.map((item) => item.path), ["docs", "docs/b.md", "docs/c.txt"]);
    assert.equal(docs.items[0].type, "dir");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("结果数量受限并标记截断", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-many-"));
  try {
    await Promise.all(
      Array.from({ length: MAX_SEARCH_RESULTS + 5 }, (_, index) =>
        writeFile(path.join(root, `f${String(index).padStart(3, "0")}.md`), "")),
    );
    const search = createWorkspaceSearch(async () => root);
    const result = await search("");
    assert.equal(result.items.length, MAX_SEARCH_RESULTS);
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("没有工作目录或搜索词过长时拒绝", async () => {
  const missing = createWorkspaceSearch(async () => undefined);
  await assert.rejects(() => missing("a"), /当前会话还没有工作目录/);
  const search = createWorkspaceSearch(async () => os.tmpdir());
  await assert.rejects(() => search("x".repeat(121)), /搜索词过长/);
});

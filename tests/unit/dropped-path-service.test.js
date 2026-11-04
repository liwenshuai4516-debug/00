const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, realpath, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createDroppedPathResolver, MAX_DROPPED_FILES } = require("../../src/main/services/dropped-path-service.js");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "drop-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "drop-outside-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "a.md"), "# a");
  await writeFile(path.join(root, "b.js"), "b");
  await writeFile(path.join(outside, "c.txt"), "c");
  return { root, outside };
}

test("拖入文件：工作目录内用相对路径，目录外保留绝对路径", async () => {
  const { root, outside } = await fixture();
  try {
    const describe = createDroppedPathResolver(async () => root);
    const items = await describe([path.join(root, "docs", "a.md"), path.join(root, "b.js"), path.join(outside, "c.txt")]);
    // 服务返回 realpath 后的大小写/符号链接真实路径。
    assert.deepEqual(items.map((item) => item.path), ["docs/a.md", "b.js", await realpath(path.join(outside, "c.txt"))]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("拖入文件跳过目录与缺失项，并拒绝非法输入", async () => {
  const { root, outside } = await fixture();
  try {
    const describe = createDroppedPathResolver(async () => root);
    const items = await describe([path.join(root, "docs"), path.join(root, "missing.md"), 42, ""]);
    assert.deepEqual(items, []);
    await assert.rejects(() => describe("not-array"), /拖入内容无效/);
    await assert.rejects(() => describe(Array.from({ length: MAX_DROPPED_FILES + 1 }, () => path.join(root, "b.js"))), /一次最多引用/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("没有工作目录时全部保留绝对路径", async () => {
  const { root, outside } = await fixture();
  try {
    const describe = createDroppedPathResolver(async () => undefined);
    const items = await describe([path.join(root, "b.js"), path.join(outside, "c.txt")]);
    assert.deepEqual(items.map((item) => item.path), [await realpath(path.join(root, "b.js")), await realpath(path.join(outside, "c.txt"))]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

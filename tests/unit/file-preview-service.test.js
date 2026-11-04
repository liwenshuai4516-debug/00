const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, symlink, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createFilePreviewReader, MAX_PREVIEW_BYTES } = require("../../src/main/services/file-preview-service.js");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "preview-outside-"));
  await writeFile(path.join(root, "文档.md"), "# 标题\n");
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "a b.txt"), "hello");
  await writeFile(path.join(root, "big.txt"), "a".repeat(MAX_PREVIEW_BYTES + 1));
  await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, ".env"), "SECRET=1");
  await writeFile(path.join(outside, "outside.md"), "outside");
  await symlink(path.join(outside, "outside.md"), path.join(root, "link.md"));
  await symlink(path.join(root, "文档.md"), path.join(root, "inside-link.md"));
  return { root, outside };
}

test("预览读取工作目录内的文本文件并解码路径", async () => {
  const { root, outside } = await fixture();
  try {
    const read = createFilePreviewReader(async () => root);
    const file = await read("文档.md");
    assert.equal(file.path, "文档.md");
    assert.equal(file.content, "# 标题\n");
    assert.equal(file.size, Buffer.byteLength("# 标题\n"));

    // 百分号编码与行号锚点只影响定位，不改变读取目标。
    const spaced = await read("docs/a%20b.txt#L3");
    assert.equal(spaced.path, "docs/a b.txt");
    assert.equal(spaced.content, "hello");

    // 指向工作目录内的符号链接按真实路径返回。
    const linked = await read("inside-link.md");
    assert.equal(linked.path, "文档.md");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("预览拒绝越界路径、凭据文件与符号链接逃逸", async () => {
  const { root, outside } = await fixture();
  try {
    const read = createFilePreviewReader(async () => root);
    await assert.rejects(() => read("../outside.md"), /只能预览当前工作目录内的文件/);
    await assert.rejects(() => read(path.join(outside, "outside.md")), /只能预览当前工作目录内的文件/);
    await assert.rejects(() => read("link.md"), /只能预览当前工作目录内的文件/);
    await assert.rejects(() => read(".env"), /不提供预览/);
    await assert.rejects(() => read(""), /缺少文件路径/);
    await assert.rejects(() => read(42), /缺少文件路径/);
    await assert.rejects(() => read("missing.md"), /文件不存在或不可读/);
    await assert.rejects(() => read("docs"), /只能预览普通文件/);
    await assert.rejects(() => read("bin.dat"), /二进制文件/);
    await assert.rejects(() => read("big.txt"), /512 KiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("没有工作目录时拒绝预览", async () => {
  const read = createFilePreviewReader(async () => undefined);
  await assert.rejects(() => read("a.md"), /当前会话还没有工作目录/);
});

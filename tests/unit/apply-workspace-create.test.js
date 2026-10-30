const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, open, rm,
} = require("node:fs/promises");

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-create-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = path.join(root, "workspace");
  await mkdir(workspace);

  const { applyWorkspaceCreate } = await import(
    "../../src/main/workspace/apply-workspace-create.mjs"
  );

  const proposal = {
    kind: "create-proposal",
    path: "hello.txt",
    content: "你好\r\n",
    written: false,
  };

  return { root, workspace, proposal, applyWorkspaceCreate };
}

test("保存完整 UTF-8 内容，使用私有权限且不遗留临时文件", async (t) => {
  const { workspace, proposal, applyWorkspaceCreate } = await setup(t);
  const filename = path.join(workspace, proposal.path);

  assert.deepEqual(await applyWorkspaceCreate(workspace, proposal), {
    path: proposal.path,
    written: true,
  });
  assert.deepEqual(await readFile(filename), Buffer.from(proposal.content));
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(workspace), [proposal.path]);
});

test("允许空文件及恰好 32 KiB 的内容", async (t) => {
  const { workspace, proposal, applyWorkspaceCreate } = await setup(t);

  for (const [name, content] of [
    ["empty.txt", ""],
    ["max.txt", "a".repeat(32768)],
  ]) {
    await applyWorkspaceCreate(workspace, { ...proposal, path: name, content });
    assert.equal(await readFile(path.join(workspace, name), "utf8"), content);
  }

  assert.deepEqual((await readdir(workspace)).sort(), ["empty.txt", "max.txt"]);
});

test("拒绝已占用的文件、目录和失效链接，不覆盖现有内容", async (t) => {
  const { workspace, proposal, applyWorkspaceCreate } = await setup(t);

  await writeFile(path.join(workspace, "existing.txt"), "原文");
  await mkdir(path.join(workspace, "occupied"));
  await symlink("missing.txt", path.join(workspace, "dangling.txt"));

  for (const name of ["existing.txt", "occupied", "dangling.txt"]) {
    await assert.rejects(
      applyWorkspaceCreate(workspace, { ...proposal, path: name }),
      /已经存在/,
    );
  }

  assert.equal(await readFile(path.join(workspace, "existing.txt"), "utf8"), "原文");
  assert.deepEqual((await readdir(workspace)).sort(), [
    "dangling.txt", "existing.txt", "occupied",
  ]);
});

test("拒绝无效类型、已保存状态、非文本、空字节和 UTF-8 字节超限", async (t) => {
  const { workspace, proposal, applyWorkspaceCreate } = await setup(t);

  for (const fields of [
    { kind: "edit-proposal" },
    { written: true },
    { content: null },
    { content: "a\0b" },
    { content: "中".repeat(10923) },
  ]) {
    await assert.rejects(
      applyWorkspaceCreate(workspace, { ...proposal, ...fields }),
      /无效的新建草稿/,
    );
  }

  assert.deepEqual(await readdir(workspace), []);
});

test("保存时重新拒绝隐藏、目录外、缺失父目录及指向外部的链接", async (t) => {
  const { root, workspace, proposal, applyWorkspaceCreate } = await setup(t);
  const outside = path.join(root, "outside");

  await mkdir(outside);
  await symlink(outside, path.join(workspace, "external"));

  for (const [name, expected] of [
    [".env", /不对 Agent 开放/],
    ["../outside.txt", /工作目录之外/],
    ["missing/hello.txt", /ENOENT/],
    ["external/hello.txt", /工作目录之外/],
  ]) {
    await assert.rejects(
      applyWorkspaceCreate(workspace, { ...proposal, path: name }),
      expected,
    );
  }

  assert.deepEqual(await readdir(workspace), ["external"]);
  assert.deepEqual(await readdir(outside), []);
});

test("临时文件同步失败时不发布目标，并清理临时文件", async (t) => {
  const { workspace, proposal, applyWorkspaceCreate } = await setup(t);

  // 从真实句柄取得原型，仅模拟 sync 失败，不依赖磁盘满等偶发条件。
  const probePath = path.join(workspace, "probe.tmp");
  const probe = await open(probePath, "wx");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(probePath);

  t.mock.method(prototype, "sync", async () => {
    throw new Error("模拟同步失败");
  });

  await assert.rejects(
    applyWorkspaceCreate(workspace, proposal),
    /模拟同步失败/,
  );
  assert.deepEqual(await readdir(workspace), []);
});

test("并发创建同一个目标时只有一份成功，完整保留胜出内容", async (t) => {
  const { workspace, proposal, applyWorkspaceCreate } = await setup(t);
  const contents = ["第一份完整内容", "第二份完整内容"];

  const results = await Promise.allSettled(contents.map((content) =>
    applyWorkspaceCreate(workspace, { ...proposal, content }),
  ));

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const winner = results.findIndex((result) => result.status === "fulfilled");

  assert.equal(
    await readFile(path.join(workspace, proposal.path), "utf8"),
    contents[winner],
  );
  assert.deepEqual(await readdir(workspace), [proposal.path]);
});
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

const {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  symlink,
  rm,
} = require("node:fs/promises");

async function setup(t) {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "agent-new-path-"),
  );

  t.after(() => rm(base, {
    recursive: true,
    force: true,
  }));

  const folder = path.join(base, "workspace");
  await mkdir(folder);

  // macOS 临时路径可能包含别名，断言使用真实目录。
  const workspace = await realpath(folder);

  const { resolveNewFilePath } = await import(
    "../../src/main/workspace/resolve-new-file-path.mjs"
  );

  return { base, workspace, resolveNewFilePath };
}

test("解析根目录与子目录的新文件，不创建实际文件", async (t) => {
  const { workspace, resolveNewFilePath } = await setup(t);
  await mkdir(path.join(workspace, "src"));

  for (const relativePath of ["说明.txt", "src/example.js"]) {
    assert.deepEqual(
      await resolveNewFilePath(workspace, relativePath),
      {
        target: path.join(workspace, relativePath),
        relativePath,
      },
    );
  }

  assert.deepEqual(await readdir(workspace), ["src"]);
  assert.deepEqual(
    await readdir(path.join(workspace, "src")),
    [],
  );
});

test("拒绝已有文件、目录和失效符号链接，原文件不变", async (t) => {
  const { workspace, resolveNewFilePath } = await setup(t);

  const existing = path.join(workspace, "existing.txt");
  await writeFile(existing, "原文");
  await mkdir(path.join(workspace, "existing-dir"));

  // 链接本身已经占用路径，即使它指向不存在的文件。
  await symlink(
    "missing-target.txt",
    path.join(workspace, "broken.txt"),
  );

  for (const name of [
    "existing.txt",
    "existing-dir",
    "broken.txt",
  ]) {
    await assert.rejects(
      resolveNewFilePath(workspace, name),
      /已经存在/,
    );
  }

  assert.equal(await readFile(existing, "utf8"), "原文");
});

test("拒绝绝对路径和目录外路径", async (t) => {
  const { base, workspace, resolveNewFilePath } = await setup(t);

  await assert.rejects(
    resolveNewFilePath(
      workspace,
      path.join(base, "outside.txt"),
    ),
    /相对于工作目录/,
  );

  await assert.rejects(
    resolveNewFilePath(workspace, "../outside.txt"),
    /工作目录之外/,
  );
});

test("拒绝隐藏名称与排除目录", async (t) => {
  const { workspace, resolveNewFilePath } = await setup(t);

  for (const name of [
    ".env",
    "node_modules",
    "sessions",
    ".private/new.txt",
    "node_modules/new.txt",
    "sessions/new.txt",
  ]) {
    await assert.rejects(
      resolveNewFilePath(workspace, name),
      /不对 Agent 开放/,
    );
  }
});

test("父目录链接指向目录外时拒绝，目录内别名返回真实相对路径", async (t) => {
  const { base, workspace, resolveNewFilePath } = await setup(t);

  const outside = path.join(base, "outside");
  await mkdir(outside);
  await mkdir(path.join(workspace, "src"));

  await symlink(outside, path.join(workspace, "external"));
  await symlink("src", path.join(workspace, "alias"));

  await assert.rejects(
    resolveNewFilePath(workspace, "external/new.txt"),
    /工作目录之外/,
  );

  assert.deepEqual(
    await resolveNewFilePath(workspace, "alias/new.txt"),
    {
      target: path.join(workspace, "src/new.txt"),
      relativePath: "src/new.txt",
    },
  );
});

test("父目录必须存在且确实是目录", async (t) => {
  const { workspace, resolveNewFilePath } = await setup(t);

  await assert.rejects(
    resolveNewFilePath(workspace, "missing/new.txt"),
    { code: "ENOENT" },
  );

  await writeFile(
    path.join(workspace, "parent.txt"),
    "普通文件",
  );

  await assert.rejects(
    resolveNewFilePath(workspace, "parent.txt/new.txt"),
    /父路径必须是已有目录/,
  );

  // 校验过程不能偷偷创建 missing 目录。
  assert.deepEqual(await readdir(workspace), ["parent.txt"]);
});

test("拒绝空路径、目录占位和缺少文件名的路径", async (t) => {
  const { workspace, resolveNewFilePath } = await setup(t);

  for (const value of ["", "  ", null, undefined]) {
    await assert.rejects(
      resolveNewFilePath(workspace, value),
      /请提供新文件的相对路径/,
    );
  }

  for (const value of [".", "..", "folder/"]) {
    await assert.rejects(
      resolveNewFilePath(workspace, value),
      /具体的新文件名/,
    );
  }
});
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp,
  mkdir,
  realpath,
  symlink,
  writeFile,
  readFile,
  readdir,
  rm,
} = require("node:fs/promises");
const {
  createWorkspaceSettings,
} = require("../../src/main/storage/workspace-settings.js");

async function setup(t) {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "agent-workspace-settings-"),
  );

  t.after(() => rm(base, { recursive: true, force: true }));

  const first = path.join(base, "first");
  const second = path.join(base, "second");
  await mkdir(first);
  await mkdir(second);

  const settingsPath = path.join(base, "config", "workspace.json");
  return { base, first, second, settingsPath };
}

test("没有保存记录时读取默认目录，不主动写入配置", async (t) => {
  const { first, settingsPath } = await setup(t);
  const settings = createWorkspaceSettings(settingsPath, first);

  assert.equal(await settings.load(), await realpath(first));
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
});

test("保存真实目录，重新创建服务后优先恢复选择", async (t) => {
  const { base, first, second, settingsPath } = await setup(t);
  const alias = path.join(base, "alias");
  await symlink(second, alias);

  const expected = await realpath(second);
  const settings = createWorkspaceSettings(settingsPath, first);

  assert.equal(await settings.save(alias), expected);

  // 新实例模拟重启；默认目录仍是 first，应优先读取已选的 second。
  const reopened = createWorkspaceSettings(settingsPath, first);
  assert.equal(await reopened.load(), expected);

  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, "utf8")),
    { workspaceDir: expected },
  );
});

test("拒绝无效目录，已有配置内容保持不变", async (t) => {
  const { base, first, settingsPath } = await setup(t);
  const settings = createWorkspaceSettings(settingsPath, first);

  await settings.save(first);
  const before = await readFile(settingsPath, "utf8");

  const file = path.join(base, "file.txt");
  await writeFile(file, "test");

  const invalidValues = [
    undefined,
    "relative/path",
    file,
    path.join(base, "missing"),
  ];

  for (const value of invalidValues) {
    await assert.rejects(settings.save(value));
    assert.equal(await readFile(settingsPath, "utf8"), before);
  }
});

test("损坏或失效的保存记录明确报错，不静默使用默认目录", async (t) => {
  const { base, first, settingsPath } = await setup(t);
  await mkdir(path.dirname(settingsPath));

  const settings = createWorkspaceSettings(settingsPath, first);
  const invalidRecords = [
    "{broken",
    "null",
    JSON.stringify({ workspaceDir: path.join(base, "missing") }),
  ];

  for (const text of invalidRecords) {
    await writeFile(settingsPath, text);
    await assert.rejects(settings.load());
    assert.equal(await readFile(settingsPath, "utf8"), text);
  }
});

test("配置发布失败会清理临时文件，不报告保存成功", async (t) => {
  const { first, settingsPath } = await setup(t);

  // 用目录占用配置文件名，使最后的替换确定失败。
  await mkdir(settingsPath, { recursive: true });

  const settings = createWorkspaceSettings(settingsPath, first);
  await assert.rejects(settings.save(first));

  assert.deepEqual(
    await readdir(path.dirname(settingsPath)),
    ["workspace.json"],
  );
});
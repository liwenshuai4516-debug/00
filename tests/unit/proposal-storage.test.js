const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  stat,
  rm,
} = require("node:fs/promises");
const {
  createProposalStorage,
} = require("../../src/main/storage/proposal-storage.js");

async function setup(t) {
  // 所有测试只操作临时目录。
  const base = await mkdtemp(
    path.join(os.tmpdir(), "agent-proposal-storage-"),
  );

  t.after(() => rm(base, { recursive: true, force: true }));

  const directory = path.join(base, "proposals");

  return {
    directory,
    storage: createProposalStorage(directory),
  };
}

function makeProposal(sessionId = "session-a") {
  return {
    id: "proposal-1",
    sessionId,
    kind: "edit-proposal",
    path: "example.js",
    oldText: "旧标题",
    newText: "新标题",
    baseTextHash: "a".repeat(64),
    written: false,
  };
}

test("没有快照时返回空列表", async (t) => {
  const { storage } = await setup(t);

  assert.deepEqual(storage.load("session-a"), []);
});

test("新存储实例能恢复草稿，并读取更新后的保存状态", async (t) => {
  const { directory, storage } = await setup(t);
  const proposal = makeProposal();

  storage.save("session-a", [proposal]);
  storage.save("session-b", [makeProposal("session-b")]);

  // 新实例没有旧实例的内存，只能从磁盘恢复。
  const restored = createProposalStorage(directory);

  assert.deepEqual(restored.load("session-a"), [proposal]);
  assert.equal(
    restored.load("session-b")[0].sessionId,
    "session-b",
  );

  const saved = { ...proposal, written: true };
  restored.save("session-a", [saved]);

  assert.deepEqual(
    createProposalStorage(directory).load("session-a"),
    [saved],
  );

  assert.deepEqual((await readdir(directory)).sort(), [
    "session-a.json",
    "session-b.json",
  ]);

  // 草稿可能包含代码片段，不向其他用户开放文件权限。
  const info = await stat(path.join(directory, "session-a.json"));
  assert.equal(info.mode & 0o077, 0);
});

test("损坏、未知版本和其他会话记录不能被静默恢复", async (t) => {
  const { directory, storage } = await setup(t);
  await mkdir(directory);

  const filename = path.join(directory, "session-a.json");

  await writeFile(filename, "{broken");
  assert.throws(
    () => storage.load("session-a"),
    /草稿记录损坏/,
  );

  for (const data of [
    { version: 2, sessionId: "session-a", proposals: [] },
    { version: 1, sessionId: "session-b", proposals: [] },
    {
      version: 1,
      sessionId: "session-a",
      proposals: [makeProposal("session-b")],
    },
  ]) {
    await writeFile(filename, JSON.stringify(data));

    assert.throws(
      () => storage.load("session-a"),
      /格式错误或会话归属不匹配/,
    );
  }
});

test("拒绝把路径作为会话编号，也拒绝跨会话写入", async (t) => {
  const { storage } = await setup(t);

  for (const id of ["../outside", "/tmp/outside", "", "a/b"]) {
    assert.throws(
      () => storage.load(id),
      /无效的会话编号/,
    );
    assert.throws(
      () => storage.save(id, []),
      /无效的会话编号/,
    );
  }

  assert.throws(
    () => storage.save("session-a", [makeProposal("session-b")]),
    /格式错误或会话归属不匹配/,
  );
});

test("替换快照失败时清理临时文件，并保留原位置内容", async (t) => {
  const { directory, storage } = await setup(t);

  // 用同名目录模拟目标位置异常，触发真实的重命名失败。
  const target = path.join(directory, "session-a.json");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "marker.txt"), "保留内容");

  assert.throws(() =>
    storage.save("session-a", [makeProposal()]),
  );

  assert.equal(
    await readFile(path.join(target, "marker.txt"), "utf8"),
    "保留内容",
  );

  // 失败后不应遗留本次写入的临时文件。
  assert.deepEqual(await readdir(directory), ["session-a.json"]);
});
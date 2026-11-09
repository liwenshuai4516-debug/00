const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const directory = path.join(root, "state");
  // 存储层只保留绑定，不要求工作目录当前仍存在。
  const workspaceDir = path.join(root, "workspace");

  return {
    root,
    directory,
    workspaceDir,
    store: createSessionStateStore(directory),
  };
}

test("首次读取返回 null，不创建状态目录", async (t) => {
  const { directory, store } = await setup(t);

  assert.equal(await store.load("a"), null);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("看门狗开关与输入并发保存互不覆盖，非法开关不落盘", async t => {
  const { store, workspaceDir } = await setup(t);
  await store.saveDraft("a", workspaceDir, "原输入", 0);
  await Promise.all([
    store.update("a", workspaceDir, state => ({ ...state, watchdogEnabled: true })),
    store.saveDraft("a", workspaceDir, "新输入", 1),
  ]);
  const state = await store.load("a");
  assert.equal(state.watchdogEnabled, true);
  assert.equal(state.draft.text, "新输入");
  await assert.rejects(store.update("a", workspaceDir, current => ({ ...current, watchdogEnabled: "true" })), /看门狗开关/);
  assert.deepEqual(await store.load("a"), state);
});

test("保留原文与空输入，重建实例可读取，读取等待已有写入", async (t) => {
  const { directory, workspaceDir, store } = await setup(t);
  const text = " \t中文  \r\n\n末行\r ";

  const saving = store.saveDraft("session.a-1", workspaceDir, text, 0);
  const loaded = await store.load("session.a-1");

  assert.deepEqual(loaded, await saving);
  assert.equal(loaded.draft.text, text);
  assert.equal(loaded.draft.revision, 1);

  const reopened = createSessionStateStore(directory);
  assert.deepEqual(await reopened.load("session.a-1"), loaded);

  await reopened.saveDraft("session.a-1", workspaceDir, "", 1);
  assert.deepEqual(
    (await store.load("session.a-1")).draft,
    { text: "", revision: 2 },
  );

  if (process.platform !== "win32") {
    const info = await fs.stat(path.join(directory, "session.a-1.json"));
    assert.equal(info.mode & 0o777, 0o600);
  }
});

test("不同会话独立保存，绑定不匹配时不覆盖原文件", async (t) => {
  const { root, directory, workspaceDir, store } = await setup(t);
  const anotherWorkspace = path.join(root, "another");

  await Promise.all([
    store.saveDraft("a", workspaceDir, "A 的输入", 0),
    store.saveDraft("b", anotherWorkspace, "B 的输入", 0),
  ]);

  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename, "utf8");

  await assert.rejects(
    store.saveDraft("a", anotherWorkspace, "错误输入", 1),
    /工作目录不匹配/,
  );

  assert.equal(await fs.readFile(filename, "utf8"), before);
  assert.equal((await store.load("a")).draft.text, "A 的输入");
  assert.equal((await store.load("b")).draft.text, "B 的输入");
});

test("输入、置顶和归档同时更新时互不覆盖", async (t) => {
  const { workspaceDir, store } = await setup(t);

  await Promise.all([
    store.saveDraft("a", workspaceDir, "未发送内容", 0),
    store.update("a", workspaceDir, (state) => ({
      ...state,
      pinnedAt: 100,
    })),
    store.update("a", workspaceDir, (state) => ({
      ...state,
      archivedAt: 200,
    })),
  ]);

  const state = await store.load("a");
  assert.deepEqual(state.draft, { text: "未发送内容", revision: 1 });
  assert.equal(state.pinnedAt, 100);
  assert.equal(state.archivedAt, 200);

  await store.update("a", workspaceDir, (current) => ({
    ...current,
    archivedAt: null,
  }));

  const restored = await store.load("a");
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.pinnedAt, 100);
  assert.equal(restored.draft.text, "未发送内容");
});

test("并发旧版本只接受一次，清空后拒绝旧输入重新写回", async (t) => {
  const { workspaceDir, store } = await setup(t);

  const results = await Promise.allSettled([
    store.saveDraft("a", workspaceDir, "第一版", 0),
    store.saveDraft("a", workspaceDir, "迟到旧输入", 0),
  ]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /版本已变化/);

  await store.saveDraft("a", workspaceDir, "", 1);

  await assert.rejects(
    store.saveDraft("a", workspaceDir, "旧原文", 1),
    /版本已变化/,
  );
  assert.deepEqual(
    (await store.load("a")).draft,
    { text: "", revision: 2 },
  );
});

test("无效编号、路径、草稿与跨会话更新均拒绝", async (t) => {
  const { directory, workspaceDir, store } = await setup(t);

  for (const id of [
    undefined, "", "..", "../a", "/tmp/a", "a/b", "a\\b", ".hidden",
  ]) {
    await assert.rejects(store.load(id), /无效的会话编号/);
  }

  await assert.rejects(
    store.saveDraft("a", "relative", "原文", 0),
    /绝对路径/,
  );
  await assert.rejects(
    store.saveDraft("a", workspaceDir, null, 0),
    /草稿或版本无效/,
  );
  await assert.rejects(
    store.saveDraft("a", workspaceDir, "原文", -1),
    /草稿或版本无效/,
  );

  await store.saveDraft("a", workspaceDir, "原文", 0);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename, "utf8");

  await assert.rejects(
    store.update("a", workspaceDir, (state) => ({
      ...state,
      sessionId: "b",
    })),
    /归属不匹配/,
  );
  assert.equal(await fs.readFile(filename, "utf8"), before);
});

test("损坏和字段错误的文件明确报错，不静默覆盖", async (t) => {
  const { directory, workspaceDir, store } = await setup(t);
  const state = await store.saveDraft("a", workspaceDir, "保留内容", 0);
  const filename = path.join(directory, "a.json");

  const damaged = [
    "{broken",
    "null",
    ...[
      { ...state, version: 2 },
      { ...state, sessionId: "b" },
      { ...state, workspaceDir: "relative" },
      { ...state, draft: { text: "内容", revision: -1 } },
      { ...state, pinnedAt: "100" },
    ].map((value) => JSON.stringify(value)),
  ];

  for (const text of damaged) {
    await fs.writeFile(filename, text);

    await assert.rejects(store.load("a"), /记录损坏|记录无效/);
    await assert.rejects(
      store.saveDraft("a", workspaceDir, "不要覆盖", 1),
      /记录损坏|记录无效/,
    );

    assert.equal(await fs.readFile(filename, "utf8"), text);
  }
});

test("替换失败保留旧文件并清理临时文件，后续仍可保存", async (t) => {
  const { directory, workspaceDir, store } = await setup(t);

  await store.saveDraft("a", workspaceDir, "原内容", 0);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename, "utf8");

  const rename = t.mock.method(fs, "rename", async () => {
    throw new Error("模拟替换失败");
  });

  try {
    await assert.rejects(
      store.saveDraft("a", workspaceDir, "未保存内容", 1),
      /模拟替换失败/,
    );
    assert.equal(await fs.readFile(filename, "utf8"), before);
    assert.deepEqual(await fs.readdir(directory), ["a.json"]);
  } finally {
    rename.mock.restore();
  }

  await store.saveDraft("a", workspaceDir, "重试内容", 1);
  assert.deepEqual(
    (await store.load("a")).draft,
    { text: "重试内容", revision: 2 },
  );
});

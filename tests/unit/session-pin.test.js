const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-pin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions");
  const directory = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(sessions);
  const store = createSessionStateStore(directory);
  const makeService = (stateStore = store) => createSessionService(
    sessions,
    () => assert.fail("置顶和列表不能创建 Agent"),
    () => assert.fail("置顶和列表不能读取当前目录配置"),
    undefined,
    stateStore,
  );
  return { root, sessions, directory, workspace, store, makeService, service: makeService() };
}

async function writeHistory(s, id, cwd = s.workspace, updatedAt = 1000, filename = id) {
  const timestamp = new Date(updatedAt).toISOString();
  const entries = [
    { type: "session", version: 3, id, cwd, timestamp },
    {
      type: "message", id: "u1", parentId: null, timestamp,
      message: { role: "user", content: `问题-${id}`, timestamp: updatedAt },
    },
  ];
  const file = path.join(s.sessions, `${filename}.jsonl`);
  const content = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await fs.writeFile(file, content);
  return { file, content };
}

function withoutPin(state) {
  const { pinnedAt, ...rest } = state;
  return rest;
}

test("列表默认未置顶，不创建状态或Agent，不改写历史", async (t) => {
  const s = await setup(t);
  const history = await writeHistory(s, "a");
  assert.deepEqual(await s.service.listSessions(), [
    { id: "a", title: "问题-a", workspaceDir: s.workspace, updatedAt: 1000, pinnedAt: null, archivedAt: null },
  ]);
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
  assert.equal(await fs.readFile(history.file, "utf8"), history.content);
});

test("置顶持久化，重复置顶保留时间，取消后列表恢复null", async (t) => {
  const s = await setup(t);
  const history = await writeHistory(s, "a");
  const before = Date.now();
  const pinned = await s.service.setSessionPinned("a", true);
  assert.equal(pinned.id, "a");
  assert.ok(pinned.pinnedAt >= before && pinned.pinnedAt <= Date.now());
  assert.deepEqual(await s.service.setSessionPinned("a", true), pinned);
  const reopened = s.makeService(createSessionStateStore(s.directory));
  assert.equal((await reopened.listSessions())[0].pinnedAt, pinned.pinnedAt);
  assert.deepEqual(await reopened.setSessionPinned("a", false), { id: "a", pinnedAt: null });
  assert.equal((await s.service.listSessions())[0].pinnedAt, null);
  assert.equal(await fs.readFile(history.file, "utf8"), history.content);
});

test("置顶与取消保留输入版本、发送快照、来源模型和归档字段", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  await s.store.registerSession("a", s.workspace, "history", { provider: "test", modelId: "model" });
  await s.store.saveDraft("a", s.workspace, "发送原文", 0);
  await s.store.consumeDraft("a", s.workspace, "发送原文", 1);
  await s.store.saveDraft("a", s.workspace, " 后来输入\r\n ", 2);
  const original = await s.store.update("a", s.workspace, state => ({ ...state, archivedAt: 20 }));
  for (const value of [true, false]) {
    await s.service.setSessionPinned("a", value);
    assert.deepEqual(withoutPin(await s.store.load("a")), withoutPin(original));
  }
});

test("与输入保存并行时合并最新状态，不覆盖迟到输入", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  await s.store.saveDraft("a", s.workspace, "旧输入", 0);
  await Promise.all([
    s.service.setSessionPinned("a", true),
    s.store.saveDraft("a", s.workspace, " 新输入\r\n", 1),
  ]);
  const state = await s.store.load("a");
  assert.deepEqual(state.draft, { text: " 新输入\r\n", revision: 2 });
  assert.equal(typeof state.pinnedAt, "number");
});

test("列表仍按消息活动返回，置顶不更新活动时间或泄露输入", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "older", path.join(s.root, "team-a", "demo"), 1000);
  await writeHistory(s, "newer", path.join(s.root, "team-b", "demo"), 2000);
  await s.service.setSessionPinned("older", true);
  const rows = await s.service.listSessions();
  assert.deepEqual(rows.map(row => [row.id, row.updatedAt]), [["newer", 2000], ["older", 1000]]);
  assert.notEqual(rows[0].workspaceDir, rows[1].workspaceDir);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["id", "title", "workspaceDir", "updatedAt", "pinnedAt", "archivedAt"].sort());
  }
  // 旧调用未注入存储时兼容读取，但不能假装已经保存置顶。
  const bare = createSessionService(s.sessions, () => assert.fail("不能创建Agent"));
  assert.equal((await bare.listSessions())[1].pinnedAt, null);
  await assert.rejects(bare.setSessionPinned("older", true), /尚未配置会话状态存储/);
});

test("无效参数、已丢失历史及未发送空会话均拒绝，不新建状态", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  for (const value of [undefined, null, 1, "true"]) {
    await assert.rejects(s.service.setSessionPinned("a", value), /置顶状态无效/);
  }
  for (const id of [undefined, null, "", " ", "../a", "missing"]) {
    await assert.rejects(s.service.setSessionPinned(id, true));
  }
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
  await s.store.saveDraft("empty", s.workspace, "未发送", 0);
  const before = await s.store.load("empty");
  await assert.rejects(s.service.setSessionPinned("empty", true), /未找到该历史对话/);
  assert.deepEqual(await s.store.load("empty"), before);
});

test("无目录或重复编号的历史拒绝置顶，不猜测归属", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "old", null);
  await assert.rejects(s.service.setSessionPinned("old", true), /缺少工作目录/);
  await writeHistory(s, "duplicate", s.workspace, 1000, "copy-one");
  await writeHistory(s, "duplicate", s.workspace, 2000, "copy-two");
  await assert.rejects(s.service.setSessionPinned("duplicate", true), /多份相同编号/);
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
});

test("状态与历史目录不一致时拒绝读取置顶或覆盖记录", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  await s.store.saveDraft("a", path.join(s.root, "other"), "保留", 0);
  const file = path.join(s.directory, "a.json");
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(s.service.listSessions(), /工作目录不匹配/);
  await assert.rejects(s.service.setSessionPinned("a", true), /工作目录不匹配/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("损坏状态明确报错，列表与置顶都不静默当成未置顶", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  await s.store.saveDraft("a", s.workspace, "保留", 0);
  const file = path.join(s.directory, "a.json");
  await fs.writeFile(file, "{broken");
  await assert.rejects(s.service.listSessions(), /记录损坏/);
  await assert.rejects(s.service.setSessionPinned("a", true), /记录损坏/);
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});

test("写入失败保留原状态和历史，清理临时文件后可重试", async (t) => {
  const s = await setup(t);
  const history = await writeHistory(s, "a");
  await s.store.saveDraft("a", s.workspace, "保留输入", 0);
  const file = path.join(s.directory, "a.json");
  const before = await fs.readFile(file, "utf8");
  const rename = t.mock.method(fs, "rename", async () => { throw new Error("模拟置顶写入失败"); });
  try {
    await assert.rejects(s.service.setSessionPinned("a", true), /模拟置顶写入失败/);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(await fs.readdir(s.directory), ["a.json"]);
    assert.equal(await fs.readFile(history.file, "utf8"), history.content);
  } finally {
    rename.mock.restore();
  }
  assert.equal(typeof (await s.service.setSessionPinned("a", true)).pinnedAt, "number");
});
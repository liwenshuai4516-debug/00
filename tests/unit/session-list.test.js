const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-session-list-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 只读取临时历史，不能初始化模型或读取当前工作目录配置。
  const service = createSessionService(
    dir,
    () => assert.fail("列表不能创建 Agent"),
    () => assert.fail("列表不能读取当前工作目录"),
  );

  return { dir, service };
}

async function writeHistory(dir, id, cwd, updatedAt, name) {
  const timestamp = new Date(updatedAt).toISOString();
  const entries = [
    { type: "session", version: 3, id, cwd, timestamp },
    {
      type: "message", id: "u1", parentId: null, timestamp,
      message: { role: "user", content: `问题-${id}`, timestamp: updatedAt - 1000 },
    },
    {
      type: "message", id: "a1", parentId: "u1", timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "不应返回列表的回复正文" }],
        timestamp: updatedAt,
      },
    },
  ];

  if (name) {
    entries.push({
      type: "session_info", id: "n1", parentId: "a1", timestamp, name,
    });
  }

  const file = path.join(dir, `${id}.jsonl`);
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(file, content);
  return { file, content };
}

test("跨目录列表返回归组元信息，保留标题与最近活动顺序", async (t) => {
  const { dir, service } = await setup(t);
  const firstTime = Date.parse("2026-11-01T01:00:00Z");
  const secondTime = firstTime + 1000;
  // 相同目录名也必须保留完整归属，不能仅按最后一级名称合并。
  const firstDir = path.join(dir, "team-a", "demo");
  const secondDir = path.join(dir, "team-b", "demo");
  const first = await writeHistory(dir, "first", firstDir, firstTime, "重命名对话");
  const second = await writeHistory(dir, "second", secondDir, secondTime);

  // 精确比较返回字段，避免泄露历史文件路径、完整正文或 SDK 对象。
  assert.deepEqual(await service.listSessions(), [
    { id: "second", title: "问题-second", workspaceDir: secondDir, updatedAt: secondTime, pinnedAt: null, archivedAt: null },
    { id: "first", title: "重命名对话", workspaceDir: firstDir, updatedAt: firstTime, pinnedAt: null, archivedAt: null },
  ]);
  assert.equal(await readFile(first.file, "utf8"), first.content);
  assert.equal(await readFile(second.file, "utf8"), second.content);
});

test("缺少目录的旧历史保留空归属，不认领到当前项目", async (t) => {
  const { dir, service } = await setup(t);
  const updatedAt = Date.parse("2026-11-01T02:00:00Z");
  const old = await writeHistory(dir, "old", undefined, updatedAt);

  assert.deepEqual(await service.listSessions(), [
    { id: "old", title: "问题-old", workspaceDir: "", updatedAt, pinnedAt: null, archivedAt: null },
  ]);
  assert.equal(await readFile(old.file, "utf8"), old.content);
});

test("空目录返回空列表，不初始化 Agent", async (t) => {
  const { service } = await setup(t);
  assert.deepEqual(await service.listSessions(), []);
});
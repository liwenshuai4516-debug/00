const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

async function fixture(t, version = 3) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-preview-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version, id: "old-session", cwd: "/old-workspace", timestamp },
    { type: "message", id: "u1", parentId: null, timestamp,
      message: { role: "user", content: "旧问题", timestamp: Date.now() } },
    { type: "message", id: "a1", parentId: "u1", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "旧回答" }], timestamp: Date.now() } },
  ];
  if (version === 1) {
    for (const entry of entries.slice(1)) {
      delete entry.id;
      delete entry.parentId;
    }
  }
  const file = path.join(dir, "old.jsonl");
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { dir, file, entries, timestamp };
}

test("无绑定旧会话可预览，内存迁移不改写文件且不创建模型会话", async (t) => {
  const { dir, file } = await fixture(t, 1);
  const before = await readFile(file, "utf8");
  const service = createSessionService(dir, () => { throw new Error("不能创建 Agent"); });
  const result = await service.previewSession("old-session");
  assert.deepEqual(result.history, [
    { role: "user", text: "旧问题" },
    { role: "assistant", text: "旧回答" },
  ]);
  assert.equal(await readFile(file, "utf8"), before);
});

test("预览其他工作目录记录不会替换或释放当前会话", async (t) => {
  const { dir } = await fixture(t);
  let creations = 0;
  let disposals = 0;
  const current = { sessionId: "current", dispose() { disposals += 1; } };
  const service = createSessionService(dir, async () => { creations += 1; return current; });
  await service.getSession();
  await service.previewSession("old-session");
  assert.equal(await service.currentSession(), "current");
  assert.equal(creations, 1);
  assert.equal(disposals, 0);
});

test("拒绝将任意路径当作会话编号", async (t) => {
  const { dir, file } = await fixture(t);
  const service = createSessionService(dir, () => { throw new Error("不能创建 Agent"); });
  for (const value of [file, "../old.jsonl", "missing"]) {
    await assert.rejects(service.previewSession(value), /未找到该历史对话/);
  }
});

test("预览遵循当前分支并展示文件保存记录", async (t) => {
  const { dir, file, entries, timestamp } = await fixture(t);
  entries.push(
    { type: "message", id: "discarded", parentId: "a1", timestamp,
      message: { role: "user", content: "另一分支", timestamp: Date.now() } },
    { type: "custom_message", id: "saved", parentId: "a1", timestamp,
      customType: "workspace-edit-applied", display: true, content: "文件已保存", details: {} },
  );
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const service = createSessionService(dir);
  assert.deepEqual((await service.previewSession("old-session")).history, [
    { role: "user", text: "旧问题" },
    { role: "assistant", text: "旧回答" },
    { role: "status", text: "文件已保存" },
  ]);
});

test("预览 IPC 只转发编号，不初始化或切换当前会话", async () => {
  const handlers = new Map();
  const calls = [];
  const expected = { title: "旧问题", history: [] };
  registerAgentIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { async previewSession(id) { calls.push(id); return expected; } },
    { isBusy: () => true },
  );
  assert.deepEqual(await handlers.get("agent:preview-session")({}, "old-session"), expected);
  assert.deepEqual(calls, ["old-session"]);
});
test("压缩后的预览展示 SDK 摘要和保留消息，不改写历史文件", async (t) => {
  const { dir, file, entries, timestamp } = await fixture(t);

  // 在测试历史中追加压缩记录，保留 a1 开始的消息。
  entries.push({
    type: "compaction",
    id: "c1",
    parentId: "a1",
    timestamp,
    summary: "用户询问了旧问题，后续继续处理。",
    firstKeptEntryId: "a1",
    tokensBefore: 8000,
  });

  await writeFile(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );

  const before = await readFile(file, "utf8");

  // 预览只解析测试文件，不创建 Agent 或请求模型。
  const service = createSessionService(dir, () => {
    throw new Error("预览不能创建 Agent");
  });

  assert.deepEqual(
    (await service.previewSession("old-session")).history,
    [
      {
        role: "status",
        text: "上下文整理摘要\n用户询问了旧问题，后续继续处理。",
      },
      {
        role: "assistant",
        text: "旧回答",
      },
    ],
  );

  // 页面展示摘要不能改变磁盘中的原始历史。
  assert.equal(await readFile(file, "utf8"), before);
});
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");

const workspace = path.join(os.tmpdir(), "chosen-workspace");

function makeSession(id) {
  return {
    sessionId: id,
    messages: [],
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
}

test("并发初始化只读取一次目录，并向创建函数传入第四个参数", async () => {
  const session = makeSession("first");
  const calls = [];
  let reads = 0;

  const service = createSessionService(
    "unused",
    async (...args) => {
      calls.push(args);
      return session;
    },
    async () => {
      reads += 1;
      return workspace;
    },
  );

  const first = service.getSession(true);
  const second = service.getSession(true);

  assert.equal(first, second);
  assert.deepEqual(
    await Promise.all([first, second]),
    [session, session],
  );
  assert.equal(reads, 1);
  assert.deepEqual(calls, [
    ["unused", true, undefined, workspace],
  ]);
});

test("新建会话重新读取目录，成功后才释放原会话", async () => {
  const original = makeSession("original");
  const next = makeSession("next");
  let chosen = workspace;
  const calls = [];

  const service = createSessionService(
    "unused",
    async (...args) => {
      calls.push(args);
      return calls.length === 1 ? original : next;
    },
    async () => chosen,
  );

  await service.getSession();
  chosen = path.join(os.tmpdir(), "other-workspace");

  assert.equal(await service.newChat(), "next");
  assert.equal(await service.getSession(), next);
  // 新会话先返回，原会话清理在后台完成。
  for (let i = 0; i < 50 && !original.disposed; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(original.disposed, true);
  assert.deepEqual(calls, [
    ["unused", false, undefined, workspace],
    ["unused", false, undefined, chosen],
  ]);
});

test("打开历史会话也传入目录，保留实际选中的会话路径", async (t) => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "agent-session-workspace-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "saved.jsonl");
  const timestamp = new Date().toISOString();

  // 仅创建用于查找编号的测试历史，Agent 使用模拟对象。
  const entries = [
    {
      type: "session",
      version: 3,
      id: "saved",
      timestamp,
      cwd: workspace,
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: "测试历史",
        timestamp: Date.now(),
      },
    },
  ];

  await writeFile(
    file,
    entries.map(entry => JSON.stringify(entry)).join("\n") + "\n",
  );

  const calls = [];
  const session = makeSession("saved");

  const service = createSessionService(
    dir,
    async (...args) => {
      calls.push(args);
      return session;
    },
    async () => workspace,
  );

  assert.deepEqual(await service.openSession("saved"), []);
  assert.equal(await service.getSession(), session);
  assert.deepEqual(calls, [[dir, false, file, workspace]]);
});

test("初始化读取目录失败时不创建 Agent，随后可以重试", async () => {
  let reads = 0;
  let creates = 0;
  const session = makeSession("recovered");

  const service = createSessionService(
    "unused",
    async () => {
      creates += 1;
      return session;
    },
    async () => {
      if (++reads === 1) throw new Error("读取目录失败");
      return workspace;
    },
  );

  await assert.rejects(service.getSession(), /读取目录失败/);
  assert.equal(creates, 0);

  assert.equal(await service.getSession(), session);
  assert.equal(creates, 1);
});

test("新建时读取目录失败，保留原会话且不提前释放", async () => {
  let reads = 0;
  let creates = 0;
  const original = makeSession("original");

  const service = createSessionService(
    "unused",
    async () => {
      creates += 1;
      return original;
    },
    async () => {
      if (++reads > 1) throw new Error("读取目录失败");
      return workspace;
    },
  );

  await service.getSession();
  await assert.rejects(service.newChat(), /读取目录失败/);

  assert.equal(await service.getSession(), original);
  assert.equal(original.disposed, false);
  assert.equal(creates, 1);
});
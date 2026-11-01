const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");
const {
  createComposerDraftService,
} = require("../../src/main/services/composer-draft-service.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-composer-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const directory = path.join(root, "state");
  const firstWorkspace = path.join(root, "first");
  const secondWorkspace = path.join(root, "second");
  const store = createSessionStateStore(directory);
  let current;
  let reads = 0;

  function select(sessionId, workspaceDir = firstWorkspace) {
    current = {
      sessionId,
      sessionManager: { getCwd: () => workspaceDir },
    };
  }
  select("a");

  const sessions = {
    async getSession(resume) {
      assert.equal(resume, true);
      reads += 1;
      return current;
    },
  };

  return {
    directory,
    firstWorkspace,
    secondWorkspace,
    store,
    sessions,
    select,
    readCount: () => reads,
    service: createComposerDraftService(sessions, store),
  };
}

test("首次读取返回当前编号及空草稿，不创建状态文件", async (t) => {
  const { directory, service } = await setup(t);

  assert.deepEqual(await service.loadCurrentDraft(), {
    sessionId: "a",
    text: "",
    revision: 0,
  });
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("保存完整原文与空输入，重建服务后恢复对应版本", async (t) => {
  const { service, sessions, directory } = await setup(t);
  await service.loadCurrentDraft();

  const text = " \t中文  \r\n\n末尾 ";
  assert.deepEqual(await service.saveDraft("a", text, 0), {
    sessionId: "a",
    text,
    revision: 1,
  });

  const reopened = createComposerDraftService(
    sessions,
    createSessionStateStore(directory),
  );
  assert.deepEqual(await reopened.loadCurrentDraft(), {
    sessionId: "a",
    text,
    revision: 1,
  });

  await reopened.saveDraft("a", "", 1);
  assert.deepEqual(await service.loadCurrentDraft(), {
    sessionId: "a",
    text: "",
    revision: 2,
  });
});

test("切换到 B 后保存 A 的迟到输入，不重新查询或写入 B", async (t) => {
  const { service, select, secondWorkspace, store, readCount } = await setup(t);

  await service.loadCurrentDraft();
  select("b", secondWorkspace);
  await service.loadCurrentDraft();
  const before = readCount();

  await service.saveDraft("a", "A 的迟到输入", 0);
  await service.saveDraft("b", "B 的输入", 0);

  assert.equal(readCount(), before);
  assert.equal((await store.load("a")).draft.text, "A 的迟到输入");
  assert.equal((await store.load("b")).draft.text, "B 的输入");
});

test("未登记编号不能写入，包括存储里已有但未打开的会话", async (t) => {
  const { service, store, firstWorkspace } = await setup(t);
  await store.saveDraft("history", firstWorkspace, "原输入", 0);

  await assert.rejects(
    service.saveDraft("a", "未登记", 0),
    /尚未登记/,
  );

  await service.loadCurrentDraft();
  await assert.rejects(
    service.saveDraft("history", "错误覆盖", 1),
    /尚未登记/,
  );

  assert.equal((await store.load("history")).draft.text, "原输入");
  assert.equal(await store.load("a"), null);
});

test("相同编号不能重新绑定另一目录，失败后保留原登记", async (t) => {
  const {
    service, select, firstWorkspace, secondWorkspace, store,
  } = await setup(t);

  await service.loadCurrentDraft();
  select("a", secondWorkspace);

  await assert.rejects(
    service.loadCurrentDraft(),
    /已登记目录不一致/,
  );

  await service.saveDraft("a", "仍归原目录", 0);
  assert.equal((await store.load("a")).workspaceDir, firstWorkspace);
});

test("磁盘草稿绑定不匹配时拒绝读取，且不登记写入权限", async (t) => {
  const {
    service, select, store, firstWorkspace, secondWorkspace,
  } = await setup(t);

  const original = await store.saveDraft(
    "a", firstWorkspace, "原目录内容", 0,
  );
  select("a", secondWorkspace);

  await assert.rejects(
    service.loadCurrentDraft(),
    /当前会话不匹配/,
  );
  await assert.rejects(
    service.saveDraft("a", "不要覆盖", 1),
    /尚未登记/,
  );

  assert.deepEqual(await store.load("a"), original);
});

test("服务传递版本冲突和无效输入错误，不覆盖已清空的新版本", async (t) => {
  const { service } = await setup(t);
  await service.loadCurrentDraft();

  await service.saveDraft("a", "原文", 0);
  await service.saveDraft("a", "", 1);

  await assert.rejects(
    service.saveDraft("a", "迟到原文", 1),
    /版本已变化/,
  );
  await assert.rejects(
    service.saveDraft("a", null, 2),
    /草稿或版本无效/,
  );

  assert.deepEqual(await service.loadCurrentDraft(), {
    sessionId: "a",
    text: "",
    revision: 2,
  });
});

test("A 的读取晚于 B 返回时，响应仍标明原会话编号", async (t) => {
  const { service, store, select, secondWorkspace } = await setup(t);
  const originalLoad = store.load;
  let release;
  let started;

  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });

  t.mock.method(store, "load", async (id) => {
    if (id === "a") {
      started();
      await gate;
    }
    return originalLoad(id);
  });

  const first = service.loadCurrentDraft();
  await entered;

  select("b", secondWorkspace);
  const second = await service.loadCurrentDraft();

  release();
  assert.equal(second.sessionId, "b");
  assert.equal((await first).sessionId, "a");

  await service.saveDraft("a", "A 的输入", 0);
  assert.equal(await originalLoad("b"), null);
});

test("并发登记同编号不同目录时，迟到读取不能改写已确认归属", async (t) => {
  const { service, store, select, secondWorkspace } = await setup(t);
  const originalLoad = store.load;
  let release;
  let started;
  let calls = 0;

  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });

  t.mock.method(store, "load", async (id) => {
    calls += 1;
    if (calls === 1) {
      started();
      await gate;
    }
    return originalLoad(id);
  });

  const first = service.loadCurrentDraft();
  const rejected = assert.rejects(first, /已登记目录不一致/);
  await entered;

  select("a", secondWorkspace);
  await service.loadCurrentDraft();

  release();
  await rejected;

  await service.saveDraft("a", "归入已确认目录", 0);
  assert.equal(
    (await originalLoad("a")).workspaceDir,
    secondWorkspace,
  );
});
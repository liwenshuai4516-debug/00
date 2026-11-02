const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");

const model = {
  provider: "desktop-profile-11111111-1111-4111-8111-111111111111",
  modelId: "chat-model",
};

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-registration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "state");
  return {
    directory,
    workspaceDir: path.join(root, "workspace"),
    store: createSessionStateStore(directory),
  };
}

test("登记保留编号、目录和模型配置标识，重建实例后可读取", async (t) => {
  const { directory, workspaceDir, store } = await setup(t);
  const supplied = { ...model, apiKey: "test-placeholder" };
  const saving = store.registerSession("a", workspaceDir, "empty", supplied);
  supplied.modelId = "后来修改";
  const state = await saving;
  assert.equal(state.sessionId, "a");
  assert.equal(state.workspaceDir, workspaceDir);
  assert.deepEqual(state.registration, { source: "empty", model });
  assert.deepEqual(await createSessionStateStore(directory).load("a"), state);
  assert.equal(JSON.stringify(state).includes("test-placeholder"), false);
  assert.deepEqual(await fs.readdir(directory), ["a.json"]);
});

test("旧记录保持未登记，不擅自认定为空会话", async (t) => {
  const { directory, workspaceDir, store } = await setup(t);
  const state = await store.saveDraft("a", workspaceDir, "原输入", 0);
  assert.equal(state.registration, undefined);
  const reopened = createSessionStateStore(directory);
  assert.deepEqual(await reopened.load("a"), state);
  await reopened.saveDraft("a", workspaceDir, "新输入", 1);
  assert.equal((await reopened.load("a")).registration, undefined);
});

test("历史来源不可降级，更新模型不改变输入和待确认发送", async (t) => {
  const { workspaceDir, store } = await setup(t);
  await store.registerSession("a", workspaceDir, "empty", model);
  await store.saveDraft("a", workspaceDir, "原文", 0);
  await store.consumeDraft("a", workspaceDir, "原文", 1);
  await store.saveDraft("a", workspaceDir, "后来输入", 2);
  await store.update("a", workspaceDir, (state) => ({
    ...state, pinnedAt: 100, archivedAt: 200,
  }));
  const before = await store.load("a");
  await store.registerSession("a", workspaceDir, "history", model);
  const nextModel = { ...model, modelId: "next-model" };
  const after = await store.registerSession("a", workspaceDir, "empty", nextModel);
  assert.deepEqual(after, {
    ...before, registration: { source: "history", model: nextModel },
  });
});

test("登记与输入并发写入互不覆盖，不同会话相互隔离", async (t) => {
  const { workspaceDir, store } = await setup(t);
  await Promise.all([
    store.registerSession("a", workspaceDir, "empty", model),
    store.saveDraft("a", workspaceDir, " A 原文\r\n", 0),
    store.registerSession("b", workspaceDir, "history", model),
    store.saveDraft("b", workspaceDir, "B 输入", 0),
  ]);
  const a = await store.load("a");
  const b = await store.load("b");
  assert.deepEqual(a.draft, { text: " A 原文\r\n", revision: 1 });
  assert.equal(a.registration.source, "empty");
  assert.deepEqual(b.draft, { text: "B 输入", revision: 1 });
  assert.equal(b.registration.source, "history");
});

test("无效登记和目录不匹配不覆盖原文件", async (t) => {
  const { directory, workspaceDir, store } = await setup(t);
  await store.registerSession("a", workspaceDir, "history", model);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename, "utf8");
  for (const [source, selection] of [
    ["unknown", model], ["empty", null],
    ["empty", { ...model, provider: " " }],
    ["history", { ...model, modelId: "" }],
  ]) {
    await assert.rejects(
      store.registerSession("a", workspaceDir, source, selection),
      /恢复登记无效/,
    );
    assert.equal(await fs.readFile(filename, "utf8"), before);
  }
  await assert.rejects(
    store.registerSession("a", path.join(workspaceDir, "other"), "empty", model),
    /工作目录不匹配/,
  );
  assert.equal(await fs.readFile(filename, "utf8"), before);
});

test("损坏的登记明确报错，拒绝用新登记覆盖", async (t) => {
  const { directory, workspaceDir, store } = await setup(t);
  const state = await store.registerSession("a", workspaceDir, "empty", model);
  const filename = path.join(directory, "a.json");
  const damaged = JSON.stringify({ ...state, registration: { source: "empty" } });
  await fs.writeFile(filename, damaged);
  await assert.rejects(store.load("a"), /恢复登记无效/);
  await assert.rejects(
    store.registerSession("a", workspaceDir, "empty", model),
    /恢复登记无效/,
  );
  assert.equal(await fs.readFile(filename, "utf8"), damaged);
});
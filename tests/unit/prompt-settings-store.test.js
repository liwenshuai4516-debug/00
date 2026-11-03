
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createPromptSettingsStore } = require("../../src/main/storage/prompt-settings-store.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "settings", "prompt.json");
  const create = () => createPromptSettingsStore(filename, async () => "内置测试职责");
  return { root, filename, create, store: create() };
}

test("默认读取不创建文件，保存后重建实例仍保留原文", async (t) => {
  const { filename, create, store } = await setup(t);
  assert.equal((await store.read()).revision, 0);
  await assert.rejects(fs.stat(filename), { code: "ENOENT" });
  const text = "  测试职责\n保留空白  ";
  await store.save(text, 0);
  assert.deepEqual(await create().read(), { version: 1, revision: 1, testAgentPrompt: text });
});

test("并发旧修订仅接受一次，失败后仍能保存", async (t) => {
  const { store } = await setup(t);
  const results = await Promise.allSettled([store.save("版本 A", 0), store.save("版本 B", 0)]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /版本已变化/);
  await store.save("版本 C", 1);
  assert.equal((await store.read()).testAgentPrompt, "版本 C");
});

test("无效正文和损坏文件不会覆盖已存内容", async (t) => {
  const { filename, store } = await setup(t);
  await store.save("原内容", 0);
  for (const text of [null, "", "  ", "a".repeat(16001), "a\0b"]) {
    await assert.rejects(store.save(text, 1), /配置无效/);
  }
  assert.equal((await store.read()).testAgentPrompt, "原内容");
  await fs.writeFile(filename, "{broken");
  await assert.rejects(store.read(), /损坏/);
  await assert.rejects(store.save("不要覆盖", 1), /损坏/);
  assert.equal(await fs.readFile(filename, "utf8"), "{broken");
});

test("替换失败保留旧配置、清理临时文件，并允许重试", async (t) => {
  const { filename, store } = await setup(t);
  await store.save("原内容", 0);
  const rename = t.mock.method(fs, "rename", async () => { throw new Error("模拟替换失败"); });
  try {
    await assert.rejects(store.save("未保存内容", 1), /模拟替换失败/);
    assert.equal((await store.read()).testAgentPrompt, "原内容");
    assert.deepEqual(await fs.readdir(path.dirname(filename)), ["prompt.json"]);
  } finally {
    rename.mock.restore();
  }
  await store.save("重试成功", 1);
  assert.equal((await store.read()).revision, 2);
});

test("提示词快照与输入、置顶、归档及恢复登记互不覆盖", async (t) => {
  const { root } = await setup(t);
  const store = createSessionStateStore(path.join(root, "state"));
  const workspace = path.join(root, "workspace");
  const snapshot = { version: 1, revision: 2, testAgentPrompt: "固定职责", origin: "new" };
  await Promise.all([
    store.update("a", workspace, state => ({ ...state, promptSnapshot: snapshot })),
    store.saveDraft("a", workspace, "原输入", 0),
    store.update("a", workspace, state => ({ ...state, pinnedAt: 1, archivedAt: 2 })),
    store.registerSession("a", workspace, "empty", { provider: "demo", modelId: "demo" }),
  ]);
  const state = await store.load("a");
  assert.deepEqual(state.promptSnapshot, snapshot);
  assert.equal(state.draft.text, "原输入");
  assert.equal(state.pinnedAt, 1);
  assert.equal(state.archivedAt, 2);
  assert.equal(state.registration.source, "empty");
  await assert.rejects(store.update("a", workspace, current => ({
    ...current, promptSnapshot: { ...snapshot, origin: "unknown" },
  })), /快照来源无效/);
  assert.deepEqual((await store.load("a")).promptSnapshot, snapshot);
});
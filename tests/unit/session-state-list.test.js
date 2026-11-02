const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "state-list-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, "state");
  return { base, directory, store: createSessionStateStore(directory) };
}

test("空列表不创建目录；枚举等待调用前已排队的首次保存", async (t) => {
  const { base, directory, store } = await setup(t);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  const saving = store.saveDraft("a", base, "原文", 0);
  const states = await store.list();
  assert.deepEqual(states, [await saving]);
});

test("枚举返回完整校验后的独立快照，保留空输入、登记、组织及发送状态", async (t) => {
  const { base, directory, store } = await setup(t);
  await store.saveDraft("b", path.join(base, "other"), "", 0);
  await store.registerSession("a", base, "empty", { provider: "test", modelId: "model" });
  await store.saveDraft("a", base, "待确认原文", 0);
  await store.consumeDraft("a", base, "待确认原文", 1);
  await store.update("a", base, state => ({ ...state, pinnedAt: 1, archivedAt: 2 }));
  await fs.writeFile(path.join(directory, "a.json.partial.tmp"), "incomplete");
  const before = await fs.readFile(path.join(directory, "a.json"), "utf8");
  const result = await store.list();
  assert.deepEqual(result, [await store.load("a"), await store.load("b")]);
  result[0].pendingSend.text = "不要写回";
  assert.equal(await fs.readFile(path.join(directory, "a.json"), "utf8"), before);
  assert.equal((await createSessionStateStore(directory).list())[0].pendingSend.text, "待确认原文");
});

test("损坏内容、非法文件编号及文件头编号不符均明确拒绝，不返回假空列表", async (t) => {
  const { base, directory, store } = await setup(t);
  const valid = await store.saveDraft("a", base, "保留原文", 0);
  const filename = path.join(directory, "a.json");
  for (const text of ["{broken", JSON.stringify({ ...valid, sessionId: "wrong" })]) {
    await fs.writeFile(filename, text);
    await assert.rejects(store.list(), /损坏|归属不匹配/);
    assert.equal(await fs.readFile(filename, "utf8"), text);
  }
  await fs.writeFile(filename, JSON.stringify(valid));
  await fs.writeFile(path.join(directory, ".invalid.json"), JSON.stringify(valid));
  await assert.rejects(store.list(), /无效的会话编号/);
});

test("目录读取错误原样报告，不吞成空列表或修改已保存输入", async (t) => {
  const { base, directory, store } = await setup(t);
  await store.saveDraft("a", base, "保留原文", 0);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename, "utf8");
  const error = new Error("模拟目录不可读");
  const mock = t.mock.method(fs, "readdir", async () => { throw error; });
  try {
    await assert.rejects(store.list(), value => value === error);
  } finally {
    mock.mock.restore();
  }
  assert.equal(await fs.readFile(filename, "utf8"), before);
});
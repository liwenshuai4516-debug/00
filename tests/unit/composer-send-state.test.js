const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-send-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createSessionStateStore(root);
  const text = "  原文\r\n\t第二行 \n";
  await store.saveDraft("a", root, text, 0);
  return { root, store, text, filename: path.join(root, "a.json") };
}

test("原文快照与清空版本一起保存，重建存储可读取且不影响 B", async (t) => {
  const { root, store, text } = await setup(t);
  await store.saveDraft("b", root, "B 输入", 0);

  const state = await store.consumeDraft("a", root, text, 1);
  assert.deepEqual(state.draft, { text: "", revision: 2 });
  assert.equal(state.pendingSend.text, text);
  assert.equal(state.pendingSend.draftRevision, 1);
  assert.equal(typeof state.pendingSend.id, "string");
  assert.ok(state.pendingSend.id);

  assert.deepEqual(await createSessionStateStore(root).load("a"), state);
  assert.equal((await store.load("b")).draft.text, "B 输入");
});

test("版本、原文、目录或参数不符时拒绝消费，原文件不变", async (t) => {
  const { root, store, text, filename } = await setup(t);
  const before = await fs.readFile(filename, "utf8");

  for (const [directory, value, revision, error] of [
    [root, text, 0, /待发送输入已变化/],
    [root, "不同原文", 1, /待发送输入已变化/],
    [path.join(root, "other"), text, 1, /工作目录不匹配/],
    [root, " \n", 1, /发送原文或输入版本无效/],
    [root, null, 1, /发送原文或输入版本无效/],
    [root, text, -1, /发送原文或输入版本无效/],
  ]) {
    await assert.rejects(
      store.consumeDraft("a", directory, value, revision),
      error,
    );
    assert.equal(await fs.readFile(filename, "utf8"), before);
  }
});

test("并发消费只接受一次，旧自动保存不能写回，后续新输入可保存", async (t) => {
  const { root, store, text } = await setup(t);
  const results = await Promise.allSettled([
    store.consumeDraft("a", root, text, 1),
    store.consumeDraft("a", root, text, 1),
    store.saveDraft("a", root, text, 1),
  ]);

  assert.deepEqual(results.map((result) => result.status), [
    "fulfilled", "rejected", "rejected",
  ]);

  const snapshot = results[0].value.pendingSend;
  await store.saveDraft("a", root, "下一条输入", 2);
  const state = await store.load("a");
  assert.deepEqual(state.draft, { text: "下一条输入", revision: 3 });
  assert.deepEqual(state.pendingSend, snapshot);
});

test("未确认快照不能被下一次发送覆盖", async (t) => {
  const { root, store, text, filename } = await setup(t);
  await store.consumeDraft("a", root, text, 1);
  await store.saveDraft("a", root, "下一条", 2);
  const before = await fs.readFile(filename, "utf8");

  await assert.rejects(
    store.consumeDraft("a", root, "下一条", 3),
    /尚未确认的发送记录/,
  );
  assert.equal(await fs.readFile(filename, "utf8"), before);
});

test("完成只清理对应快照，保留新输入和组织状态，迟到完成不清理新发送", async (t) => {
  const { root, store, text } = await setup(t);
  const first = await store.consumeDraft("a", root, text, 1);
  await store.saveDraft("a", root, "下一条", 2);
  await store.update("a", root, (state) => ({
    ...state, pinnedAt: 100, archivedAt: 200,
  }));

  const completed = await store.completeSend("a", root, first.pendingSend.id);
  assert.equal(completed.pendingSend, null);
  assert.deepEqual(completed.draft, { text: "下一条", revision: 3 });
  assert.equal(completed.pinnedAt, 100);
  assert.equal(completed.archivedAt, 200);

  const second = await store.consumeDraft("a", root, "下一条", 3);
  await assert.rejects(
    store.completeSend("a", root, first.pendingSend.id),
    /发送记录已变化/,
  );
  await assert.rejects(
    store.completeSend("a", root, ""),
    /发送编号无效/,
  );
  assert.deepEqual(await store.load("a"), second);
});

test("消费与完成写入失败都保留原记录并清理临时文件，可显式重试", async (t) => {
  const { root, store, text, filename } = await setup(t);
  let before = await fs.readFile(filename, "utf8");

  function failRename() {
    return t.mock.method(fs, "rename", async () => {
      throw new Error("模拟替换失败");
    });
  }

  let mock = failRename();
  try {
    await assert.rejects(
      store.consumeDraft("a", root, text, 1),
      /模拟替换失败/,
    );
    assert.equal(await fs.readFile(filename, "utf8"), before);
    assert.deepEqual(await fs.readdir(root), ["a.json"]);
  } finally {
    mock.mock.restore();
  }

  const sending = await store.consumeDraft("a", root, text, 1);
  before = await fs.readFile(filename, "utf8");
  mock = failRename();
  try {
    await assert.rejects(
      store.completeSend("a", root, sending.pendingSend.id),
      /模拟替换失败/,
    );
    assert.equal(await fs.readFile(filename, "utf8"), before);
    assert.deepEqual(await fs.readdir(root), ["a.json"]);
  } finally {
    mock.mock.restore();
  }

  await store.completeSend("a", root, sending.pendingSend.id);
  assert.equal((await store.load("a")).pendingSend, null);
});

test("兼容没有快照字段的旧记录，损坏快照明确拒绝且不覆盖", async (t) => {
  const { root, store, text, filename } = await setup(t);
  const legacy = await store.load("a");
  delete legacy.pendingSend;
  await fs.writeFile(filename, JSON.stringify(legacy));
  assert.deepEqual(await store.load("a"), legacy);

  const valid = await store.consumeDraft("a", root, text, 1);
  for (const pendingSend of [
    {},
    { ...valid.pendingSend, id: "" },
    { ...valid.pendingSend, text: " \n" },
    { ...valid.pendingSend, draftRevision: -1 },
    { ...valid.pendingSend, draftRevision: valid.draft.revision },
  ]) {
    const damaged = JSON.stringify({ ...valid, pendingSend });
    await fs.writeFile(filename, damaged);

    await assert.rejects(store.load("a"), /发送快照记录无效/);
    await assert.rejects(
      store.saveDraft("a", root, "不要覆盖", 2),
      /发送快照记录无效/,
    );
    assert.equal(await fs.readFile(filename, "utf8"), damaged);
  }
});
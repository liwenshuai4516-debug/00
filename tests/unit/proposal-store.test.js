const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createProposalStore,
} = require("../../src/main/services/proposal-store.js");

function makeProposal() {
  return {
    kind: "edit-proposal",
    path: "example.js",
    oldText: "before",
    newText: "after",
    baseTextHash: "a".repeat(64),
    written: false,
  };
}

test("草稿由主进程分配独立编号", () => {
  const store = createProposalStore();
  const first = store.add("session-a", makeProposal());
  const second = store.add("session-a", makeProposal());

  assert.notEqual(first.id, second.id);
  assert.equal(first.sessionId, "session-a");
  assert.deepEqual(store.get("session-a", first.id), first);
});

test("修改输入或返回对象不能篡改已登记草稿", () => {
  const store = createProposalStore();
  const input = makeProposal();
  const saved = store.add("session-a", input);
  const id = saved.id;

  input.newText = "篡改输入";
  saved.newText = "篡改返回值";

  assert.equal(store.get("session-a", id).newText, "after");
});

test("拒绝读取其他会话或不存在的草稿", () => {
  const store = createProposalStore();
  const saved = store.add("session-a", makeProposal());

  assert.throws(
    () => store.get("session-b", saved.id),
    /当前会话中不存在/,
  );

  assert.throws(
    () => store.get("session-a", "missing"),
    /当前会话中不存在/,
  );
});

test("只有所属会话能标记已保存，状态不能被返回值篡改", () => {
  const store = createProposalStore();
  const proposal = store.add("session-a", makeProposal());

  assert.throws(
    () => store.markWritten("session-b", proposal.id),
    /当前会话中不存在/,
  );
  assert.equal(store.get("session-a", proposal.id).written, false);

  const updated = store.markWritten("session-a", proposal.id);
  assert.equal(updated.written, true);
  updated.written = false;
  assert.equal(store.get("session-a", proposal.id).written, true);

  assert.throws(
    () => store.markWritten("session-a", proposal.id),
    /已经保存/,
  );
});


test("待保存列表隔离会话、排除已保存项，且返回独立摘要", () => {
  const store = createProposalStore();
  const pending = store.add("session-a", makeProposal());
  const saved = store.add("session-a", makeProposal());
  const other = store.add("session-b", makeProposal());
  store.markWritten("session-a", saved.id);

  const expected = [{ id: pending.id, path: pending.path }];
  const list = store.listPending("session-a");
  assert.deepEqual(list, expected);
  assert.deepEqual(store.listPending("session-b"), [
    { id: other.id, path: other.path },
  ]);

  list[0].path = "changed.js";
  assert.deepEqual(store.listPending("session-a"), expected);
  assert.equal(store.get("session-a", pending.id).path, pending.path);
});

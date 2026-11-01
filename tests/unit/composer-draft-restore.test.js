const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(value = "") {
  const { createComposerDrafts } = await import(
    "../../src/renderer/components/composer-drafts.js"
  );
  const input = { value };
  return { input, drafts: createComposerDrafts(input) };
}

function draft(sessionId, text) {
  return { sessionId, text, revision: 3 };
}

test("绑定后恢复完整原文，空草稿也只恢复一次", async () => {
  for (const text of [" \t中文\r\n\n末尾 ", ""]) {
    const { input, drafts } = await setup();
    assert.equal(drafts.beginRestore(), null);

    drafts.switchTo("a");
    const ticket = drafts.beginRestore();
    assert.equal(drafts.applyRestore(ticket, draft("a", text)), true);
    assert.equal(input.value, text);
    assert.equal(drafts.beginRestore(), null);
    assert.equal(drafts.applyRestore(ticket, draft("a", "重复返回")), false);
  }
});

test("首次绑定保护预先输入，以及输入后主动清空", async () => {
  const first = await setup("加载期间输入");
  first.drafts.switchTo("a");
  assert.equal(first.drafts.beginRestore(), null);
  assert.equal(first.input.value, "加载期间输入");

  const { input, drafts } = await setup();
  input.value = "输入过";
  drafts.recordEdit();
  input.value = "";
  drafts.recordEdit();

  drafts.switchTo("a");
  assert.equal(drafts.beginRestore(), null);
  assert.equal(input.value, "");
});

test("编辑后即使改回空串，旧读取也不能回填，切回仍保留清空", async () => {
  const { input, drafts } = await setup();
  drafts.switchTo("a");
  const ticket = drafts.beginRestore();

  input.value = "新输入";
  drafts.recordEdit();
  input.value = "";
  drafts.recordEdit();

  assert.equal(drafts.applyRestore(ticket, draft("a", "磁盘旧输入")), false);
  drafts.switchTo("b");
  drafts.switchTo("a");
  assert.equal(input.value, "");
  assert.equal(drafts.beginRestore(), null);
});

test("A 的迟到读取不影响 B，A → B → A 后旧凭证也失效", async () => {
  const { input, drafts } = await setup();
  drafts.switchTo("a");
  const first = drafts.beginRestore();

  drafts.switchTo("b");
  assert.equal(drafts.applyRestore(first, draft("a", "A 旧内容")), false);
  const second = drafts.beginRestore();
  assert.equal(drafts.applyRestore(second, draft("b", "B 内容")), true);

  drafts.switchTo("a");
  assert.equal(drafts.applyRestore(first, draft("a", "A 旧内容")), false);
  assert.equal(input.value, "");

  const latest = drafts.beginRestore();
  assert.equal(drafts.applyRestore(latest, draft("a", "A 当前内容")), true);
  drafts.switchTo("b");
  assert.equal(input.value, "B 内容");
});

test("只接受最新读取且必须匹配编号，同会话刷新不打断读取", async () => {
  const { input, drafts } = await setup();
  drafts.switchTo("a");
  const first = drafts.beginRestore();
  const latest = drafts.beginRestore();

  assert.equal(drafts.applyRestore(first, draft("a", "过期读取")), false);
  drafts.switchTo("a");
  assert.equal(drafts.applyRestore(latest, draft("b", "错误会话")), false);
  assert.equal(input.value, "");

  const retry = drafts.beginRestore();
  drafts.switchTo("a");
  assert.equal(drafts.applyRestore(retry, draft("a", "正确内容")), true);
});

test("程序修改与失败恢复都不会被磁盘旧输入覆盖", async () => {
  const { input, drafts } = await setup();
  drafts.switchTo("a");
  const ticket = drafts.beginRestore();

  input.value = "程序写入的新内容";
  assert.equal(drafts.applyRestore(ticket, draft("a", "旧读取")), false);
  assert.equal(drafts.beginRestore(), null);
  assert.equal(input.value, "程序写入的新内容");

  const other = await setup();
  other.drafts.switchTo("a");
  const pending = other.drafts.beginRestore();

  assert.equal(other.drafts.restoreAfterFailure("  失败原文\n"), true);
  assert.equal(
    other.drafts.applyRestore(pending, draft("a", "磁盘旧输入")),
    false,
  );
  assert.equal(other.input.value, "  失败原文\n");
});
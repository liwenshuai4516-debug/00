const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(value = "") {
  const { createComposerDrafts } = await import(
    "../../src/renderer/components/composer-drafts.js"
  );

  // 只模拟输入框的 value，不依赖浏览器或真实会话。
  const input = { value };
  return { input, drafts: createComposerDrafts(input) };
}

test("按会话隔离输入，切回时保留换行和缩进", async () => {
  const { input, drafts } = await setup();

  drafts.switchTo("a");
  input.value = "第一行\n  第二行";

  drafts.switchTo("b");
  assert.equal(input.value, "");
  input.value = "会话 B 的输入";

  drafts.switchTo("a");
  assert.equal(input.value, "第一行\n  第二行");

  drafts.switchTo("b");
  assert.equal(input.value, "会话 B 的输入");
});

test("首次绑定和同会话刷新不覆盖当前输入", async () => {
  const { input, drafts } = await setup("页面加载时输入的文字");

  drafts.switchTo("a");
  assert.equal(input.value, "页面加载时输入的文字");

  input.value = "正在编辑的新内容";
  drafts.switchTo("a");
  assert.equal(input.value, "正在编辑的新内容");
});

test("已发送后清空的输入不会恢复成旧草稿", async () => {
  const { input, drafts } = await setup();

  drafts.switchTo("a");
  input.value = "准备发送";
  drafts.switchTo("b");
  drafts.switchTo("a");

  // 模拟现有发送流程清空输入框。
  input.value = "";
  drafts.switchTo("b");
  drafts.switchTo("a");
  assert.equal(input.value, "");

  // 回复期间编辑下一条消息，同会话刷新不能将其清空。
  input.value = "下一条消息";
  drafts.switchTo("a");
  assert.equal(input.value, "下一条消息");
});

test("失败后恢复完整原文，切换会话后仍能找回", async () => {
  const { input, drafts } = await setup();
  const original = "  第一行\n    第二行\n";

  drafts.switchTo("a");

  // 模拟发送后输入框已清空，请求失败时恢复原文。
  assert.equal(drafts.restoreAfterFailure(original), true);
  assert.equal(input.value, original);

  // 恢复的输入也应遵循现有的会话隔离规则。
  drafts.switchTo("b");
  assert.equal(input.value, "");

  drafts.switchTo("a");
  assert.equal(input.value, original);
});

test("失败恢复不覆盖等待期间输入的新内容或空白", async () => {
  const { input, drafts } = await setup();

  drafts.switchTo("a");

  // 空格和换行同样视为用户正在编辑的内容。
  for (const current of ["正在写下一条消息", "  \n"]) {
    input.value = current;

    assert.equal(
      drafts.restoreAfterFailure("失败请求的原文"),
      false,
    );

    assert.equal(input.value, current);
  }
});
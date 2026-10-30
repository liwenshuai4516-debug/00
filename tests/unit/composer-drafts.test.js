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
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatToolResult,
  toHistory,
} = require("../../src/main/adapters/message-adapter.js");

test("历史保留消息顺序和工具结果，不展示思考内容", () => {
  const history = toHistory([
    { role: "user", content: "请查看文件" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "内部推理" },
        { type: "text", text: "我先读取文件。" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ],
    },
    {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "文件正文" }],
      isError: false,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "这是分析结果。" }],
    },
  ]);

  assert.deepEqual(history, [
    { role: "user", text: "请查看文件" },
    { role: "assistant", text: "我先读取文件。" },
    { role: "tool", text: "read 执行完成\n文件正文" },
    { role: "assistant", text: "这是分析结果。" },
  ]);
});

test("失败结果包含工具名称和具体错误", () => {
  const text = formatToolResult(
    "read",
    [{ type: "text", text: "文件不存在" }],
    true,
  );

  assert.equal(text, "read 执行失败\n文件不存在");
});

test("长结果只截断展示，不修改原始消息", () => {
  const original = "x".repeat(4001);
  const content = [{ type: "text", text: original }];
  const text = formatToolResult("read", content, false);

  assert.ok(text.includes("结果较长，显示已截断"));
  assert.ok(!text.includes(original));
  assert.equal(content[0].text, original);
});

test("历史显示保存记录，忽略隐藏或未知的自定义消息", () => {
  assert.deepEqual(toHistory([
    {
      role: "custom",
      customType: "workspace-edit-applied",
      display: true,
      content: "文件已保存：example.js",
    },
    {
      role: "custom",
      customType: "workspace-edit-applied",
      display: false,
      content: "隐藏消息",
    },
    {
      role: "custom",
      customType: "other-type",
      display: true,
      content: "其他消息",
    },
  ]), [
    { role: "status", text: "文件已保存：example.js" },
  ]);
});

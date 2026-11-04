const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Value } = require("typebox/value");

// 工具以 ESM 发布；测试只调用公开的 execute，不经过模型或网络。
async function loadTool() {
  const module = await import("../../src/main/tools/todo-write.mjs");
  return module.todoWriteTool;
}

test("todo_write 整表替换并返回各状态计数", async () => {
  const tool = await loadTool();
  const result = await tool.execute("call-1", {
    todos: [
      { content: " 检查输出 ", status: "completed" },
      { content: "核对技能", status: "in_progress" },
      { content: "整理结论", status: "pending" },
    ],
  }, undefined, undefined);

  assert.match(result.content[0].text, /1 待处理，1 进行中，1 已完成/);
  assert.deepEqual(result.details.todos, [
    { content: "检查输出", status: "completed" },
    { content: "核对技能", status: "in_progress" },
    { content: "整理结论", status: "pending" },
  ]);
});

test("todo_write 允许空列表，用于清空任务", async () => {
  const tool = await loadTool();
  const result = await tool.execute("call-2", { todos: [] }, undefined, undefined);

  assert.match(result.content[0].text, /0 待处理，0 进行中，0 已完成/);
  assert.deepEqual(result.details.todos, []);
});

test("todo_write 拒绝空内容与重复任务", async () => {
  const tool = await loadTool();

  await assert.rejects(
    () => tool.execute("call-3", { todos: [{ content: "   ", status: "pending" }] }, undefined, undefined),
    /content` 不能为空/,
  );
  await assert.rejects(
    () => tool.execute("call-4", {
      todos: [
        { content: "重复", status: "pending" },
        { content: "重复", status: "completed" },
      ],
    }, undefined, undefined),
    /重复的任务/,
  );
});

test("todo_write 参数 schema 只接受三种状态", async () => {
  const tool = await loadTool();

  assert.equal(Value.Check(tool.parameters, { todos: [{ content: "任务", status: "in_progress" }] }), true);
  assert.equal(Value.Check(tool.parameters, { todos: [{ content: "任务", status: "done" }] }), false);
  assert.equal(Value.Check(tool.parameters, { todos: [{ status: "pending" }] }), false);
});

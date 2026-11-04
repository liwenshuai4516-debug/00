const assert = require("node:assert/strict");
const { test } = require("node:test");

// 投影函数不依赖 DOM，可直接在 Node 中导入。
async function loadProjection() {
  const module = await import("../../src/renderer/components/todo-dock.js");
  return module.todosFromHistory;
}

const withTodos = (todos) => ({ output: { todos } });

test("历史投影取最后一条 todo_write 结果", async () => {
  const todosFromHistory = await loadProjection();
  const history = [
    { role: "user", text: "开始" },
    withTodos([{ content: "旧任务", status: "pending" }]),
    { role: "assistant", text: "继续" },
    withTodos([
      { content: "检查输出", status: "completed" },
      { content: "整理结论", status: "pending" },
    ]),
  ];

  assert.deepEqual(todosFromHistory(history), [
    { content: "检查输出", status: "completed" },
    { content: "整理结论", status: "pending" },
  ]);
});

test("没有任务结果时返回空列表，不继承其他字段", async () => {
  const todosFromHistory = await loadProjection();
  assert.deepEqual(todosFromHistory([{ role: "user", text: "你好" }, { output: { content: [] } }]), []);
  assert.deepEqual(todosFromHistory(undefined), []);
});

const assert = require("node:assert/strict");
const { test } = require("node:test");

// 投影函数不依赖 DOM，可直接在 Node 中导入。
async function loadProjection() {
  const module = await import("../../src/renderer/components/todo-dock.js");
  return module.todosFromHistory;
}

const withTodos = (todos) => ({ output: { toolName: "todo_write", todos } });
const withToolTodos = (toolName, todos) => ({ output: { toolName, todos } });

test("历史投影取当前请求里最后一条 todo_write 结果", async () => {
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

test("新的用户请求会清空上一轮清单，本轮未写任务时为空", async () => {
  const todosFromHistory = await loadProjection();
  const history = [
    { role: "user", text: "第一轮" },
    withTodos([{ content: "上一轮任务", status: "in_progress" }]),
    { role: "assistant", text: "第一轮完成" },
    { role: "user", text: "第二轮" },
    { role: "assistant", text: "第二轮还没写任务" },
  ];

  assert.deepEqual(todosFromHistory(history), []);
});

test("只接受 todo_write 的清单，其他工具的同名字段不覆盖", async () => {
  const todosFromHistory = await loadProjection();
  const history = [
    { role: "user", text: "开始" },
    withToolTodos("read", [{ content: "伪造任务", status: "pending" }]),
    withTodos([{ content: "真实任务", status: "in_progress" }]),
    withToolTodos("bash", [{ content: "另一个伪造任务", status: "completed" }]),
  ];

  assert.deepEqual(todosFromHistory(history), [
    { content: "真实任务", status: "in_progress" },
  ]);
});

test("没有任务结果时返回空列表，不继承其他字段", async () => {
  const todosFromHistory = await loadProjection();
  assert.deepEqual(todosFromHistory([{ role: "user", text: "你好" }, { output: { content: [] } }]), []);
  assert.deepEqual(todosFromHistory(undefined), []);
});

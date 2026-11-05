import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// 任务清单只随工具调用保存；每次整表替换，状态由这次调用的参数唯一决定。
export const todoWriteTool = defineTool({
  name: "todo_write",
  label: "任务清单",
  description:
    "整表替换当前任务清单，用于多步工作中记录进度。每次调用提交完整列表；清单显示在输入框上方，供你和用户同步当前计划。",
  promptSnippet: "todo_write: 维护一份可见的任务清单，每次调用整表替换",
  promptGuidelines: [
    "多步工作开始时先列出任务；每完成一项或进入下一项前立即调用 todo_write 更新完整列表，不要只在开始时和全部结束后各提交一次。",
    "当前 in_progress 项完成后，先把该项改为 completed，再把下一项设为 in_progress，然后继续执行；不要等所有内容都做完再一次性提交完成状态。",
    "工具返回且对应步骤已经结束时，先更新任务清单，再调用下一个工具。",
    "同时最多保留一个 in_progress 任务，除非这些工作确实在并行进行。",
  ],
  parameters: Type.Object({
    todos: Type.Array(
      Type.Object({
        content: Type.String({ description: "一句话任务描述" }),
        status: Type.Union(
          [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
          { description: "任务状态" },
        ),
      }),
      { description: "完整任务列表，按执行顺序排列；空数组表示清空" },
    ),
  }),

  async execute(_toolCallId, params) {
    const todos = [];
    const seen = new Set();
    for (const todo of params.todos ?? []) {
      const content = todo.content.trim();
      if (content === "") throw new Error("invalid todos: `content` 不能为空");
      if (seen.has(content)) throw new Error(`invalid todos: 重复的任务 ${JSON.stringify(content)}`);
      seen.add(content);
      todos.push({ content, status: todo.status });
    }

    const counts = { pending: 0, in_progress: 0, completed: 0 };
    for (const todo of todos) counts[todo.status] += 1;

    return {
      content: [{
        type: "text",
        text: `已更新任务清单：${counts.pending} 待处理，${counts.in_progress} 进行中，${counts.completed} 已完成。`,
      }],
      // details 供页面任务栏读取；不包含参数之外的额外状态。
      details: { todos },
    };
  },
});

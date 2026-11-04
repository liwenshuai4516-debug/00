// 任务清单来自 todo_write 的工具结果；页面只负责展示，不另存一份状态。
// 清单只代表当前这次用户请求：新请求开始或切换会话时先清空，历史也只恢复最后一段请求。
const STATUS_LABELS = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
};

// 从最新一段用户消息之后取最后一条 todo_write；上一轮的清单不延续到新请求。
export function todosFromHistory(history) {
  let latest = [];
  for (const item of history ?? []) {
    if (item?.role === "user") latest = [];
    const output = item?.output;
    if (output?.toolName === "todo_write" && Array.isArray(output.todos)) latest = output.todos;
  }
  return latest;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 默认折叠，面板只在有任务时出现；展开状态不写入持久化配置。
export function createTodoDock(root) {
  let todos = [];
  let collapsed = true;
  let sessionId = "";
  // 展开状态按会话记忆：切走再回来保持原样，不同会话互不影响。
  const expandedBySession = new Map();

  const header = element("button", "todo-dock-header");
  header.type = "button";
  header.setAttribute("aria-expanded", "false");

  const title = element("span", "todo-dock-title", "任务");
  const progress = element("span", "todo-dock-progress");
  const chevron = element("span", "todo-dock-chevron");
  chevron.setAttribute("aria-hidden", "true");

  header.append(title, progress, chevron);

  const list = element("ul", "todo-dock-list");
  list.hidden = true;

  // 组件自带样式类，挂载点只提供一个空容器。
  root.classList.add("todo-dock");
  root.replaceChildren(header, list);

  header.addEventListener("click", () => {
    collapsed = !collapsed;
    if (sessionId !== "") expandedBySession.set(sessionId, !collapsed);
    syncOpen();
  });

  function syncOpen() {
    header.setAttribute("aria-expanded", String(!collapsed));
    list.hidden = collapsed;
    chevron.textContent = collapsed ? "▸" : "▾";
  }

  function render() {
    root.hidden = todos.length === 0;
    if (todos.length === 0) {
      progress.textContent = "";
      list.replaceChildren();
      syncOpen();
      return;
    }

    const counts = { pending: 0, in_progress: 0, completed: 0 };
    for (const todo of todos) counts[todo.status] += 1;
    // 零计数的分段不显示，避免出现没有意义的“0 已完成”。
    progress.textContent = [
      counts.completed > 0 ? `${counts.completed} 已完成` : "",
      counts.in_progress > 0 ? `${counts.in_progress} 进行中` : "",
      counts.pending > 0 ? `${counts.pending} 待处理` : "",
    ].filter(Boolean).join(" · ");

    list.replaceChildren(...todos.map((todo) => {
      const item = element("li", "todo-dock-item");
      item.dataset.status = todo.status;
      const dot = element("span", "todo-dock-dot");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", STATUS_LABELS[todo.status]);
      item.append(dot, element("span", "todo-dock-content", todo.content));
      return item;
    }));
    syncOpen();
  }

  function setTodos(next) {
    todos = Array.isArray(next) ? next : [];
    render();
  }

  render();

  return {
    // 切换会话时恢复该会话上次的展开状态，未记录过则保持折叠。
    // 先清空上一个会话的清单，等历史按当前请求重建，避免短暂串台。
    setSession(next) {
      const id = typeof next === "string" ? next : "";
      if (id === sessionId) return;
      sessionId = id;
      collapsed = !(expandedBySession.get(id) ?? false);
      setTodos([]);
    },
    setTodos,
    clear: () => setTodos([]),
    showHistory: (history) => setTodos(todosFromHistory(history)),
    // 实时事件：每次用户请求开始时清空，只接受 todo_write 结束结果里的清单。
    accept: (event) => {
      if (event?.type === "agent_start") { setTodos([]); return; }
      if (event?.type !== "tool_execution_end" || event.toolName !== "todo_write") return;
      const next = event.result?.todos;
      if (Array.isArray(next)) setTodos(next);
    },
  };
}

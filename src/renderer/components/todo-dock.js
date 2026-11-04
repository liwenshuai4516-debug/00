// 任务清单来自 todo_write 的工具结果；页面只负责展示，不另存一份状态。
const STATUS_LABELS = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
};

// 按时间顺序取最后一条带 todos 的工具结果；历史里没有则清单为空。
export function todosFromHistory(history) {
  let latest = [];
  for (const item of history ?? []) {
    const todos = item?.output?.todos;
    if (Array.isArray(todos)) latest = todos;
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
    setTodos,
    clear: () => setTodos([]),
    showHistory: (history) => setTodos(todosFromHistory(history)),
    // 实时事件：只接受工具结束结果里的清单，其他事件不改变面板。
    accept: (event) => {
      if (event?.type !== "tool_execution_end") return;
      const next = event.result?.todos;
      if (Array.isArray(next)) setTodos(next);
    },
  };
}

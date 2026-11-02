// 只负责目录分组与会话列表展示；打开会话仍由 renderer.js 处理。
export function createSessionList(container, onSelect, onOpenProject) {
  const buttons = new Map();
  const projectButtons = [];
  const collapsed = new Set();
  let activeId = "";
  let busy = false;
  let sessions = [];
  let projects = [];
  let query = "";

  function setActive(id) {
    activeId = id;

    for (const [sessionId, button] of buttons) {
      if (sessionId === activeId) {
        button.setAttribute("aria-current", "true");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }

  function setBusy(value) {
    busy = value;
    container.setAttribute("aria-busy", String(busy));

    for (const button of buttons.values()) {
      button.disabled = busy;
    }
    for (const button of projectButtons) button.disabled = busy;
  }

  function draw() {
    buttons.clear();
    projectButtons.length = 0;
    container.replaceChildren();

    // filter 创建新数组，排序不会改动主进程传来的列表。
    const visibleSessions = sessions
      .filter((session) => session.title.toLowerCase().includes(query))
      .sort((first, second) => second.updatedAt - first.updatedAt);
    const groups = new Map();

    for (const session of visibleSessions) {
      // 使用完整目录作为键，同名文件夹不会被合并。
      const key = session.workspaceDir;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }

    const projectsByDirectory = new Map(projects.map((project) => [project.workspaceDir, project]));
    // 已有对话仍按最近活动排序；没有对话的新项目也能从同一区域打开。
    if (!query) {
      for (const project of projects) {
        if (!groups.has(project.workspaceDir)) groups.set(project.workspaceDir, []);
      }
    }

    // 首次遇到的会话就是组内最新会话，分组也按最近活动排列。
    for (const [workspaceDir, groupSessions] of groups) {
      const group = document.createElement("details");
      group.className = "session-group";
      // 搜索时展开命中分组，不覆盖搜索前的折叠选择。
      group.open = Boolean(query) || !collapsed.has(workspaceDir);

      const summary = document.createElement("summary");
      summary.title = workspaceDir || "未记录工作目录";

      const project = projectsByDirectory.get(workspaceDir);
      const name = document.createElement(project ? "button" : "span");
      name.className = "session-group-name";
      name.textContent = project?.name || (workspaceDir
        ? workspaceDir.split(/[\\/]/).filter(Boolean).at(-1) || workspaceDir
        : "未分类历史");
      if (project) {
        name.type = "button";
        name.classList.add("session-project-open");
        name.disabled = busy;
        name.setAttribute("aria-label", `打开项目：${project.name}`);
        name.addEventListener("click", (event) => {
          // 名称用于打开项目，左侧箭头仍由原生 summary 控制展开。
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onOpenProject(project);
        });
        projectButtons.push(name);
      }

      const count = document.createElement("span");
      count.className = "session-group-count";
      count.textContent = String(groupSessions.length);
      count.setAttribute("aria-label", `${groupSessions.length} 个对话`);

      const location = document.createElement("span");
      location.className = "session-group-path";
      location.textContent = workspaceDir || "未记录工作目录";
      summary.append(name, count, location);

      // 原生 summary 的鼠标和键盘操作都会触发 click。
      // 在默认展开动作前记住下一状态，避免异步 toggle 与重绘交错。
      summary.addEventListener("click", () => {
        if (query) return;
        if (group.open) collapsed.add(workspaceDir);
        else collapsed.delete(workspaceDir);
      });

      const items = document.createElement("div");
      items.className = "session-group-items";

      for (const session of groupSessions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = session.title;
        button.title = session.title;
        button.disabled = busy;

        button.addEventListener("click", () => {
          // 展示归组不改变会话绑定，也不能绕过忙碌检查。
          if (busy || session.id === activeId) return;
          onSelect(session.id);
        });

        buttons.set(session.id, button);
        items.appendChild(button);
      }

      group.append(summary, items);
      container.appendChild(group);
    }

    if (!groups.size) {
      const empty = document.createElement("p");
      empty.className = "session-list-empty";
      empty.textContent = sessions.length
        ? "没有匹配的对话，试试其他关键词。"
        : "暂无历史对话，发送消息后会出现在这里。";
      container.appendChild(empty);
    }

    setActive(activeId);
  }

  function render(nextSessions, currentId) {
    sessions = nextSessions;
    activeId = currentId;
    draw();
  }

  function setQuery(value) {
    query = value.trim().toLowerCase();
    draw();
  }

  function setProjects(value) {
    projects = value;
    draw();
  }

  return { render, setActive, setBusy, setQuery, setProjects };
}

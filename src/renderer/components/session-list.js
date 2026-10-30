// 只负责会话列表展示；打开会话由 renderer.js 处理。
export function createSessionList(container, onSelect) {
  const buttons = new Map();
  let activeId = "";
  let busy = false;
  let sessions = [];
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
  }

  function draw() {
    buttons.clear();
    container.replaceChildren();

    // 只匹配标题，保留原有排序；空查询显示全部会话。
    const visibleSessions = sessions.filter((session) =>
      session.title.toLowerCase().includes(query),
    );

    for (const session of visibleSessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = session.title;
      button.title = session.title;
      button.disabled = busy;

      button.addEventListener("click", () => {
        // 筛选不能绕过当前会话判断和忙碌状态。
        if (busy || session.id === activeId) return;
        onSelect(session.id);
      });

      buttons.set(session.id, button);
      container.appendChild(button);
    }

    if (!visibleSessions.length) {
      const empty = document.createElement("p");
      empty.className = "session-list-empty";

      // 区分没有历史记录和搜索没有命中。
      empty.textContent = sessions.length
        ? "没有匹配的对话，试试其他关键词。"
        : "暂无历史对话，发送消息后会出现在这里。";

      container.appendChild(empty);
    }

    // 隐藏当前会话不会改变它；重新显示时仍正确标记。
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

  return { render, setActive, setBusy, setQuery };
}
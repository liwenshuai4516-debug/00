// 只展示主进程给出的列表；读取、保存和恢复由页面回调统一调度。
export function createUnsentSessionList(container, onOpen, onRefresh) {
  let busy = false;
  let loading = false;
  let activeId = "";
  const buttons = new Map();
  container.classList.add("unsent-session-list");
  container.setAttribute("aria-label", "当前工作目录的未发送对话");

  const header = document.createElement("div");
  header.className = "unsent-list-header";
  const heading = document.createElement("h3");
  heading.textContent = "未发送";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "unsent-list-refresh";
  refreshButton.textContent = "刷新";
  refreshButton.setAttribute("aria-label", "刷新当前目录的未发送对话");
  header.append(heading, refreshButton);

  const status = document.createElement("p");
  status.className = "unsent-list-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  status.textContent = "尚未读取未发送输入。";
  const items = document.createElement("ul");
  items.className = "unsent-list-items";
  items.setAttribute("aria-label", "未发送对话");
  items.tabIndex = 0;
  items.hidden = true;
  container.replaceChildren(header, status, items);

  function updateControls() {
    const locked = busy || loading;
    container.setAttribute("aria-busy", String(locked));
    refreshButton.disabled = locked;
    for (const { button, blocked } of buttons.values()) {
      button.disabled = locked || blocked;
    }
  }

  function setBusy(value) {
    busy = value;
    updateControls();
  }

  function setActive(id) {
    activeId = id;
    for (const [sessionId, { button }] of buttons) {
      if (sessionId === id) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }

  function showLoading() {
    loading = true;
    // 先隐藏旧目录列表，迟到结果是否采用由页面负责判断。
    items.hidden = true;
    refreshButton.textContent = "读取中…";
    status.textContent = "正在读取当前目录的未发送输入……";
    updateControls();
  }

  function showError(message) {
    loading = false;
    buttons.clear();
    items.replaceChildren();
    items.hidden = true;
    heading.textContent = "未发送";
    refreshButton.textContent = "重试";
    status.textContent = `读取未完成：${message}`;
    updateControls();
  }

  function render(rows, currentId) {
    const focused = document.activeElement;
    const focusedId = container.contains(focused) && buttons.has(focused?.dataset.unsentId)
      ? focused.dataset.unsentId : undefined;
    loading = false;
    buttons.clear();
    items.replaceChildren();
    items.hidden = rows.length === 0;
    heading.textContent = `未发送（${rows.length}）`;
    status.textContent = rows.length
      ? "当前工作目录中保留的输入。"
      : "当前目录暂无未发送输入。";
    refreshButton.textContent = "刷新";

    for (const row of rows) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "unsent-list-open";
      button.dataset.unsentId = row.id;
      button.textContent = row.title;
      button.title = row.title;
      const blocked = Boolean(row.blockedReason);
      if (blocked) {
        // 禁用原因直接可见，也作为按钮的可访问名称，不能只藏在悬停提示里。
        button.setAttribute("aria-label", `${row.title}；${row.blockedReason}`);
        const reason = document.createElement("p");
        reason.className = "unsent-list-reason";
        reason.textContent = row.blockedReason;
        item.append(button, reason);
      } else item.append(button);
      button.addEventListener("click", () => {
        if (!container.contains(button) || busy || loading || blocked || row.id === activeId) return;
        onOpen(row.id);
      });
      buttons.set(row.id, { button, blocked });
      items.append(item);
    }
    setActive(currentId);
    updateControls();
    // 空闲刷新保留原行焦点；该行消失或被禁用时回到稳定的刷新按钮。
    if (focusedId !== undefined && !busy) {
      const next = buttons.get(focusedId)?.button;
      (next && !next.disabled ? next : refreshButton).focus();
    }
  }

  refreshButton.addEventListener("click", () => {
    if (!busy && !loading) onRefresh();
  });
  updateControls();
  return { render, setActive, setBusy, showLoading, showError };
}
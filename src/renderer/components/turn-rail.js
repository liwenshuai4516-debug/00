// 轮次导航轨：按用户消息建立标记，点击跳转；滚动时高亮当前轮。
// 只读取已有消息节点，不参与历史渲染或发送。
const MIN_TURNS = 2;
const ACTIVE_OFFSET = 12;

export function createTurnRail(container, rail) {
  let turns = [];
  let active = -1;
  let frame;

  function labelOf(node, index) {
    const text = node.querySelector(".message-body")?.textContent ?? "";
    const line = text.split("\n").find((value) => value.trim() !== "")?.trim() ?? "";
    return line === "" ? `第 ${index + 1} 轮` : `第 ${index + 1} 轮：${line.slice(0, 60)}`;
  }

  function setActive(index) {
    if (index === active) return;
    active = index;
    for (const [position, button] of [...rail.children].entries()) {
      if (position === index) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }

  function updateActive() {
    if (turns.length === 0) return;
    // 已在底部时跟随最新一轮；上翻时按视口顶部所在轮次高亮。
    const gap = container.scrollHeight - container.clientHeight - container.scrollTop;
    if (gap <= 32) {
      setActive(turns.length - 1);
      return;
    }
    const top = container.getBoundingClientRect().top;
    let next = 0;
    for (const [index, node] of turns.entries()) {
      if (node.getBoundingClientRect().top - top <= ACTIVE_OFFSET) next = index;
      else break;
    }
    setActive(next);
  }

  function jumpTo(index) {
    const node = turns[index];
    if (!node) return;
    const top = node.getBoundingClientRect().top - container.getBoundingClientRect().top
      + container.scrollTop - ACTIVE_OFFSET;
    container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    setActive(index);
  }

  function refresh() {
    turns = [...container.querySelectorAll('.chat-message[data-role="user"]')];
    rail.replaceChildren(...turns.map((node, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "turn-rail__mark";
      button.dataset.index = String(index);
      button.title = labelOf(node, index);
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => jumpTo(index));
      return button;
    }));
    rail.hidden = turns.length < MIN_TURNS;
    active = -1;
    if (!rail.hidden) updateActive();
  }

  container.addEventListener("scroll", () => {
    if (rail.hidden || frame) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      updateActive();
    });
  }, { passive: true });

  window.addEventListener("resize", () => {
    if (!rail.hidden) updateActive();
  });

  return { refresh };
}

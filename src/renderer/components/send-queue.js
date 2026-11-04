// 生成中的待发送队列：只保存在页面内，当前请求结束后按顺序发送。
// 不调用 Pi 的 streamingBehavior：保持一次只有一个 prompt 的既有事件归属。
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createSendQueue(root, { onEdit, onSendNext } = {}) {
  const items = [];
  let serial = 0;
  let busy = false;

  function remove(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    return items.splice(index, 1)[0];
  }

  function render() {
    root.classList.add("send-queue");
    root.hidden = items.length === 0;
    if (items.length === 0) {
      root.replaceChildren();
      return;
    }

    const header = element("div", "send-queue__header");
    header.append(
      element("span", "send-queue__title", "待发送"),
      element("span", "send-queue__count", `${items.length} 条`),
    );

    const list = element("ol", "send-queue__list");
    for (const item of items) {
      const row = element("li", "send-queue__item");
      row.append(element("p", "send-queue__text", item.text));

      const actions = element("div", "send-queue__actions");
      const edit = element("button", "send-queue__action", "编辑");
      edit.type = "button";
      edit.addEventListener("click", () => {
        remove(item.id);
        render();
        onEdit?.(item.text);
      });
      const discard = element("button", "send-queue__action", "移除");
      discard.type = "button";
      discard.addEventListener("click", () => {
        remove(item.id);
        render();
      });
      actions.append(edit, discard);
      row.append(actions);
      list.append(row);
    }

    const footer = element("div", "send-queue__footer");
    if (!busy && typeof onSendNext === "function") {
      const send = element("button", "send-queue__send", "发送下一条");
      send.type = "button";
      send.addEventListener("click", () => onSendNext());
      footer.append(send);
    }

    root.replaceChildren(header, list, footer);
  }

  render();

  return {
    add(text) {
      const value = typeof text === "string" ? text.trim() : "";
      if (value === "") return null;
      const item = { id: `queue-${++serial}`, text: value };
      items.push(item);
      render();
      return item;
    },
    remove(id) {
      const removed = remove(id);
      render();
      return removed;
    },
    takeFirst() {
      const item = items.shift() ?? null;
      render();
      return item;
    },
    clear() {
      items.length = 0;
      render();
    },
    setBusy(value) {
      const next = value === true;
      if (next === busy) return;
      busy = next;
      render();
    },
    size: () => items.length,
    list: () => items.map((item) => ({ ...item })),
  };
}

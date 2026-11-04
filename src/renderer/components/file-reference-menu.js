// 输入框里的 @ 文件引用：只插入工作目录相对路径的纯文本，不做 chip。
// 搜索与边界在主进程完成，页面只负责识别光标前的 @ 片段和插入结果。
const TOKEN = /(?:^|[\s(（])@([^\s@]*)$/u;

export function createFileReferenceMenu({ input, menu, onStatus = () => {} }) {
  let open = false;
  let items = [];
  let active = -1;
  let start = -1;
  let query = "";
  let serial = 0;
  let timer;

  function setActive(index) {
    if (items.length === 0) return;
    active = (index + items.length) % items.length;
    for (const [position, node] of [...menu.children].entries()) {
      const selected = position === active;
      node.setAttribute("aria-selected", String(selected));
      node.classList.toggle("is-active", selected);
    }
    input.setAttribute("aria-activedescendant", `file-reference-option-${active}`);
    menu.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function close() {
    clearTimeout(timer);
    serial += 1;
    open = false;
    items = [];
    active = -1;
    start = -1;
    query = "";
    menu.hidden = true;
    menu.replaceChildren();
    input.removeAttribute("aria-activedescendant");
  }

  function render() {
    menu.replaceChildren(...items.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-reference-item";
      button.setAttribute("role", "option");
      button.id = `file-reference-option-${index}`;
      button.dataset.index = String(index);

      const isDirectory = item.type === "dir";
      button.dataset.type = isDirectory ? "dir" : "file";

      const name = document.createElement("span");
      name.className = "file-reference-name";
      name.textContent = item.name;
      if (isDirectory) {
        const badge = document.createElement("span");
        badge.className = "file-reference-badge";
        badge.textContent = "目录";
        name.append(badge);
      }
      const relative = document.createElement("span");
      relative.className = "file-reference-path";
      relative.textContent = isDirectory ? `${item.path}/` : item.path;
      button.append(name, relative);

      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => apply(index));
      return button;
    }));
    menu.hidden = false;
    open = true;
    setActive(0);
  }

  function apply(index) {
    const item = items[index];
    if (!item || start < 0) {
      close();
      return;
    }
    const caret = input.selectionStart;
    if (caret < start) {
      close();
      return;
    }
    const before = input.value.slice(0, start);
    const after = input.value.slice(caret);
    // 目录以斜杠结尾，方便模型和用户区分文件与目录。
    const inserted = `@${item.path}${item.type === "dir" ? "/" : ""} `;
    input.value = `${before}${inserted}${after}`;
    const position = before.length + inserted.length;
    input.setSelectionRange(position, position);
    close();
    // 走原有 input 事件，草稿保存与发送校验保持同一条链路。
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  async function fetchItems() {
    const request = ++serial;
    let result;
    try {
      result = await window.agent.searchWorkspaceFiles(query);
    } catch (error) {
      if (request === serial) {
        close();
        onStatus(error?.message ?? "文件搜索失败。");
      }
      return;
    }
    if (request !== serial) return;

    // 光标仍停在同一个 @ 片段上才展示结果，避免迟到响应覆盖新输入。
    const caret = input.selectionStart;
    const match = TOKEN.exec(input.value.slice(0, caret));
    if (!match || match[1] !== query) return;

    items = Array.isArray(result?.items) ? result.items : [];
    if (items.length === 0) {
      close();
      return;
    }
    render();
  }

  function update(event) {
    if (event?.isComposing || input.readOnly) {
      close();
      return;
    }
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret);
    const match = TOKEN.exec(before);
    if (!match) {
      close();
      return;
    }
    query = match[1];
    if (query.length > 120) {
      close();
      return;
    }
    start = caret - query.length - 1;
    clearTimeout(timer);
    timer = setTimeout(() => void fetchItems(), 120);
  }

  function handleKeydown(event) {
    if (!open || event.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active + (event.key === "ArrowDown" ? 1 : -1));
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      apply(active >= 0 ? active : 0);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  }

  // 点击输入框外收起菜单；点击输入框本身由 click 监听重新判断光标位置。
  document.addEventListener("pointerdown", (event) => {
    if (!open || event.target === input || menu.contains(event.target)) return;
    close();
  });

  return { update, handleKeydown, close, isOpen: () => open };
}

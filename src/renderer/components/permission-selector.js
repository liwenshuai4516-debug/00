// 输入框内的当前工具权限选择器；与「设置 → 通用 → 权限控制」共用同一份设置。
export function createPermissionSelector(element, api) {
  const trigger = element.querySelector("#permission-trigger");
  const menu = element.querySelector("#permission-menu");
  const label = element.querySelector("[data-permission-trigger-label]");
  let mode = "";
  let options = [];
  let busy = true;
  let saving = false;

  function current() {
    return options.find((item) => item.id === mode) ?? null;
  }

  function draw() {
    const item = current();
    const disabled = busy || saving || options.length === 0;
    trigger.disabled = disabled;
    element.setAttribute("aria-busy", String(disabled));
    label.textContent = item?.label ?? (busy ? "读取中" : "权限");
    trigger.title = item ? `工具权限：${item.label}。${item.description}` : "工具权限不可用";
    trigger.dataset.state = mode === "full-access" ? "risk" : "";
    menu.replaceChildren(...options.map((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "permission-choice";
      button.dataset.permissionMode = option.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(option.id === mode));
      button.disabled = saving;
      const title = document.createElement("span");
      title.className = "permission-choice__title";
      title.textContent = option.label;
      if (option.risk) {
        const risk = document.createElement("span");
        risk.className = "permission-choice__risk";
        risk.textContent = "高风险";
        title.append(risk);
      }
      const description = document.createElement("span");
      description.className = "permission-choice__description";
      description.textContent = option.description;
      const check = document.createElement("span");
      check.className = "permission-choice__check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = option.id === mode ? "✓" : "";
      button.append(title, description, check);
      button.addEventListener("click", () => void choose(option.id));
      return button;
    }));
  }

  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  function open() {
    if (trigger.disabled) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-selected="true"]')?.focus();
  }

  async function choose(next) {
    if (saving || next === mode) { close(); return; }
    if (next === "full-access" && mode !== "full-access") {
      const accepted = window.confirm("完全权限会跳过所有工具确认，包括命令和文件写入。只在明确信任当前任务时使用。是否继续？");
      if (!accepted) return;
    }
    close();
    saving = true;
    draw();
    try {
      const result = await api.savePermissionSettings(next, "session");
      mode = result?.mode ?? next;
      if (Array.isArray(result?.options)) options = result.options;
      window.dispatchEvent(new CustomEvent("permission-settings-changed", {
        detail: { mode, scope: result?.scope ?? "session", defaultMode: result?.defaultMode, options },
      }));
    } catch (error) {
      trigger.title = `工具权限保存失败：${error.message}`;
      trigger.dataset.state = "error";
    } finally {
      saving = false;
      draw();
    }
  }

  async function load() {
    busy = true;
    draw();
    try {
      const result = await api.readPermissionSettings();
      mode = result?.mode ?? "ask";
      options = Array.isArray(result?.options) ? result.options : [];
      element.hidden = options.length === 0;
    } catch {
      element.hidden = true;
    } finally {
      busy = false;
      draw();
    }
  }

  function onChanged(event) {
    if (!event.detail?.mode) return;
    mode = event.detail.mode;
    if (Array.isArray(event.detail.options)) options = event.detail.options;
    draw();
  }

  trigger.addEventListener("click", () => {
    if (menu.hidden) open();
    else close();
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener("keydown", (event) => {
    const choices = [...menu.querySelectorAll(".permission-choice:not(:disabled)")];
    const index = choices.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      trigger.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!choices.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      choices[(index + delta + choices.length) % choices.length].focus();
    }
  });
  function outside(event) {
    if (!element.contains(event.target)) close();
  }
  document.addEventListener("click", outside);
  window.addEventListener("permission-settings-changed", onChanged);
  void load();

  return {
    refresh: load,
    dispose() {
      document.removeEventListener("click", outside);
      window.removeEventListener("permission-settings-changed", onChanged);
    },
  };
}

// DSH 风格的模型选择：一个触发按钮 + 按提供商分组、可搜索的菜单。
// 同时保留一个隐藏的原生 select，供键盘/测试与既有页面状态读取同一份选择。

const LEVEL_LABELS = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "最高",
  max: "最大",
};

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function option(value, label) {
  return element("option", { value, text: label });
}

function keyOf(model) {
  return JSON.stringify([model.provider, model.id]);
}

export function createModelSelector(root, api, setPageBusy, refreshInfo) {
  const select = root.querySelector("select");
  const trigger = root.querySelector("#model-trigger");
  const triggerName = root.querySelector("[data-model-trigger-name]");
  const triggerEffort = root.querySelector("[data-model-trigger-effort]");
  const menu = root.querySelector("#model-menu");
  const search = root.querySelector("#model-search");
  const menuList = root.querySelector("#model-menu-list");
  const effortBox = root.querySelector("#model-effort");
  const effortList = root.querySelector("#model-effort-list");
  const status = root.querySelector('[role="status"]');
  const retryButton = root.querySelector("[data-retry]");

  let busy = true;
  let ready = false;
  let models = [];
  let info = { provider: "", modelId: "", thinkingLevel: "", thinkingLevels: [] };
  let currentKey = "";
  let sequence = 0;
  let open = false;
  let outsideHandler = null;

  function currentModel() {
    return models.find((model) => model.provider === info.provider && model.id === info.modelId)
      ?? models.find((model) => keyOf(model) === currentKey);
  }

  function effortLabel(level) {
    return LEVEL_LABELS[level] ?? level;
  }

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.hidden = !text;
    status.dataset.state = isError ? "error" : "";
  }

  function drawTrigger() {
    const model = currentModel();
    triggerName.textContent = model?.name || model?.id || (ready ? "选择模型" : "模型");
    const levels = info.thinkingLevels ?? [];
    triggerEffort.textContent = levels.length > 1 && info.thinkingLevel
      ? `· ${effortLabel(info.thinkingLevel)}`
      : "";
    trigger.disabled = busy || !ready;
    trigger.title = model ? `${model.provider}/${model.id}` : "选择模型";
    trigger.setAttribute("aria-label", model ? `当前模型 ${model.name || model.id}` : "选择模型");
    trigger.setAttribute("aria-busy", String(busy));
  }

  function populateSelect() {
    select.replaceChildren();
    const groups = new Map();
    for (const model of models) {
      if (!groups.has(model.provider)) {
        const group = document.createElement("optgroup");
        group.label = model.provider;
        select.append(group);
        groups.set(model.provider, group);
      }
      const node = option(keyOf(model), model.name || model.id);
      groups.get(model.provider).append(node);
    }
    currentKey = keyOf({ provider: info.provider, id: info.modelId });
    select.value = currentKey;
    if (select.selectedIndex < 0) {
      const unavailable = option("", "当前模型不可用，请重新选择");
      unavailable.disabled = true;
      select.prepend(unavailable);
      select.value = "";
    }
    select.disabled = busy || !ready;
  }

  function closeMenu({ focus = false } = {}) {
    if (!open) return;
    open = false;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (outsideHandler) {
      document.removeEventListener("pointerdown", outsideHandler);
      outsideHandler = null;
    }
    if (focus) trigger.focus();
  }

  function menuItems() {
    return [...menu.querySelectorAll(".model-menu__item, .model-effort__button")]
      .filter((node) => !node.hidden && !node.disabled);
  }

  function renderMenu() {
    const query = search.value.trim().toLowerCase();
    const groups = new Map();
    for (const model of models) {
      const haystack = `${model.provider} ${model.name ?? ""} ${model.id}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;
      if (!groups.has(model.provider)) groups.set(model.provider, []);
      groups.get(model.provider).push(model);
    }
    menuList.replaceChildren();
    if (!groups.size) {
      menuList.append(element("p", { class: "model-menu__empty", text: models.length ? "没有匹配的模型。" : "暂无可用模型。" }));
    }
    for (const [provider, items] of groups) {
      const group = element("section", { class: "model-menu__group" });
      group.append(element("p", { class: "model-menu__provider", text: provider }));
      for (const model of items) {
        const active = model.provider === info.provider && model.id === info.modelId;
        const button = element("button", {
          type: "button",
          class: "model-menu__item",
          role: "option",
          "aria-selected": String(active),
          dataset: { provider: model.provider, modelId: model.id },
          onclick: () => void choose(model),
        },
          element("span", { class: "model-menu__name", text: model.name || model.id }),
          model.id !== model.name ? element("code", { class: "model-menu__id", text: model.id }) : null,
          active ? element("span", { class: "model-menu__check", "aria-hidden": "true", text: "✓" }) : null,
        );
        group.append(button);
      }
      menuList.append(group);
    }

    const levels = info.thinkingLevels ?? [];
    effortBox.hidden = levels.length <= 1;
    effortList.replaceChildren(...levels.map((level) => {
      const active = level === info.thinkingLevel;
      const button = element("button", {
        type: "button",
        class: "model-effort__button",
        dataset: { level },
        "aria-pressed": String(active),
        onclick: () => void applyEffort(level),
        text: effortLabel(level),
      });
      return button;
    }));
  }

  function openMenu() {
    if (trigger.disabled || open) return;
    open = true;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.value = "";
    renderMenu();
    search.focus();
    outsideHandler = (event) => {
      if (!root.contains(event.target)) closeMenu();
    };
    document.addEventListener("pointerdown", outsideHandler);
  }

  async function switchModel(value) {
    if (!value || value === currentKey) return;
    let payload;
    try {
      payload = JSON.parse(value);
    } catch {
      return;
    }
    setPageBusy(true);
    setStatus("正在切换模型……");
    let prefix = "";
    try {
      await api.switchModel(payload[1], payload[0]);
    } catch (error) {
      prefix = `切换未完成：${error.message} `;
    } finally {
      await refresh(prefix);
      await refreshInfo();
      setPageBusy(false);
      trigger.focus();
    }
  }

  async function choose(model) {
    closeMenu();
    const value = keyOf(model);
    if (value === currentKey) return;
    select.value = value;
    await switchModel(value);
  }

  async function applyEffort(level) {
    if (level === info.thinkingLevel) {
      closeMenu({ focus: true });
      return;
    }
    closeMenu();
    setPageBusy(true);
    setStatus("正在保存思考强度……");
    try {
      await api.setThinkingLevel(level);
      await refresh();
      await refreshInfo();
      setStatus(`思考强度已切换为「${effortLabel(level)}」。`);
    } catch (error) {
      setStatus(`思考强度未切换：${error.message}`, true);
    } finally {
      setPageBusy(false);
    }
  }

  async function refresh(prefix = "") {
    const token = ++sequence;
    ready = false;
    setStatus(`${prefix}正在读取当前模型……`);
    drawTrigger();
    if (select) select.disabled = true;
    root.setAttribute("aria-busy", "true");
    try {
      const listing = await api.listModels();
      if (token !== sequence) return;
      models = Array.isArray(listing.models) ? listing.models : [];
      info = {
        provider: listing.provider ?? "",
        modelId: listing.modelId ?? "",
        thinkingLevel: typeof listing.thinkingLevel === "string" ? listing.thinkingLevel : "",
        thinkingLevels: Array.isArray(listing.thinkingLevels) ? listing.thinkingLevels : [],
      };
      currentKey = keyOf({ provider: info.provider, id: info.modelId });
      populateSelect();
      ready = models.length > 0;
      retryButton.hidden = ready;
      drawTrigger();
      if (open) renderMenu();
      setStatus(prefix || listing.warning || (ready ? "" : "没有可用模型，请在设置中配置供应商认证。"));
    } catch (error) {
      if (token !== sequence) return;
      models = [];
      info = { provider: "", modelId: "", thinkingLevel: "", thinkingLevels: [] };
      select.replaceChildren(option("", "模型暂不可用"));
      select.value = "";
      select.disabled = true;
      trigger.disabled = true;
      triggerName.textContent = "模型暂不可用";
      triggerEffort.textContent = "";
      retryButton.hidden = false;
      setStatus(`模型读取失败：${error.message}`, true);
    } finally {
      if (token === sequence) {
        root.setAttribute("aria-busy", "false");
        select.disabled = busy || !ready;
        drawTrigger();
      }
    }
  }

  function setBusy(value) {
    busy = value;
    trigger.disabled = value || !ready;
    select.disabled = value || !ready;
    retryButton.disabled = value;
    if (value) closeMenu();
    drawTrigger();
  }

  trigger.addEventListener("click", () => (open ? closeMenu({ focus: true }) : openMenu()));
  search.addEventListener("input", renderMenu);
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu({ focus: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = menuItems();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown"
      ? (index + 1 + items.length) % items.length
      : (index - 1 + items.length) % items.length;
    items[next].focus();
  });
  select.addEventListener("change", () => {
    if (select.disabled || !select.value || select.value === currentKey) return;
    void switchModel(select.value);
  });
  retryButton.addEventListener("click", () => {
    if (retryButton.disabled) return;
    void refresh();
  });

  return { refresh, setBusy };
}

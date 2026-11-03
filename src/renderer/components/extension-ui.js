function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createExtensionUi(api, input, options) {
  if (!api.onExtensionUi) return { setSession() {}, refresh() {}, ready: Promise.resolve() };
  const dialog = element("dialog");
  dialog.className = "extension-dialog";
  dialog.setAttribute("aria-label", "扩展交互");
  const form = element("form");
  const title = element("h2"), description = element("p"), fields = element("div"), countdown = element("p"), error = element("p");
  const actions = element("div");
  const cancel = element("button", "取消"), accept = element("button", "确定");
  cancel.type = "button";
  accept.type = "submit";
  actions.append(cancel, accept);
  form.append(title, description, fields, countdown, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  const notices = element("div");
  notices.className = "extension-notices";
  notices.setAttribute("role", "status");
  document.querySelector(".chat-main").append(notices);
  const above = element("div"), below = element("div");
  above.className = below.className = "extension-widgets";
  document.querySelector(".composer").before(above);
  document.querySelector(".composer").after(below);
  const states = new Map(), queued = new Map(), appliedEditors = new Map();
  let currentId, active, control, timer, composing = false;
  const originalTitle = document.title;

  function closeActive() {
    clearInterval(timer);
    composing = false;
    active = undefined;
    if (dialog.open) dialog.close();
    showNext();
  }

  function showNext() {
    if (active || queued.size === 0) return;
    active = queued.values().next().value;
    queued.delete(active.id);
    title.textContent = active.title;
    description.textContent = active.message ?? "";
    error.textContent = "";
    fields.replaceChildren();
    control = null;
    if (active.method === "select") {
      control = element("select");
      for (const value of active.options) {
        const option = element("option", value);
        option.value = value;
        control.append(option);
      }
    } else if (active.method !== "confirm") {
      control = element(active.method === "editor" ? "textarea" : "input");
      control.value = active.prefill ?? "";
      control.placeholder = active.placeholder ?? "";
      if (active.method === "editor") control.rows = 12;
    }
    if (control) {
      control.setAttribute("aria-label", active.title);
      fields.append(control);
    }
    const tick = () => { countdown.textContent = active?.expiresAt ? `剩余 ${Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000))} 秒` : ""; };
    tick();
    timer = setInterval(tick, 250);
    dialog.showModal();
    (control ?? cancel).focus();
  }

  async function respond(cancelled) {
    if (!active || composing) return;
    const id = active.id;
    try {
      await api.respondExtensionUi({ id, cancelled, value: active.method === "confirm" ? true : control?.value });
    } catch (reason) {
      if (active?.id === id) error.textContent = `提交失败，可重试：${reason.message}`;
    }
  }
  form.addEventListener("compositionstart", () => { composing = true; });
  form.addEventListener("compositionend", () => { composing = false; });
  form.addEventListener("submit", event => { event.preventDefault(); if (!event.isComposing) void respond(false); });
  cancel.addEventListener("click", () => { void respond(true); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); void respond(true); });

  function render() {
    above.replaceChildren();
    below.replaceChildren();
    const state = states.get(currentId) ?? new Map();
    document.title = state.get("setTitle")?.title || originalTitle;
    for (const event of state.values()) {
      if (event.method === "setStatus" && event.statusText !== undefined) above.append(element("p", event.statusText));
      if (event.method === "setWidget" && event.widgetLines) {
        const node = element("pre", event.widgetLines.join("\n"));
        (event.widgetPlacement === "belowEditor" ? below : above).append(node);
      }
    }
    const edit = state.get("setEditorText");
    if (edit && appliedEditors.get(currentId) !== edit.id && options.canEdit()) {
      // 延迟到输入法组词结束且会话输入绑定完成，再走原有输入保存链路。
      appliedEditors.set(currentId, edit.id);
      input.value = edit.text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const expanded = state.get("setToolsExpanded")?.expanded;
    if (expanded !== undefined) for (const node of document.querySelectorAll(".tool-message")) node.open = expanded;
  }

  const observer = new MutationObserver(() => {
    const expanded = states.get(currentId)?.get("setToolsExpanded")?.expanded;
    if (expanded !== undefined) for (const node of document.querySelectorAll(".tool-message")) node.open = expanded;
  });
  observer.observe(document.querySelector("#messages"), { childList: true });
  input.addEventListener("input", () => api.syncExtensionEditor(currentId, input.value));
  input.addEventListener("compositionend", () => queueMicrotask(render));

  const unsubscribe = api.onExtensionUi(event => {
    if (["select", "confirm", "input", "editor"].includes(event.method)) {
      if (active?.id !== event.id) queued.set(event.id, event);
      showNext();
      return;
    }
    if (event.method === "dismiss") {
      queued.delete(event.id);
      if (active?.id === event.id) closeActive();
      return;
    }
    if (event.method === "clear") {
      states.delete(event.sessionId);
      appliedEditors.delete(event.sessionId);
    } else if (event.method === "notify") {
      const note = element("p", event.message);
      note.dataset.type = event.notifyType;
      notices.append(note);
      while (notices.childElementCount > 5) notices.firstElementChild.remove();
    } else {
      const state = states.get(event.sessionId) ?? new Map();
      states.set(event.sessionId, state);
      const key = event.statusKey ? `status:${event.statusKey}` : event.widgetKey ? `widget:${event.widgetKey}` : event.method;
      state.set(key, event);
    }
    render();
  });
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    unsubscribe();
    observer.disconnect();
    dialog.remove();
  }, { once: true });
  return {
    ready: api.extensionUiReady(),
    setSession(sessionId) {
      currentId = sessionId;
      api.syncExtensionEditor(sessionId, input.value);
      render();
    },
    refresh: render,
  };
}

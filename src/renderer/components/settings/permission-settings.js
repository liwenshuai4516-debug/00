// 通用设置 → 权限控制。只读取/保存应用层工具门禁模式，不接触模型或会话内容。
const SCOPE_LABELS = {
  session: "仅当前会话",
  workspace: "当前项目所有会话",
  default: "新会话默认",
};

export function createPermissionSettings(panel, api, setPageBusy) {
  const optionsBox = panel.querySelector("[data-permission-options]");
  const badge = panel.querySelector("[data-permission-state]");
  const warning = panel.querySelector("[data-permission-warning]");
  const status = panel.querySelector("[data-permission-status]");
  const scopeSelect = panel.querySelector("[data-permission-scope]");
  const scopeNote = panel.querySelector("[data-permission-scope-note]");
  let busy = true;
  let loading = false;
  let sequence = 0;
  let mode = "";
  let scope = "session";
  let defaultMode = "ask";
  let options = [];

  function scopeLabel(value) {
    return SCOPE_LABELS[value] ?? "当前范围";
  }

  function draw() {
    const disabled = busy || loading;
    const current = options.find((item) => item.id === mode);
    badge.textContent = current?.label ?? (loading ? "读取中" : "未选择");
    badge.dataset.state = mode === "full-access" ? "warn" : mode ? "ok" : "";
    warning.hidden = mode !== "full-access";
    if (scopeSelect) {
      scopeSelect.value = scope;
      scopeSelect.disabled = disabled;
    }
    if (scopeNote) {
      scopeNote.textContent = loading
        ? "权限来源：读取中。"
        : `当前生效：${scopeLabel(scope)}；新会话默认：${options.find((item) => item.id === defaultMode)?.label ?? defaultMode}。`;
    }
    optionsBox.replaceChildren(...options.map((item) => {
      const label = document.createElement("label");
      label.className = "permission-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "permission-mode";
      input.value = item.id;
      input.checked = item.id === mode;
      input.disabled = disabled;
      input.addEventListener("change", () => { if (input.checked) void choose(item.id); });
      const body = document.createElement("span");
      body.className = "permission-option__body";
      const title = document.createElement("span");
      title.className = "permission-option__title";
      title.textContent = item.label;
      if (item.risk) {
        const risk = document.createElement("span");
        risk.className = "permission-option__risk";
        risk.textContent = "高风险";
        title.append(risk);
      }
      const description = document.createElement("span");
      description.className = "permission-option__description";
      description.textContent = item.description;
      body.append(title, description);
      label.append(input, body);
      return label;
    }));
  }

  async function show() {
    const token = ++sequence;
    loading = true;
    draw();
    status.textContent = "正在读取权限设置……";
    try {
      const result = await api.readPermissionSettings();
      if (token !== sequence) return;
      mode = result?.mode ?? "ask";
      scope = result?.scope ?? "session";
      defaultMode = result?.defaultMode ?? "ask";
      options = Array.isArray(result?.options) ? result.options : [];
      status.textContent = "";
    } catch (error) {
      if (token !== sequence) return;
      mode = "";
      options = [];
      status.textContent = `读取失败：${error.message}`;
      status.dataset.state = "error";
    } finally {
      if (token === sequence) {
        loading = false;
        draw();
      }
    }
  }

  async function choose(next, nextScope = scopeSelect?.value ?? scope) {
    if (busy || loading || !next) return;
    const targetScope = SCOPE_LABELS[nextScope] ? nextScope : scope;
    if (next === mode && targetScope === scope) return;
    setPageBusy(true);
    status.textContent = "正在保存权限设置……";
    status.dataset.state = "";
    try {
      const result = await api.savePermissionSettings(next, targetScope);
      mode = result?.mode ?? next;
      scope = result?.scope ?? targetScope;
      defaultMode = result?.defaultMode ?? defaultMode;
      options = Array.isArray(result?.options) ? result.options : options;
      const label = options.find((item) => item.id === mode)?.label ?? mode;
      status.textContent = targetScope === "default" && scope !== "default"
        ? `已设置新会话默认权限为「${label}」；当前会话仍按「${scopeLabel(scope)}」生效。`
        : `已切换为「${label}」（${scopeLabel(scope)}），对后续工具调用立即生效。`;
      window.dispatchEvent(new CustomEvent("permission-settings-changed", {
        detail: { mode, scope, defaultMode, options },
      }));
    } catch (error) {
      status.textContent = `保存失败：${error.message}`;
      status.dataset.state = "error";
    } finally {
      setPageBusy(false);
      draw();
    }
  }

  scopeSelect?.addEventListener("change", () => {
    void choose(mode, scopeSelect.value);
  });

  function setBusy(value) {
    busy = value;
    draw();
  }

  function hide() {
    status.textContent = "";
    status.dataset.state = "";
  }

  function onChanged(event) {
    if (!event.detail?.mode) return;
    mode = event.detail.mode;
    if (event.detail.scope) scope = event.detail.scope;
    if (event.detail.defaultMode) defaultMode = event.detail.defaultMode;
    if (Array.isArray(event.detail.options)) options = event.detail.options;
    draw();
  }

  window.addEventListener("permission-settings-changed", onChanged);
  draw();
  return { show, hide, setBusy };
}

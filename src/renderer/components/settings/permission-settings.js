// 通用设置 → 权限控制。只读取/保存应用层工具门禁模式，不接触模型或会话内容。
export function createPermissionSettings(panel, api, setPageBusy) {
  const optionsBox = panel.querySelector("[data-permission-options]");
  const badge = panel.querySelector("[data-permission-state]");
  const warning = panel.querySelector("[data-permission-warning]");
  const status = panel.querySelector("[data-permission-status]");
  let busy = true;
  let loading = false;
  let sequence = 0;
  let mode = "";
  let options = [];

  function draw() {
    const disabled = busy || loading;
    const current = options.find((item) => item.id === mode);
    badge.textContent = current?.label ?? (loading ? "读取中" : "未选择");
    badge.dataset.state = mode === "full-access" ? "warn" : mode ? "ok" : "";
    warning.hidden = mode !== "full-access";
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

  async function choose(next) {
    if (busy || loading || next === mode) return;
    setPageBusy(true);
    status.textContent = "正在保存权限设置……";
    status.dataset.state = "";
    try {
      const result = await api.savePermissionSettings(next);
      mode = result?.mode ?? next;
      options = Array.isArray(result?.options) ? result.options : options;
      status.textContent = `已切换为「${options.find((item) => item.id === mode)?.label ?? mode}」，对后续工具调用立即生效。`;
    } catch (error) {
      status.textContent = `保存失败：${error.message}`;
      status.dataset.state = "error";
    } finally {
      setPageBusy(false);
      draw();
    }
  }

  function setBusy(value) {
    busy = value;
    draw();
  }

  function hide() {
    status.textContent = "";
    status.dataset.state = "";
  }

  draw();
  return { show, hide, setBusy };
}

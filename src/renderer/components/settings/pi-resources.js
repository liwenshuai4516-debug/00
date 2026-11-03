export function createPiResourcesPanel(dialog, api, setPageBusy, insertText) {
  const panel = dialog.querySelector("#settings-resources-panel");
  const list = panel.querySelector("[data-pi-packages]");
  const resources = panel.querySelector("[data-pi-resources]");
  const status = panel.querySelector("[data-pi-status]");
  const source = panel.querySelector("[data-pi-source]");
  const scope = panel.querySelector("[data-pi-scope]");
  const filterEditor = panel.querySelector("[data-pi-filters]");
  let busy = true, running = false, token = 0, selectedFilter;
  function update() {
    for (const control of panel.querySelectorAll("button, input, select, textarea")) control.disabled = busy || running;
  }
  function button(label, action) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.addEventListener("click", action);
    return node;
  }
  async function refresh() {
    const sequence = ++token;
    const data = await api.listPiResources();
    if (sequence !== token || !dialog.open) return;
    list.replaceChildren();
    resources.replaceChildren();
    for (const item of data.packages) {
      const row = document.createElement("div");
      row.className = "pi-package-row";
      const name = document.createElement("p");
      name.textContent = `${item.source} · ${item.scope === "user" ? "个人" : "项目"} · ${item.installedPath ? "已安装" : "未安装"}${item.filtered ? " · 已筛选" : ""}`;
      row.append(name,
        button("更新", () => void operate({ action: "update", ...item })),
        button("移除", () => {
          if (!row.querySelector("[data-confirm-remove]")) {
            const confirm = button("确认移除", () => void operate({ action: "remove", ...item }));
            confirm.dataset.confirmRemove = "";
            row.append(confirm);
          }
        }),
        button("筛选资源", () => {
          selectedFilter = item;
          filterEditor.value = JSON.stringify(item.filters, null, 2);
          filterEditor.parentElement.hidden = false;
        }),
      );
      list.append(row);
    }
    for (const [kind, entries] of [["技能", data.skills], ["提示词模板", data.prompts]]) {
      const heading = document.createElement("h3");
      heading.textContent = kind;
      resources.append(heading);
      for (const item of entries) {
        const row = document.createElement("p");
        row.append(button(item.name, () => {
          try {
            insertText(kind === "技能" ? `/skill:${item.name} ` : `/${item.name} `);
            dialog.querySelector("[data-close]").click();
          } catch (error) {
            status.textContent = `无法插入：${error.message}`;
          }
        }));
        row.append(document.createTextNode(` ${item.description ?? ""}`));
        resources.append(row);
      }
    }
    const details = document.createElement("pre");
    details.textContent = [
      "已加载扩展", ...data.extensions.map(item => item.path), "加载诊断",
      ...data.diagnostics.map(item => `${item.type}: ${item.message}`),
    ].join("\n");
    resources.append(details);
    status.textContent = `当前目录：${data.cwd}；项目资源${data.projectTrusted ? "已信任" : "未信任"}。`;
    update();
  }
  async function operate(request) {
    if (busy || running) return;
    running = true;
    setPageBusy(true);
    update();
    status.textContent = "正在处理，请等待……";
    try {
      const result = await api.managePiPackage(request);
      await refresh();
      status.textContent = result.needsReload ? "配置已保存；点击“重载资源”应用到当前会话。" :
        result.updates ? `检查完成，${result.updates.length} 个来源可更新。` : "资源已重新加载。";
    } catch (error) {
      status.textContent = `操作未完成：${error.message}。安装器可能已改动磁盘，请重新读取列表核对。`;
    } finally {
      running = false;
      setPageBusy(false);
      update();
    }
  }
  panel.querySelector("[data-pi-install]").addEventListener("click", () => void operate({ action: "install", source: source.value.trim(), scope: scope.value }));
  panel.querySelector("[data-pi-reload]").addEventListener("click", () => void operate({ action: "reload" }));
  panel.querySelector("[data-pi-check]").addEventListener("click", () => void operate({ action: "check" }));
  panel.querySelector("[data-pi-refresh]").addEventListener("click", () => { if (!busy && !running) void show(); });
  panel.querySelector("[data-pi-save-filters]").addEventListener("click", () => {
    try {
      const filters = JSON.parse(filterEditor.value);
      void operate({ action: "filter", source: selectedFilter.source, scope: selectedFilter.scope, filters });
    } catch (error) { status.textContent = `筛选格式无效：${error.message}`; }
  });
  const unsubscribe = api.onPiPackageProgress?.(event => {
    if (running) status.textContent = `${event.action}: ${event.source} ${event.message ?? event.type}`;
  });
  window.addEventListener("pagehide", () => unsubscribe?.(), { once: true });
  dialog.addEventListener("close", () => { token += 1; });
  async function show() {
    if (!api.listPiResources) { status.textContent = "当前运行环境尚未提供资源接口。"; return; }
    try { await refresh(); } catch (error) { status.textContent = `读取失败：${error.message}`; }
  }
  update();
  return { show, isSaving: () => running, setBusy(value) { busy = value; update(); } };
}

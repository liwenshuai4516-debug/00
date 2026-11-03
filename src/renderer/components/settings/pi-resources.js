import { getPiExtensionLabel, translatePiDescription, translatePiDiagnostic } from "./pi-resource-translations.js";

export function createPiResourcesPanel(dialog, api, setPageBusy, insertText) {
  const panel = dialog.querySelector("#settings-resources-panel");
  const list = panel.querySelector("[data-pi-packages]");
  const status = panel.querySelector("[data-pi-status]");
  const source = panel.querySelector("[data-pi-source]");
  const scope = panel.querySelector("[data-pi-scope]");
  const filterEditor = panel.querySelector("[data-pi-filters]");
  const filterPanel = panel.querySelector("[data-pi-filter-editor]");
  const categories = [...panel.querySelectorAll("[data-pi-kind]")];
  let busy = true, running = false, loading = false, token = 0, selectedFilter;
  let projectTrusted = false, needsReload = false, sessionId;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(label, action, className = "") {
    const element = node("button", className, label);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  }
  function update() {
    for (const control of panel.querySelectorAll("button, input, select, textarea")) {
      control.disabled = busy || running || loading || (control.hasAttribute("data-requires-trust") && !projectTrusted);
    }
    panel.querySelector("[data-pi-install]").disabled ||= !source.value.trim();
    panel.querySelector("[data-pi-reload-notice]").hidden = !needsReload;
    panel.setAttribute("aria-busy", String(loading || running));
  }
  function report(text, state = "") {
    status.textContent = text;
    status.dataset.state = state;
  }
  function selectCategory(kind) {
    for (const category of categories) category.setAttribute("aria-pressed", String(category.dataset.piKind === kind));
    for (const view of panel.querySelectorAll("[data-pi-view]")) view.hidden = view.dataset.piView !== kind;
  }
  categories.forEach(category => category.addEventListener("click", () => {
    if (!busy && !running && !loading) selectCategory(category.dataset.piKind);
  }));
  function empty(container, title, description) {
    const state = node("div", "pi-resource-empty");
    state.append(node("strong", "", title), node("p", "", description));
    container.append(state);
  }
  function uninstallButton(container, item, label = "卸载") {
    const trigger = button(label, () => {
      if (container.querySelector("[data-confirm-remove]")) return;
      const confirm = node("div", "pi-remove-confirm");
      const remove = button("确认卸载", () => void operate({ action: "remove", source: item.source, scope: item.scope }));
      remove.dataset.confirmRemove = "";
      if (item.scope === "project") remove.dataset.requiresTrust = "";
      confirm.append(
        node("p", "", `从${item.scope === "user" ? "个人" : "当前项目"}范围卸载整个包 ${item.source}？该包提供的技能、模板、扩展和主题会一并受影响。`),
        node("p", "", "npm 包和 Git 安装副本由 Pi 官方卸载；本地来源只移除配置，保留源文件。其他范围的配置保留，重载后可能继续提供同名资源。卸载后请重载资源。"),
        remove,
        button("取消", () => { confirm.remove(); trigger.focus(); }),
      );
      container.append(confirm);
      update();
      remove.focus();
    }, "pi-remove-button");
    trigger.setAttribute("aria-label", `${label}：${item.source}（${item.scope === "user" ? "个人" : "项目"}）`);
    if (item.scope === "project") trigger.dataset.requiresTrust = "";
    return trigger;
  }
  function packageControls(container, item, kind) {
    const owner = item.package;
    if (owner) {
      const controls = node("div", "pi-resource-package");
      controls.append(node("small", "", `${owner.scope === "user" ? "个人" : "项目"}包：${owner.source}`));
      if (owner.configured) controls.append(uninstallButton(container, owner, "卸载所属包"));
      else controls.append(node("small", "", "所属包已不在配置中，重载资源后核对。"));
      container.append(controls);
    } else {
      container.append(node("small", "pi-resource-origin", item.path?.startsWith("builtin:")
        ? "Pi 内置扩展，通过 Pi 配置启用或禁用。"
        : `独立${kind}，不属于已配置资源包；请在原目录管理。`));
    }
  }
  function renderCommands(kind, entries) {
    const container = panel.querySelector(`[data-pi-items="${kind}"]`);
    container.replaceChildren();
    const isSkill = kind === "skills";
    for (const item of entries) {
      const card = node("article", "pi-resource-card");
      const heading = node("div", "pi-card-heading");
      const mark = node("span", "pi-card-symbol", isSkill ? "✦" : "/");
      mark.setAttribute("aria-hidden", "true");
      heading.append(mark, node("h4", "", item.name));
      const command = isSkill ? `/skill:${item.name}` : `/${item.name}`;
      const use = button(isSkill ? "使用技能" : "插入模板", () => {
        try {
          insertText(`${command} `);
          dialog.querySelector("[data-close]").click();
        } catch (error) { report(`无法插入：${error.message}`, "error"); }
      });
      use.dataset.piCommand = command;
      use.setAttribute("aria-label", `${use.textContent}：${item.name}`);
      const footer = node("div", "pi-card-footer");
      footer.append(node("code", "", command), use);
      card.append(heading, node("p", "pi-card-description", translatePiDescription(item.description)), footer);
      packageControls(card, item, isSkill ? "技能" : "模板");
      container.append(card);
    }
    if (!entries.length) empty(container, isSkill ? "还没有可用技能" : "还没有提示词模板", "添加资源或安装扩展包后，重载资源即可在这里查看。");
  }
  function renderPackages(packages) {
    list.replaceChildren();
    for (const item of packages) {
      const row = node("article", "pi-package-row");
      const meta = node("div", "pi-package-meta");
      for (const text of [item.scope === "user" ? "个人" : "项目", item.installedPath ? "已安装" : "未安装", ...(item.filtered ? ["已筛选"] : [])]) meta.append(node("span", "pi-badge", text));
      const actions = node("div", "pi-package-actions");
      actions.append(
        button("更新", () => void operate({ action: "update", source: item.source, scope: item.scope })),
        button("筛选资源", () => {
          selectedFilter = item;
          filterEditor.value = JSON.stringify(item.filters, null, 2);
          panel.querySelector("[data-pi-filter-source]").textContent = item.source;
          filterPanel.hidden = false;
          filterEditor.focus();
        }),
        uninstallButton(row, item),
      );
      if (item.scope === "project") for (const control of actions.querySelectorAll("button")) control.dataset.requiresTrust = "";
      row.append(node("h4", "pi-package-name", item.source), meta, actions);
      list.append(row);
    }
    if (!packages.length) empty(list, "还没有配置扩展包", "展开上方的“安装扩展包”，从 npm、Git 或本地目录添加。");
  }
  function renderExtensions(entries) {
    const container = panel.querySelector('[data-pi-items="extensions"]');
    container.replaceChildren();
    for (const item of entries) {
      const row = node("article", "pi-extension-row");
      const info = node("div", "pi-extension-info");
      const label = getPiExtensionLabel(item);
      const location = node("details", "pi-extension-location");
      location.append(node("summary", "", "查看路径"), node("code", "", item.path));
      info.append(node("h4", "", label.name));
      if (label.description) info.append(node("p", "pi-extension-description", label.description));
      info.append(location);
      packageControls(info, item, "扩展");
      row.append(info, node("span", "pi-badge", "已加载"));
      container.append(row);
    }
    if (!entries.length) empty(container, "暂无已加载扩展", "扩展可提供工具、命令和自定义模型供应商等能力。");
  }
  function renderDiagnostics(entries) {
    const container = panel.querySelector("[data-pi-diagnostic-items]");
    container.replaceChildren();
    panel.querySelector("[data-pi-diagnostic-count]").textContent = entries.length ? `${entries.length} 条` : "无问题";
    for (const item of entries) {
      const row = node("div", "pi-diagnostic-row");
      row.dataset.type = item.type;
      row.append(node("span", "pi-badge", item.type === "error" ? "错误" : "提示"), node("p", "", translatePiDiagnostic(item.message)));
      if (item.path) row.append(node("code", "", item.path));
      container.append(row);
    }
    if (!entries.length) empty(container, "未发现加载问题", "资源加载时的提示和错误会显示在这里。");
  }
  async function refresh() {
    const sequence = ++token;
    loading = true;
    update();
    try {
      const data = await api.listPiResources();
      if (sequence !== token || !dialog.open || panel.hidden) return false;
      if (sessionId !== data.sessionId) { needsReload = false; filterPanel.hidden = true; selectedFilter = undefined; }
      sessionId = data.sessionId;
      projectTrusted = data.projectTrusted;
      panel.querySelector("[data-pi-cwd]").textContent = data.cwd;
      panel.querySelector("[data-pi-cwd]").title = data.cwd;
      panel.querySelector("[data-pi-trust]").textContent = projectTrusted ? "项目资源已信任" : "项目资源未信任";
      scope.querySelector('[value="project"]').disabled = !projectTrusted;
      if (!projectTrusted) scope.value = "user";
      for (const kind of ["skills", "prompts", "extensions", "packages"]) panel.querySelector(`[data-pi-count="${kind}"]`).textContent = data[kind].length;
      renderCommands("skills", data.skills);
      renderCommands("prompts", data.prompts);
      renderExtensions(data.extensions);
      renderPackages(data.packages);
      renderDiagnostics(data.diagnostics);
      if (selectedFilter && !data.packages.some(item => item.source === selectedFilter.source && item.scope === selectedFilter.scope)) { filterPanel.hidden = true; selectedFilter = undefined; }
      return true;
    } catch (error) {
      if (sequence === token) throw error;
    } finally {
      if (sequence === token) { loading = false; update(); }
    }
  }
  async function operate(request) {
    if (busy || running || loading) return;
    running = true;
    setPageBusy(true);
    update();
    report("正在处理，请等待……", "loading");
    let result;
    try {
      result = await api.managePiPackage(request);
      if (result.needsReload) needsReload = true;
      if (result.reloaded) needsReload = false;
      await refresh();
      if (request.action === "filter") { filterPanel.hidden = true; selectedFilter = undefined; }
      report(request.action === "remove" ? "资源包已卸载；点击“重载资源”更新当前会话。" : result.needsReload ? "配置已保存；点击“重载资源”应用到当前会话。" :
        result.updates ? `检查完成，${result.updates.length} 个来源可更新。` : "资源已重新加载。");
    } catch (error) {
      report(result ? `操作已完成，刷新失败：${error.message}。请刷新列表核对。` : `操作未完成：${error.message}。安装器可能已改动磁盘，请刷新列表核对。`, "error");
    } finally {
      running = false;
      setPageBusy(false);
      update();
    }
  }
  source.addEventListener("input", update);
  panel.querySelector("[data-pi-install]").addEventListener("click", () => void operate({ action: "install", source: source.value.trim(), scope: scope.value }));
  panel.querySelector("[data-pi-reload]").addEventListener("click", () => void operate({ action: "reload" }));
  panel.querySelector("[data-pi-check]").addEventListener("click", () => void operate({ action: "check" }));
  panel.querySelector("[data-pi-refresh]").addEventListener("click", () => { if (!busy && !running && !loading) void show(); });
  panel.querySelector("[data-pi-cancel-filters]").addEventListener("click", () => {
    filterPanel.hidden = true;
    selectedFilter = undefined;
    panel.querySelector('[data-pi-kind="packages"]').focus();
  });
  panel.querySelector("[data-pi-save-filters]").addEventListener("click", () => {
    try {
      const filters = JSON.parse(filterEditor.value);
      void operate({ action: "filter", source: selectedFilter.source, scope: selectedFilter.scope, filters });
    } catch (error) { report(`筛选格式无效：${error.message}`, "error"); }
  });
  const unsubscribe = api.onPiPackageProgress?.(event => {
    const phase = { start: "正在开始", progress: "正在处理", complete: "已完成", error: "操作失败" }[event.type];
    if (running) report(`${event.source} ${event.message ?? phase ?? event.type}`, "loading");
  });
  window.addEventListener("pagehide", () => unsubscribe?.(), { once: true });
  function hide() { token += 1; loading = false; update(); }
  dialog.addEventListener("close", hide);
  async function show() {
    if (!api.listPiResources) { report("当前运行环境尚未提供资源接口。", "error"); return; }
    report("正在读取资源……", "loading");
    try { if (await refresh()) report(""); } catch (error) { report(`读取失败：${error.message}`, "error"); }
  }
  update();
  return { show, hide, isSaving: () => running, setBusy(value) { busy = value; update(); } };
}

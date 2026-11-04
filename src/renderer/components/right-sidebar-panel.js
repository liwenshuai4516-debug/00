// 右侧栏内容：工作台卡片、项目环境 CRUD、qa/data 测试数据清理与文件预览。
// 内容只通过受限 IPC 读写；密码不会从主进程回填到页面。
import { renderMarkdown } from "./markdown-renderer.js";
import { normalizeBrowserUrl } from "./browser-url.js";

const SIZE_UNITS = ["B", "KB", "MB", "GB"];

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

export function createRightSidebarPanel({ body, tabs, confirmDialog }) {
  let environments = [];
  let selectedId = null;
  let view = "home";
  let editingId = null;
  let data = null;
  let status = { text: "", error: false };
  let busy = false;
  let currentFile = null;
  let currentFilePath = "";
  let fileOrigin = "home";
  let browserUrl = "";
  let browserTitle = "";
  let browserLoading = false;
  let browserView = null;
  const treeChildren = new Map();
  const treeExpanded = new Set();
  let treeRootEntries = null;

  function api() {
    if (!window.agent?.listProjectEnvironments) {
      throw new Error("页面接口尚未就绪，请稍后重试。");
    }
    return window.agent;
  }

  function setStatus(text, error = false) {
    status = { text, error };
  }

  function statusLine() {
    const node = element("p", {
      class: "right-panel__status",
      role: "status",
      "aria-live": "polite",
      text: status.text,
    });
    if (status.error) node.dataset.error = "";
    return node;
  }

  function iconButton(label, iconName, onClick, disabled = false) {
    const button = element("button", {
      type: "button",
      class: "right-sidebar__icon-button",
      "aria-label": label,
      title: label,
      disabled,
      onclick: onClick,
    }, icon(iconName));
    return button;
  }

  function setNav(title, onBack, actions = []) {
    const nav = element("div", { class: "right-panel__nav" });
    nav.append(iconButton("返回", "arrow-left", onBack, busy));
    nav.append(element("span", { class: "right-panel__nav-title", text: title }));
    nav.append(element("span", { class: "right-panel__nav-spacer" }));
    for (const action of actions) nav.append(action);
    tabs.replaceChildren(nav);
  }

  function render() {
    tabs.replaceChildren();
    body.replaceChildren();
    // 离开浏览器视图时丢弃 webview；回到该视图会按最后地址重新加载。
    if (view !== "browser") browserView = null;
    body.setAttribute("aria-busy", String(busy));

    if (view === "environments") renderEnvironments();
    else if (view === "form") renderEnvironmentForm();
    else if (view === "data") renderTestData();
    else if (view === "file") renderFile();
    else if (view === "files") renderFiles();
    else if (view === "browser") renderBrowser();
    else renderHome();
  }

  function go(next) {
    view = next;
    setStatus("");
    render();
  }

  async function loadEnvironments() {
    const list = await api().listProjectEnvironments();
    environments = Array.isArray(list) ? list : [];

    let session = null;
    try {
      session = await api().getSessionInfo();
    } catch {
      session = null;
    }
    if (!environments.some((environment) => environment.id === selectedId)) {
      selectedId = environments.find(
        (environment) => environment.workspaceDir === session?.workspaceDir,
      )?.id ?? environments[0]?.id ?? null;
    }
  }

  async function loadData() {
    const projectId = selectedId;
    if (!projectId) {
      data = null;
      return;
    }
    let next;
    try {
      next = { projectId, ...(await api().listTestData(projectId)) };
    } catch (error) {
      next = {
        projectId,
        available: false,
        truncated: false,
        items: [],
        error: errorMessage(error),
      };
    }
    if (selectedId === projectId) data = next;
  }

  function dataCountText() {
    if (!selectedId) return "未选择环境";
    if (!data || data.projectId !== selectedId) return busy ? "读取中…" : "—";
    if (data.error) return "读取失败";
    if (!data.available) return "无 qa/data";
    return `${data.items.length} 个文件`;
  }

  function renderHome() {
    const panel = element("div", { class: "right-panel" });
    const hero = element("section", { class: "right-panel__hero" });
    hero.append(
      element("div", { class: "right-panel__logo", "aria-hidden": "true" }, icon("qa-mark")),
      element("h2", { class: "right-panel__title", text: "测试工作台" }),
      element("p", {
        class: "right-panel__subtitle",
        text: "管理项目环境，查看和清理各项目 qa/data 中的测试数据。",
      }),
    );

    const cards = element("div", { class: "right-panel__cards" });
    cards.append(
      featureCard({
        iconName: "globe",
        title: "项目环境",
        description: "维护项目地址、账号与自动登录配置",
        meta: `${environments.length} 个`,
        onClick: () => go("environments"),
      }),
      featureCard({
        iconName: "database",
        title: "测试数据",
        description: "查看并清理 qa/data 中的测试文件",
        meta: dataCountText(),
        onClick: () => {
          view = "data";
          setStatus("");
          render();
          if (!data || data.projectId !== selectedId) void refreshData();
        },
      }),
      featureCard({
        iconName: "folder",
        title: "文件浏览",
        description: "浏览当前工作目录并预览文档",
        meta: "工作目录",
        onClick: () => void openTree(),
      }),
      featureCard({
        iconName: "globe",
        title: "浏览器",
        description: "在侧栏打开网页，独立会话加载",
        meta: "http(s)",
        onClick: () => openBrowser(),
      }),
    );

    panel.append(hero, cards, statusLine());
    body.append(panel);
  }

  function featureCard({ iconName, title, description, meta, onClick }) {
    const button = element("button", {
      type: "button",
      class: "right-panel__card",
      disabled: busy,
      onclick: onClick,
    });
    button.append(
      element("span", { class: "right-panel__card-icon" }, icon(iconName)),
      element("span", { class: "right-panel__card-text" },
        element("span", { class: "right-panel__card-title", text: title }),
        element("span", { class: "right-panel__card-desc", text: description }),
      ),
      element("span", { class: "right-panel__card-meta", text: meta }),
      element("span", { class: "right-panel__card-chevron" }, icon("chevron-right")),
    );
    return button;
  }

  function renderEnvironments() {
    setNav("项目环境", () => go("home"), [
      iconButton("添加项目环境", "plus", () => void addEnvironment(), busy),
    ]);

    const panel = element("div", { class: "right-panel" });
    panel.append(element("section", { class: "right-panel__section" },
      element("div", { class: "right-panel__section-head" },
        element("p", {
          class: "right-panel__section-desc",
          text: "地址、账号和密码保存在 config/projects.local.json；密码只写入本机，不回填页面。",
        }),
      ),
    ));

    if (environments.length === 0) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: busy ? "正在读取项目环境…" : "还没有项目环境。点击右上角加号选择项目目录。",
      }));
    } else {
      const list = element("div", { class: "right-panel__list" });
      for (const environment of environments) {
        list.append(environmentRow(environment));
      }
      panel.append(list);
    }

    panel.append(statusLine());
    body.append(panel);
  }

  function environmentRow(environment) {
    const card = element("article", { class: "right-panel__env" });
    card.append(
      element("div", { class: "right-panel__env-head" },
        element("span", { class: "right-panel__env-name", text: environment.name }),
        element("span", {
          class: "right-panel__env-badge",
          text: environment.passwordConfigured ? "密码已配置" : "未配置密码",
        }),
      ),
      element("p", {
        class: "right-panel__env-url",
        text: environment.address || "未配置地址",
        title: environment.address || "未配置地址",
      }),
      element("p", {
        class: "right-panel__env-meta",
        text: environment.account ? `账号：${environment.account}` : "未配置账号",
        title: environment.workspaceDir,
      }),
      element("div", { class: "right-panel__env-actions" },
        actionButton("edit", "编辑", () => {
          editingId = environment.id;
          view = "form";
          setStatus("");
          render();
        }),
        actionButton("trash", "删除", () => void deleteEnvironment(environment), true),
      ),
    );
    return card;
  }

  function actionButton(iconName, label, onClick, danger = false) {
    const button = element("button", {
      type: "button",
      class: `right-panel__action${danger ? " right-panel__action--danger" : ""}`,
      disabled: busy,
      onclick: onClick,
    }, icon(iconName), element("span", { text: label }));
    return button;
  }

  async function addEnvironment() {
    if (busy) return;
    busy = true;
    setStatus("请选择要添加的项目目录…");
    render();
    try {
      const result = await api().addProject();
      if (result?.canceled) {
        setStatus("已取消添加。");
        return;
      }
      await loadEnvironments();
      selectedId = result.project.id;
      editingId = result.project.id;
      view = "form";
      setStatus("");
      document.dispatchEvent(new CustomEvent("projects-changed"));
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      render();
    }
  }

  function renderEnvironmentForm() {
    const environment = environments.find((item) => item.id === editingId);
    setNav("编辑项目环境", () => {
      view = "environments";
      editingId = null;
      setStatus("");
      render();
    });

    if (!environment) {
      body.append(element("div", { class: "right-panel" },
        element("p", { class: "right-panel__empty", text: "未找到项目环境，请返回列表重新读取。" }),
        statusLine(),
      ));
      return;
    }

    const panel = element("div", { class: "right-panel" });
    const form = element("form", { class: "right-panel__form", novalidate: true });
    form.append(
      field("名称", element("input", {
        class: "right-panel__input",
        name: "name",
        type: "text",
        maxlength: "40",
        required: true,
        value: environment.name,
      })),
      element("div", { class: "right-panel__field" },
        element("span", { class: "right-panel__label", text: "工作目录" }),
        element("p", { class: "right-panel__readonly", text: environment.workspaceDir }),
      ),
      field("地址", element("input", {
        class: "right-panel__input",
        name: "address",
        type: "text",
        inputmode: "url",
        placeholder: "https://example.invalid",
        value: environment.address,
      })),
      field("账号", element("input", {
        class: "right-panel__input",
        name: "account",
        type: "text",
        autocomplete: "off",
        value: environment.account,
      })),
      field("密码", element("input", {
        class: "right-panel__input",
        name: "password",
        type: "password",
        autocomplete: "new-password",
        placeholder: environment.passwordConfigured ? "留空保持当前密码" : "可留空",
      })),
    );

    const passwordInput = form.querySelector('[name="password"]');
    if (environment.passwordConfigured) {
      const clearPassword = element("input", {
        type: "checkbox",
        name: "clearPassword",
      });
      clearPassword.addEventListener("change", () => {
        passwordInput.disabled = clearPassword.checked;
        if (clearPassword.checked) passwordInput.value = "";
      });
      form.append(element("label", { class: "right-panel__checkbox" },
        clearPassword,
        element("span", { text: "清除已存密码" }),
      ));
    }
    form.append(element("p", {
      class: "right-panel__hint",
      text: "密码只写入本机配置，页面不会收到已存密码。留空表示保持；填写即替换。",
    }));

    const formStatus = element("p", { class: "right-panel__status", role: "status", "aria-live": "polite" });
    const cancel = element("button", {
      type: "button",
      class: "right-panel__button",
      text: "取消",
      onclick: () => {
        view = "environments";
        editingId = null;
        setStatus("");
        render();
      },
    });
    const save = element("button", {
      type: "submit",
      class: "right-panel__button right-panel__button--primary",
      text: "保存",
    });
    form.append(element("div", { class: "right-panel__form-actions" }, cancel, save), formStatus);

    form.addEventListener("submit", (event) => {
      void saveEnvironment(event, environment, form, formStatus);
    });

    panel.append(form, statusLine());
    body.append(panel);
  }

  function field(label, control) {
    return element("label", { class: "right-panel__field" },
      element("span", { class: "right-panel__label", text: label }),
      control,
    );
  }

  async function saveEnvironment(event, environment, form, formStatus) {
    event.preventDefault();
    if (form.dataset.saving === "true") return;

    const name = form.querySelector('[name="name"]').value;
    const address = form.querySelector('[name="address"]').value;
    const account = form.querySelector('[name="account"]').value;
    const password = form.querySelector('[name="password"]').value;
    const clear = form.querySelector('[name="clearPassword"]')?.checked === true;

    const payload = { name, address, account };
    if (clear) payload.password = "";
    else if (password !== "") payload.password = password;

    form.dataset.saving = "true";
    for (const control of form.querySelectorAll("input, button")) control.disabled = true;
    formStatus.textContent = "正在保存…";
    delete formStatus.dataset.error;

    try {
      await api().saveProjectEnvironment(environment.id, payload);
      await loadEnvironments();
      view = "environments";
      editingId = null;
      setStatus(`已保存项目环境「${name.trim()}」。`);
      document.dispatchEvent(new CustomEvent("projects-changed"));
      render();
    } catch (error) {
      formStatus.textContent = errorMessage(error);
      formStatus.dataset.error = "";
      form.dataset.saving = "false";
      for (const control of form.querySelectorAll("input, button")) control.disabled = false;
    }
  }

  async function deleteEnvironment(environment) {
    const confirmed = await confirmAction({
      title: "删除项目环境",
      message: `将删除「${environment.name}」的项目环境配置（地址、账号和密码），不会删除工作目录、会话或 qa/data 测试数据。`,
      confirmLabel: "删除环境",
    });
    if (!confirmed) {
      setStatus("已取消删除。");
      render();
      return;
    }

    busy = true;
    setStatus("正在删除项目环境…");
    render();
    try {
      await api().deleteProjectEnvironment(environment.id);
      await loadEnvironments();
      if (data?.projectId === environment.id) data = null;
      setStatus(`已删除项目环境「${environment.name}」。`);
      document.dispatchEvent(new CustomEvent("projects-changed"));
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      render();
    }
  }

  function renderTestData() {
    setNav("测试数据", () => go("home"), [
      iconButton("刷新测试数据", "refresh", () => void refreshData(), busy),
    ]);

    const panel = element("div", { class: "right-panel" });
    if (environments.length === 0) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: "还没有项目环境。先添加项目，才能读取它的 qa/data。",
      }));
      panel.append(statusLine());
      body.append(panel);
      return;
    }

    const select = element("select", {
      class: "right-panel__select",
      "aria-label": "选择项目环境",
      disabled: busy,
    });
    for (const environment of environments) {
      select.append(element("option", {
        value: environment.id,
        text: environment.name,
        selected: environment.id === selectedId,
      }));
    }
    select.value = selectedId ?? "";
    select.addEventListener("change", () => {
      selectedId = select.value;
      data = null;
      void refreshData();
    });

    panel.append(element("div", { class: "right-panel__toolbar" },
      select,
      element("span", { class: "right-panel__root-label", text: "qa/data" }),
    ));

    if (!data || data.projectId !== selectedId) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: busy ? "正在读取测试数据…" : "选择环境后读取测试数据。",
      }));
    } else if (data.error) {
      panel.append(element("p", { class: "right-panel__empty", text: `读取失败：${data.error}` }));
    } else if (!data.available) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: "当前项目的 qa/data 目录不存在。",
      }));
    } else if (data.items.length === 0) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: "qa/data 下暂无测试数据。",
      }));
    } else {
      panel.append(renderDataGroups(data.items));
      if (data.truncated) {
        panel.append(element("p", {
          class: "right-panel__note",
          text: "仅显示前 500 个文件。",
        }));
      }
    }

    panel.append(element("p", {
      class: "right-panel__note",
      text: "删除只移除 qa/data 下的单个文件；项目环境、工作目录和会话不会受影响。",
    }));
    panel.append(statusLine());
    body.append(panel);
  }

  function renderDataGroups(items) {
    const groups = new Map();
    for (const item of items) {
      const category = item.category || "根目录";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    }

    const container = element("div");
    for (const [category, groupItems] of groups) {
      const group = element("section", { class: "right-panel__group" });
      group.append(element("div", { class: "right-panel__group-title" },
        element("span", { text: category }),
        element("span", { text: `${groupItems.length} 个文件` }),
      ));
      for (const item of groupItems) group.append(fileRow(item));
      container.append(group);
    }
    return container;
  }

  function fileRow(item) {
    const row = element("div", { class: "right-panel__file" });
    row.append(
      element("span", { class: "right-panel__file-icon" }, icon("files")),
      element("div", { class: "right-panel__file-main" },
        element("span", { class: "right-panel__file-name", text: item.name, title: item.name }),
        element("span", { class: "right-panel__file-path", text: item.path, title: item.path }),
      ),
      element("span", { class: "right-panel__file-meta", text: `${formatSize(item.size)} · ${formatTime(item.modifiedAt)}` }),
      element("button", {
        type: "button",
        class: "right-panel__file-delete",
        "aria-label": `删除 ${item.path}`,
        title: "删除文件",
        disabled: busy,
        onclick: () => void deleteTestData(item),
      }, icon("trash")),
    );
    return row;
  }

  async function refreshData() {
    if (!selectedId) {
      render();
      return;
    }
    busy = true;
    render();
    try {
      await loadData();
    } finally {
      busy = false;
      render();
    }
  }

  async function deleteTestData(item) {
    const confirmed = await confirmAction({
      title: "删除测试数据",
      message: `将删除「${item.path}」。只删除这个文件，不会删除项目环境或其他测试数据。`,
      confirmLabel: "删除文件",
    });
    if (!confirmed) {
      setStatus("已取消删除。");
      render();
      return;
    }

    const projectId = selectedId;
    busy = true;
    setStatus("正在删除测试数据…");
    render();
    try {
      await api().deleteTestData(projectId, item.path);
      if (selectedId === projectId) await loadData();
      setStatus(`已删除 ${item.path}。`);
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      render();
    }
  }

  function confirmAction({ title, message, confirmLabel }) {
    if (!confirmDialog) return Promise.resolve(window.confirm(message));
    const titleNode = confirmDialog.querySelector("#right-panel-confirm-title");
    const messageNode = confirmDialog.querySelector("#right-panel-confirm-message");
    const cancel = confirmDialog.querySelector("[data-cancel]");
    const confirm = confirmDialog.querySelector("[data-confirm]");
    titleNode.textContent = title;
    messageNode.textContent = message;
    confirm.textContent = confirmLabel;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cancel.removeEventListener("click", cancelHandler);
        confirm.removeEventListener("click", confirmHandler);
        confirmDialog.removeEventListener("close", closeHandler);
        confirmDialog.close();
        resolve(value);
      };
      const cancelHandler = () => finish(false);
      const confirmHandler = () => finish(true);
      const closeHandler = () => finish(false);
      cancel.addEventListener("click", cancelHandler);
      confirm.addEventListener("click", confirmHandler);
      confirmDialog.addEventListener("close", closeHandler);
      confirmDialog.showModal();
      cancel.focus();
    });
  }

  async function open() {
    // 从 header 重新打开时保留正在查看的文件，避免把预览切回工作台。
    if (view !== "file") view = "home";
    editingId = null;
    setStatus("");
    busy = true;
    render();
    try {
      await loadEnvironments();
      await loadData();
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      render();
    }
  }

  // 侧栏浏览器：<webview> 在独立分区加载 http(s) 页面，不继承应用 preload。
  function openBrowser() {
    view = "browser";
    setStatus("");
    render();
  }

  function navigateBrowser(url) {
    const attached = browserView?.isConnected === true;
    browserUrl = url;
    browserLoading = true;
    setStatus("");
    if (attached) {
      try {
        browserView.loadURL(url);
        syncAddress();
        updateBrowserChrome();
        return;
      } catch {
        // 尚未 dom-ready 时改为重建 webview，由 src 触发加载。
      }
    }
    render();
  }

  function syncAddress() {
    const input = body.querySelector(".browser-bar__address");
    if (input && document.activeElement !== input) input.value = browserUrl;
  }

  function setStatusText(text, error = false) {
    const node = body.querySelector(".right-panel__status");
    if (!node) return;
    node.textContent = text;
    if (error) node.dataset.error = "";
    else delete node.dataset.error;
  }

  // webview 在 dom-ready 之前调用 canGoBack/loadURL 会抛错，统一按“不可用”处理。
  function canGo(direction) {
    if (!browserView || !browserView.isConnected) return false;
    try {
      return direction === "back" ? browserView.canGoBack() : browserView.canGoForward();
    } catch {
      return false;
    }
  }

  function updateBrowserChrome() {
    const reload = body.querySelector(".browser-bar__reload");
    if (reload) reload.replaceChildren(icon(browserLoading ? "stop" : "refresh"));
    const back = body.querySelector(".browser-bar__back");
    if (back) back.disabled = !canGo("back");
    const forward = body.querySelector(".browser-bar__forward");
    if (forward) forward.disabled = !canGo("forward");
    const external = body.querySelector(".browser-bar__external");
    if (external) external.disabled = browserUrl === "";
  }

  function createBrowserView() {
    const view = document.createElement("webview");
    view.className = "right-panel__browser-view";
    view.setAttribute("partition", "persist:browser-panel");
    view.setAttribute("webpreferences", "contextIsolation=yes,sandbox=yes,nodeIntegration=no");
    view.setAttribute("src", browserUrl);

    view.addEventListener("did-start-loading", () => {
      browserLoading = true;
      updateBrowserChrome();
    });
    view.addEventListener("did-stop-loading", () => {
      browserLoading = false;
      updateBrowserChrome();
    });
    view.addEventListener("did-navigate", (event) => {
      browserUrl = event.url;
      syncAddress();
      updateBrowserChrome();
    });
    view.addEventListener("did-navigate-in-page", (event) => {
      browserUrl = event.url;
      syncAddress();
      updateBrowserChrome();
    });
    view.addEventListener("page-title-updated", (event) => {
      browserTitle = event.title;
      const title = document.querySelector(".right-panel__nav-title");
      if (title) title.textContent = browserTitle || "浏览器";
    });
    view.addEventListener("did-fail-load", (event) => {
      // -3 是主动取消（例如停止或新导航），不属于加载失败。
      if (event.errorCode === -3) return;
      browserLoading = false;
      setStatusText(`页面加载失败：${event.errorDescription || event.errorCode}`, true);
      updateBrowserChrome();
    });
    return view;
  }

  function renderBrowser() {
    setNav(browserTitle || "浏览器", () => go("home"));

    // 与 DSH 一致：工具栏 + 页面贴边铺满，不使用内层卡片边框。
    const panel = element("div", { class: "right-panel right-panel--browser" });

    const bar = element("div", { class: "browser-bar" });
    const back = element("button", {
      type: "button",
      class: "browser-bar__tool browser-bar__back",
      "aria-label": "后退",
      title: "后退",
    }, icon("arrow-left"));
    back.addEventListener("click", () => {
      if (!canGo("back")) return;
      try {
        browserView.goBack();
      } catch {
        // 历史尚未就绪时忽略点击。
      }
    });
    const forward = element("button", {
      type: "button",
      class: "browser-bar__tool browser-bar__forward",
      "aria-label": "前进",
      title: "前进",
    }, icon("arrow-left"));
    forward.addEventListener("click", () => {
      if (!canGo("forward")) return;
      try {
        browserView.goForward();
      } catch {
        // 历史尚未就绪时忽略点击。
      }
    });
    const reload = element("button", {
      type: "button",
      class: "browser-bar__tool browser-bar__reload",
      "aria-label": "刷新或停止",
      title: "刷新或停止",
    }, icon(browserLoading ? "stop" : "refresh"));
    reload.addEventListener("click", () => {
      if (!browserView || !browserView.isConnected) return;
      try {
        if (browserLoading) browserView.stop();
        else browserView.reload();
      } catch {
        // 尚未完成首次加载时忽略。
      }
    });

    const addressBox = element("div", { class: "browser-bar__address-box" });
    const address = element("input", {
      type: "text",
      class: "browser-bar__address",
      placeholder: "输入网址，例如 https://example.com",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "浏览器地址",
      value: browserUrl,
    });
    const submit = () => {
      const url = normalizeBrowserUrl(address.value);
      if (url === null) {
        setStatusText("只支持 http(s) 网址。", true);
        address.focus();
        return;
      }
      navigateBrowser(url);
    };
    // 不叫 go：避免遮蔽外层的 go(next) 视图切换函数。
    const goButton = element("button", {
      type: "button",
      class: "browser-bar__go",
      "aria-label": "前往",
      title: "前往",
      text: "前往",
    });
    goButton.addEventListener("click", submit);
    address.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submit();
    });
    addressBox.append(address, goButton);

    const devtools = element("button", {
      type: "button",
      class: "browser-bar__tool browser-bar__tool--text browser-bar__devtools",
      "aria-label": "开发者工具",
      title: "开发者工具",
      text: "调试",
    });
    devtools.addEventListener("click", () => {
      const open = window.agent?.openBrowserDevTools;
      if (typeof open !== "function") {
        setStatusText("页面接口尚未就绪，请稍后重试。", true);
        return;
      }
      Promise.resolve(open()).catch((error) => {
        setStatusText(error?.message ? String(error.message) : "无法打开开发者工具。", true);
      });
    });

    const external = element("button", {
      type: "button",
      class: "browser-bar__tool browser-bar__external",
      "aria-label": "在系统浏览器中打开",
      title: "在系统浏览器中打开",
      disabled: browserUrl === "",
    }, icon("globe"));
    external.addEventListener("click", () => {
      if (browserUrl === "") return;
      const open = window.agent?.openExternalUrl;
      if (typeof open !== "function") {
        setStatusText("页面接口尚未就绪，请稍后重试。", true);
        return;
      }
      Promise.resolve(open(browserUrl)).catch(() => setStatusText("无法打开系统浏览器。", true));
    });

    bar.append(back, forward, reload, addressBox, devtools, external);
    panel.append(bar);

    const surface = element("div", { class: "right-panel__browser" });
    if (browserUrl === "") {
      surface.append(element("p", {
        class: "right-panel__browser-start",
        text: "输入网址开始浏览。页面在独立会话中加载，不继承应用权限。",
      }));
    } else {
      browserView = createBrowserView();
      surface.append(browserView);
    }
    panel.append(surface, statusLine());
    body.append(panel);

    if (browserUrl === "") address.focus();
    updateBrowserChrome();
  }

  // 文件树按目录懒加载：只缓存展开过的层级，切换会话时整体丢弃。
  async function openTree() {
    view = "files";
    treeRootEntries = null;
    treeChildren.clear();
    treeExpanded.clear();
    setStatus("");
    render();
    await loadTree("");
  }

  async function loadTree(dirPath) {
    try {
      const result = await api().listWorkspaceDirectory(dirPath);
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      if (dirPath === "") treeRootEntries = entries;
      else treeChildren.set(dirPath, entries);
      setStatus(result?.truncated ? "目录较大，只显示前 500 项。" : "");
    } catch (error) {
      if (dirPath === "") treeRootEntries = [];
      setStatus(errorMessage(error), true);
    }
    render();
  }

  async function toggleDir(dirPath) {
    if (treeExpanded.has(dirPath)) {
      treeExpanded.delete(dirPath);
      render();
      return;
    }
    treeExpanded.add(dirPath);
    if (treeChildren.has(dirPath)) {
      render();
      return;
    }
    render();
    await loadTree(dirPath);
  }

  function treeItems(entries) {
    return entries.map((entry) => {
      if (entry.type !== "dir") {
        const button = element("button", {
          type: "button",
          class: "file-tree__row file-tree__row--file",
          disabled: busy,
          onclick: () => void openFile(entry.path, "files"),
        },
        element("span", { class: "file-tree__chevron" }),
        icon("files"),
        element("span", { class: "file-tree__name", text: entry.name }));
        return element("li", { class: "file-tree__item", role: "treeitem" }, button);
      }

      const expanded = treeExpanded.has(entry.path);
      const item = element("li", {
        class: "file-tree__item",
        role: "treeitem",
        "aria-expanded": String(expanded),
      });
      const button = element("button", {
        type: "button",
        class: "file-tree__row",
        disabled: busy,
        onclick: () => void toggleDir(entry.path),
      },
      element("span", {
        class: expanded ? "file-tree__chevron file-tree__chevron--open" : "file-tree__chevron",
      }, icon("chevron-right")),
      icon("folder"),
      element("span", { class: "file-tree__name", text: entry.name }));
      item.append(button);

      if (expanded) {
        const group = element("ul", { class: "file-tree__group", role: "group" });
        const children = treeChildren.get(entry.path);
        if (children === undefined) {
          group.append(element("li", { class: "file-tree__loading", text: "读取中…" }));
        } else {
          group.append(...treeItems(children));
        }
        item.append(group);
      }
      return item;
    });
  }

  function renderFiles() {
    setNav("文件", () => go("home"), [
      iconButton("刷新文件树", "refresh", () => void openTree(), busy),
    ]);

    const panel = element("div", { class: "right-panel right-panel--files" });
    panel.append(statusLine());
    if (treeRootEntries === null) {
      panel.append(element("p", { class: "right-panel__empty", text: "正在读取工作目录…" }));
    } else if (treeRootEntries.length === 0) {
      panel.append(element("p", { class: "right-panel__empty", text: "工作目录为空，或目录不可读。" }));
    } else {
      const tree = element("ul", { class: "file-tree", role: "tree", "aria-label": "工作目录" });
      tree.append(...treeItems(treeRootEntries));
      panel.append(tree);
    }
    body.append(panel);
  }

  // Markdown 里的本地路径链接经页面事件进入这里；路径解析与边界在主进程完成。
  async function openFile(filePath, origin = "home") {
    fileOrigin = origin === "files" ? "files" : "home";
    view = "file";
    currentFilePath = typeof filePath === "string" ? filePath : "";
    currentFile = null;
    busy = true;
    setStatus("正在读取文件…");
    render();

    try {
      const read = window.agent?.readPreviewFile;
      if (typeof read !== "function") throw new Error("页面接口尚未就绪，请稍后重试。");
      const result = await read(currentFilePath);
      if (!result || typeof result.content !== "string") throw new Error("文件内容不可用。");
      currentFile = result;
      if (typeof result.path === "string" && result.path !== "") currentFilePath = result.path;
      setStatus("");
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      render();
    }
  }

  function renderFile() {
    const name = currentFilePath.split("/").filter(Boolean).pop() || "文件预览";
    setNav(name, () => go(fileOrigin), [
      iconButton("重新读取", "refresh", () => void openFile(currentFilePath), busy),
    ]);

    const panel = element("div", { class: "right-panel right-panel--file" });
    panel.append(statusLine());
    if (currentFile) {
      panel.append(element("p", {
        class: "right-panel__file-meta",
        text: `${currentFile.path} · ${formatSize(currentFile.size)}`,
      }));
      if (/\.(md|markdown)$/i.test(currentFile.path)) {
        const article = element("div", { class: "markdown-body right-panel__markdown" });
        try {
          renderMarkdown(article, currentFile.content);
        } catch {
          // 排版失败仍展示原文，不中断预览。
          article.classList.remove("markdown-body");
          article.textContent = currentFile.content;
        }
        // 文档之间的本地链接继续在同一个预览视图里跳转。
        article.addEventListener("click", (event) => {
          const link = event.target instanceof Element ? event.target.closest("a[data-file-path]") : null;
          if (!link) return;
          event.preventDefault();
          void openFile(link.dataset.filePath);
        });
        panel.append(article);
      } else {
        panel.append(element("pre", {
          class: "right-panel__file",
          tabindex: "0",
          text: currentFile.content,
        }));
      }
    }
    body.append(panel);
  }

  // 切换会话后旧路径不再属于当前工作目录，文件与文件树都回到工作台。
  function resetWorkspaceView() {
    treeChildren.clear();
    treeExpanded.clear();
    treeRootEntries = null;
    if (view === "file" || view === "files") go("home");
  }

  return { open, refresh: open, openFile, resetWorkspaceView };
}

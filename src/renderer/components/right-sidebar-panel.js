// 右侧栏内容：工作台卡片、项目环境 CRUD、测试数据、UI/接口测试报告与文件预览。
// 内容只通过受限 IPC 读写；密码不会从主进程回填到页面。
import { renderMarkdown } from "./markdown-renderer.js";
import { normalizeBrowserUrl } from "./browser-url.js";

const SIZE_UNITS = ["B", "KB", "MB", "GB"];
const RUN_STATUS_LABELS = {
  passed: "通过",
  failed: "失败",
  incomplete: "不完整",
  cancelled: "已取消",
  unknown: "未知",
};
const CASE_STATUS_LABELS = {
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  flaky: "波动",
  "expected-failure": "预期失败",
  cancelled: "取消",
  "not-run": "未运行",
  "timedOut": "超时",
  interrupted: "已中断",
  unknown: "未知",
};
const REPORT_KIND_LABELS = { ui: "UI", api: "接口" };
const CLEANUP_LABELS = {
  deleted: "已删除",
  "not-needed": "无需登录态",
  failed: "清理失败",
  pending: "待清理",
};
const TRACE_POLICY_LABELS = {
  "disabled-for-private-auth": "已关闭（私有登录态）",
  "steps-without-dom-network-sources": "保留步骤，无 DOM/网络快照",
};

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

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)} s`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

function reportTitle(report) {
  const moduleName = report.moduleName
    || (Array.isArray(report.modulePath) && report.modulePath.length > 0
      ? report.modulePath[report.modulePath.length - 1]
      : "");
  const date = formatDate(report.finishedAt || report.startedAt || report.modifiedAt);
  if (moduleName) return [moduleName, date].filter(Boolean).join(" ");
  return report.runId || report.id;
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
  // 视图内容与浏览器层分开：切换视图只替换内容，webview 保持挂载以保留历史。
  const content = element("div", { class: "right-panel__content" });
  const browserLayer = element("div", { class: "right-panel__browser-layer", hidden: "" });
  body.append(content, browserLayer);

  let environments = [];
  let selectedId = null;
  let view = "home";
  let editingId = null;
  let data = null;
  let caseQuery = "";
  let casePage = 1;
  let dataRequest = 0;
  const expandedCases = new Set();
  const caseDetails = new Map();
  let reportsData = null;
  let reportKindFilter = "all";
  let reportPage = 1;
  let reportRequest = 0;
  const expandedReports = new Set();
  const reportDetails = new Map();
  let status = { text: "", error: false };
  let busy = false;
  let currentFile = null;
  let currentFilePath = "";
  let fileOrigin = "home";
  let changesRequestId = "";
  let changesSummary = null;
  let changesDiff = null;
  let changesIndex = -1;
  let browserUrl = "";
  let browserTitle = "";
  let browserLoading = false;
  let browserView = null;
  const MAX_BROWSER_TABS = 8;
  let browserTabs = [];
  let activeTabId = null;
  let browserTabSerial = 0;
  let browserTabsList = null;
  let browserPages = null;
  let browserBuilt = false;
  let browserSurface = null;
  let browserStart = null;
  let browserAddress = null;
  const treeChildren = new Map();
  const treeExpanded = new Set();
  let treeRootEntries = null;

  // 回放批次在窗口外完成后，回到应用时自动刷新当前测试数据或报告视图。
  window.addEventListener("focus", () => {
    if (busy || !selectedId) return;
    if (view === "data") void refreshData();
    else if (view === "reports") void refreshReports();
  });

  function api() {
    if (!window.agent?.listProjectEnvironments) {
      throw new Error("页面接口尚未就绪，请稍后重试。");
    }
    return window.agent;
  }

  function setStatus(text, error = false) {
    status = { text, error };
    // 同步已渲染的状态行，避免旧错误在成功操作后残留。
    const node = content.querySelector(".right-panel__status")
      ?? browserLayer.querySelector(".right-panel__status");
    if (!node) return;
    node.textContent = text;
    if (error) node.dataset.error = "";
    else delete node.dataset.error;
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
    content.replaceChildren();
    // 浏览器层保持挂载，只切换可见性，避免重建 webview 丢失历史。
    browserLayer.hidden = view !== "browser";
    body.setAttribute("aria-busy", String(busy));

    if (view === "environments") renderEnvironments();
    else if (view === "form") renderEnvironmentForm();
    else if (view === "data") renderTestData();
    else if (view === "reports") renderReports();
    else if (view === "file") renderFile();
    else if (view === "files") renderFiles();
    else if (view === "changes") renderChanges();
    else if (view === "browser") renderBrowser();
    else renderHome();
  }

  function go(next) {
    view = next;
    setStatus("");
    render();
  }

  async function loadEnvironments() {
    const previousSelectedId = selectedId;
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
    if (selectedId !== previousSelectedId) {
      data = null;
      caseQuery = "";
      casePage = 1;
      dataRequest += 1;
      expandedCases.clear();
      caseDetails.clear();
      reportsData = null;
      reportKindFilter = "all";
      reportPage = 1;
      reportRequest += 1;
      expandedReports.clear();
      reportDetails.clear();
    }
  }

  async function loadData() {
    const projectId = selectedId;
    const request = ++dataRequest;
    if (!projectId) { data = null; return; }
    let next;
    try {
      next = { projectId, ...(await api().listTestData(projectId, { page: casePage, query: caseQuery })) };
    } catch (error) {
      next = { projectId, items: [], error: errorMessage(error) };
    }
    if (selectedId === projectId && request === dataRequest) {
      data = next;
      casePage = next.catalog?.page ?? casePage;
      expandedCases.clear();
      caseDetails.clear();
    }
  }

  function dataCountText() {
    if (!selectedId) return "未选择环境";
    if (!data || data.projectId !== selectedId) return busy ? "读取中…" : "—";
    if (data.error) return "读取失败";
    return `${data.catalog?.total ?? 0} 条用例`;
  }

  function renderHome() {
    const panel = element("div", { class: "right-panel" });
    const hero = element("section", { class: "right-panel__hero" });
    hero.append(
      element("div", { class: "right-panel__logo", "aria-hidden": "true" }, icon("qa-mark")),
      element("h2", { class: "right-panel__title", text: "测试工作台" }),
      element("p", {
        class: "right-panel__subtitle",
        text: "管理项目环境，查看测试数据与 UI、接口测试报告。",
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
        description: "查看版本用例与 qa/data 中的测试文件",
        meta: dataCountText(),
        onClick: () => {
          view = "data";
          setStatus("");
          render();
          // 每次打开都重新读取，回放结束后直接看到最新结果。
          void refreshData();
        },
      }),
      featureCard({
        iconName: "history",
        title: "测试报告",
        description: "查看 UI 与接口测试批次的统一结果",
        meta: "UI / 接口",
        onClick: () => openReports(),
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
    content.append(panel);
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
    content.append(panel);
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
      content.append(element("div", { class: "right-panel" },
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
    content.append(panel);
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
    const environment = environments.find((item) => item.id === selectedId);
    setNav(environment ? `测试数据 · ${environment.name}` : "测试数据", () => go("home"), [
      iconButton("刷新测试数据", "refresh", () => void refreshData(), busy),
    ]);
    const panel = element("div", { class: "right-panel" });
    if (!environment) {
      panel.append(element("p", { class: "right-panel__empty", text: "还没有项目环境，请先添加项目。" }));
    } else {
      const select = element("select", { class: "right-panel__select", "aria-label": "选择项目环境", disabled: busy });
      for (const item of environments) select.append(element("option", { value: item.id, text: item.name }));
      select.value = selectedId;
      select.addEventListener("change", () => {
        selectedId = select.value;
        data = null;
        caseQuery = "";
        casePage = 1;
        expandedCases.clear();
        caseDetails.clear();
        void refreshData();
      });
      panel.append(select);
      if (!data || data.projectId !== selectedId) {
        panel.append(element("p", { class: "right-panel__empty", text: "正在读取测试数据…" }));
      } else if (data.error) {
        panel.append(element("p", { class: "right-panel__empty", text: `读取失败：${data.error}` }));
      } else {
        panel.append(renderCaseCatalog(data.catalog));
        panel.append(element("h3", { class: "case-steps__label", text: "其他测试数据 · qa/data" }));
        for (const item of data.items) {
          panel.append(element("div", { class: "case-data-file" },
            element("span", { text: `${item.path} · ${formatSize(item.size)}` }),
            element("button", { type: "button", class: "case-card__edit", text: "删除文件", disabled: busy,
              "aria-label": `删除文件 ${item.path}`, onclick: () => void deleteDataFile(item) }),
          ));
        }
        if (!data.items.length) panel.append(element("p", { class: "right-panel__note", text: "暂无其他测试数据。旧 UI 资产不在此面板展示。" }));
        if (data.truncated) panel.append(element("p", { class: "right-panel__note", text: "其他测试数据超过 500 个文件，仅展示前 500 个。" }));
      }
    }
    panel.append(statusLine());
    content.append(panel);
  }

  function renderCaseCatalog(catalog) {
    const section = element("section", { class: "case-catalog" });
    section.append(element("div", { class: "case-catalog__summary" },
      element("span", { class: "case-catalog__project", text: "UI 版本用例" }),
      element("span", { text: `${catalog.total} 条 · 每页 ${catalog.pageSize} 条` }),
      element("span", { text: "内容只读" }),
    ));
    const search = element("input", { type: "search", class: "case-catalog__search", "aria-label": "搜索用例", placeholder: "用例、模块、角色或编号", value: caseQuery, maxlength: 200, disabled: busy });
    const form = element("form", { class: "case-catalog__search-form" }, search,
      element("button", { type: "submit", class: "case-card__edit", text: "搜索", disabled: busy }));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      caseQuery = search.value;
      casePage = 1;
      void refreshData();
    });
    section.append(form);
    const pager = element("div", { class: "case-catalog__pager" });
    const turn = (page) => { casePage = page; void refreshData(); };
    pager.append(
      element("button", { type: "button", class: "case-card__edit", text: "上一页", disabled: busy || catalog.page <= 1, onclick: () => turn(catalog.page - 1) }),
      element("span", { text: `第 ${catalog.page} / ${catalog.pages} 页` }),
      element("button", { type: "button", class: "case-card__edit", text: "下一页", disabled: busy || catalog.page >= catalog.pages, onclick: () => turn(catalog.page + 1) }),
    );
    section.append(pager);
    if (!catalog.cases.length) section.append(element("p", { class: "case-catalog__empty", text: "暂无匹配的新版本用例。" }));
    const list = element("div", { class: "case-catalog__list" });
    for (const item of catalog.cases) list.append(renderCaseCard(item));
    section.append(list);
    return section;
  }

  function renderCaseCard(item) {
    const open = expandedCases.has(item.caseId);
    const card = element("article", { class: "case-card", dataset: { caseId: item.caseId, status: item.lastResult?.status ?? "unknown" } });
    const head = element("button", { type: "button", class: "case-card__head", "aria-expanded": String(open), onclick: () => {
      if (open) expandedCases.delete(item.caseId);
      else expandedCases.add(item.caseId);
      render();
      if (!open && !caseDetails.has(item.caseId)) void loadCaseDetail(item, item.displayRevision);
    } },
    element("div", { class: "case-card__top" },
      element("span", { class: "case-card__name", text: item.title }),
      element("span", { class: "case-card__status", text: item.currentRevision ? `正式 ${item.currentRevision}` : "候选" }),
    ),
    element("span", { class: "case-version-meta", text: `${item.modulePath.join(" / ")} · ${item.role}` }),
    element("span", { class: "case-version-meta", text: [item.candidates.length ? `新候选 ${item.candidates.join("、")}` : "", item.lastResult ? `最近回归 ${CASE_STATUS_LABELS[item.lastResult.status] ?? item.lastResult.status} · ${formatTime(item.lastResult.finishedAt)}` : "暂无当前正式版本回归结果"].filter(Boolean).join(" · ") }),
    );
    card.append(head);
    if (open) {
      const body = element("div", { class: "case-card__body" });
      const detail = caseDetails.get(item.caseId);
      if (!detail || detail.loading) body.append(element("p", { class: "right-panel__note", text: "正在读取版本详情…" }));
      else if (detail.error) body.append(element("p", { class: "right-panel__note", text: `读取失败：${detail.error}` }));
      else body.append(renderCaseDetail(item, detail));
      const actions = element("div", { class: "case-card__edit-actions" });
      if (item.runnable) actions.append(element("button", { type: "button", class: "case-card__edit", text: "生成执行提示", disabled: busy, onclick: () => insertCaseRunPrompt(item) }));
      actions.append(element("button", { type: "button", class: "case-card__edit case-card__edit--danger", text: "删除整个用例", disabled: busy, onclick: () => void deleteVersionedCase(item) }));
      body.append(actions);
      card.append(body);
    }
    return card;
  }

  async function loadCaseDetail(item, revision) {
    const projectId = selectedId;
    const request = dataRequest;
    const pending = { loading: true };
    caseDetails.set(item.caseId, pending);
    render();
    let detail;
    try {
      detail = await api().getTestCase(projectId, item.caseId, revision);
      if (detail.assetHash !== item.assetHash) throw new Error("用例版本已变化，请刷新列表。");
    } catch (error) { detail = { error: errorMessage(error) }; }
    if (selectedId === projectId && request === dataRequest && caseDetails.get(item.caseId) === pending) {
      caseDetails.set(item.caseId, detail);
      render();
    }
  }

  function renderCaseDetail(item, detail) {
    const section = element("div", { class: "case-version-detail" });
    const version = element("select", { class: "right-panel__select", "aria-label": `选择版本 ${item.caseId}` });
    for (const entry of detail.revisions) version.append(element("option", { value: entry.revision,
      text: `${entry.revision} · ${entry.revision === detail.currentRevision ? "当前正式" : entry.validatedRunId ? "历史已验证" : "候选"}${entry.parentRunId ? " · 修复" : ""}` }));
    version.value = detail.revision;
    version.addEventListener("change", () => void loadCaseDetail(item, version.value));
    section.append(version);
    const meta = detail.meta;
    section.append(element("p", { class: "case-context", text: `${item.caseId} · ${meta.targetUrl} · ${meta.role}` }),
      element("p", { class: "case-context", text: `初态：${meta.initialState}；数据：${meta.dataStrategy}；清理：${meta.cleanup}${meta.writeAuthorization ? `；写授权：${meta.writeAuthorization.kind} · ${meta.writeAuthorization.reference}` : ""}` }));
    const addList = (label, entries, describe) => {
      section.append(element("h4", { class: "case-steps__label", text: `${label} ${entries.length}` }));
      const list = element("ol", { class: "case-version-list" });
      for (const entry of entries) list.append(element("li", { text: describe(entry) }));
      section.append(list);
    };
    addList("执行步骤", meta.steps ?? [], (step) => `${step.text}（${step.stepId}）`);
    addList("业务预期与来源", meta.expected ?? [], (expected) => `${expected.id} · ${expected.text}；来源：${({ user: "用户说明", rule: "页面规则", baseline: "基线" })[expected.source?.kind] ?? "未知"} · ${expected.source?.reference ?? "未记录"}`);
    for (const [kind, label] of [["business", "业务断言"], ["guard", "前置断言"]]) {
      addList(label, (meta.assertions ?? []).filter((entry) => entry.kind === kind), (entry) => `${entry.text}${entry.expectedId ? `；预期 ${entry.expectedId}` : ""}`);
    }
    const entry = detail.revisions.find((entry) => entry.revision === detail.revision);
    section.append(element("p", { class: "case-context", text: `来源任务：${entry.taskId}；验证批次：${entry.validatedRunId ?? entry.validationRunId ?? "未验证"}${entry.parentRunId ? `；修复自 ${entry.parentRunId}${entry.patchSummary ? `；补丁：${entry.patchSummary}` : ""}` : ""}` }));
    return section;
  }

  function insertCaseRunPrompt(item) {
    const prompt = `请使用 qa-ui-execute 执行已有正式用例 ${item.caseId}（当前列表版本 ${item.currentRevision}）。\n参数：--project ${shellQuote(selectedId)} --cases ${shellQuote(item.caseId)}\n执行前核对当前正式版本；如版本已变化先报告。只执行这个用例，不扩大范围，不修改脚本，不调用模型修复；保留原始结果。`;
    const detail = { text: prompt, accepted: false };
    document.dispatchEvent(new CustomEvent("insert-composer-text", { detail }));
    setStatus(detail.accepted ? "已插入执行提示，请确认后发送。" : "未能插入执行提示。", !detail.accepted);
    render();
  }

  async function deleteVersionedCase(item) {
    const projectId = selectedId;
    const confirmed = await confirmAction({ title: "删除整个用例", message: `将永久删除「${item.title}」的全部版本和脚本，不可恢复。历史任务和运行快照保留。`, confirmLabel: "删除用例" });
    if (!confirmed || selectedId !== projectId) return;
    busy = true;
    render();
    try {
      await api().deleteTestCase(projectId, item.caseId, item.assetHash);
      await loadData();
      setStatus("已删除整个用例，历史运行快照保留。");
    } catch (error) { setStatus(errorMessage(error), true); }
    finally { busy = false; render(); }
  }

  async function deleteDataFile(item) {
    const projectId = selectedId;
    const confirmed = await confirmAction({ title: "删除测试数据文件", message: `将永久删除 qa/data/${item.path}，不可恢复。`, confirmLabel: "删除文件" });
    if (!confirmed || selectedId !== projectId) return;
    busy = true;
    render();
    try {
      await api().deleteTestData(projectId, item.path);
      await loadData();
      setStatus("测试数据文件已删除。");
    } catch (error) { setStatus(errorMessage(error), true); }
    finally { busy = false; render(); }
  }

  async function refreshData() {
    if (!selectedId) { render(); return; }
    busy = true;
    render();
    try { await loadData(); }
    finally { busy = false; render(); }
  }

  function reportKey(report) {
    return `${report.kind}:${report.id}`;
  }

  function reportCountsText(counts) {
    return Object.entries(counts ?? {})
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .map(([status, value]) => `${CASE_STATUS_LABELS[status] ?? status} ${value}`)
      .join(" · ");
  }

  // 报告可视化只区分三类：通过、失败（含超时/中断）和其他，未知数量并入其他，避免条形图缺段。
  const REPORT_FAILURE_STATUSES = new Set(["failed", "timedOut", "interrupted"]);

  function reportSegments(report) {
    const counts = report?.counts ?? {};
    let passed = 0;
    let failed = 0;
    let other = 0;
    for (const [status, value] of Object.entries(counts)) {
      if (!Number.isFinite(value) || value <= 0) continue;
      if (status === "passed") passed += value;
      else if (REPORT_FAILURE_STATUSES.has(status)) failed += value;
      else other += value;
    }
    const declared = Number.isFinite(report?.testCount) ? report.testCount : null;
    const known = passed + failed + other;
    const total = declared === null ? known : Math.max(declared, known);
    return { total, passed, failed, other: other + Math.max(0, total - known) };
  }

  function reportPassRate(segments) {
    return segments.total > 0 ? Math.round((segments.passed / segments.total) * 100) : null;
  }

  function reportMeter(segments, label, className = "report-meter") {
    const bar = element("div", {
      class: className,
      role: "img",
      "aria-label": label,
      dataset: { empty: String(segments.total <= 0) },
    });
    for (const [segment, value] of [
      ["passed", segments.passed],
      ["failed", segments.failed],
      ["other", segments.other],
    ]) {
      if (!Number.isFinite(value) || value <= 0) continue;
      bar.append(element("span", {
        class: "report-meter__segment",
        dataset: { segment },
        style: `flex-grow:${value}`,
      }));
    }
    return bar;
  }

  function reportTotals(reports) {
    const totals = {
      total: reports.length,
      ui: 0,
      api: 0,
      passed: 0,
      failed: 0,
      incomplete: 0,
      cancelled: 0,
    };
    for (const report of reports) {
      if (report.kind === "ui") totals.ui += 1;
      if (report.kind === "api") totals.api += 1;
      if (Object.hasOwn(totals, report.status)) totals[report.status] += 1;
    }
    return totals;
  }

  function openReports() {
    view = "reports";
    reportsData = null;
    reportKindFilter = "all";
    reportPage = 1;
    expandedReports.clear();
    reportDetails.clear();
    setStatus("");
    render();
    void refreshReports();
  }

  async function refreshReports() {
    const request = ++reportRequest;
    if (!selectedId) {
      reportsData = null;
      render();
      return;
    }
    const projectId = selectedId;
    const current = () => selectedId === projectId && request === reportRequest && view === "reports";
    busy = true;
    reportDetails.clear();
    render();
    try {
      const result = await api().listTestReports(projectId, { page: reportPage, kind: reportKindFilter });
      if (current()) {
        reportsData = { projectId, ...result };
        reportPage = result.pagination.page;
      }
    } catch (error) {
      if (current()) reportsData = { projectId, error: errorMessage(error) };
    } finally {
      if (request === reportRequest && selectedId === projectId) {
        busy = false;
        if (view === "reports") render();
      }
    }
  }

  function renderReports() {
    const environment = environments.find((item) => item.id === selectedId);
    setNav(environment ? `测试报告 · ${environment.name}` : "测试报告", () => go("home"), [
      iconButton("刷新测试报告", "refresh", () => void refreshReports(), busy),
    ]);

    const panel = element("div", { class: "right-panel" });
    if (environments.length === 0) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: "还没有项目环境。先添加项目，才能读取测试报告。",
      }));
      panel.append(statusLine());
      content.append(panel);
      return;
    }

    const select = element("select", {
      class: "right-panel__select right-panel__select--compact",
      "aria-label": "选择项目环境",
      disabled: busy,
    });
    for (const item of environments) {
      select.append(element("option", {
        value: item.id,
        text: item.name,
        selected: item.id === selectedId,
      }));
    }
    select.value = selectedId ?? "";
    select.addEventListener("change", () => {
      selectedId = select.value;
      data = null;
      caseQuery = "";
      casePage = 1;
      dataRequest += 1;
      expandedCases.clear();
      caseDetails.clear();
      reportsData = null;
      reportKindFilter = "all";
      reportPage = 1;
      reportRequest += 1;
      expandedReports.clear();
      reportDetails.clear();
      void refreshReports();
    });

    panel.append(element("div", { class: "right-panel__toolbar" },
      select,
      element("span", { class: "right-panel__root-label", text: "qa/*/runs" }),
    ));

    if (!reportsData || reportsData.projectId !== selectedId) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: busy ? "正在读取测试报告…" : "选择环境后读取测试报告。",
      }));
    } else if (reportsData.error) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: `读取失败：${reportsData.error}`,
      }));
    } else {
      const reports = Array.isArray(reportsData.reports) ? reportsData.reports : [];
      const totals = reportsData.totals ?? reportTotals(reports);
      panel.append(renderReportSummary(totals), renderReportFilters(totals));
      if (reports.length === 0) {
        panel.append(element("p", {
          class: "right-panel__empty",
          text: !reportsData.available
            ? "当前项目还没有测试运行目录（qa/ui/runs、qa/api/runs）。"
            : "没有该类型的测试报告。",
        }));
      } else {
        const list = element("div", { class: "report-list" });
        for (const report of reports) list.append(renderReportCard(report));
        panel.append(list);
      }
      panel.append(renderReportPager(reportsData.pagination, (page) => {
        reportPage = page;
        void refreshReports();
      }, "报告列表分页", busy));
      if (reportsData.invalid > 0) {
        panel.append(element("p", {
          class: "right-panel__note",
          text: `${reportsData.invalid} 个批次缺少有效的 summary.json 或格式无效，未纳入报告。`,
        }));
      }
    }

    panel.append(statusLine());
    content.append(panel);
  }

  function renderReportSummary(totals) {
    const summary = element("div", { class: "report-summary" });
    const stat = (value, label, status) => element("span", {
      class: "report-summary__stat",
      dataset: { status },
    },
    element("strong", { text: String(value) }),
    element("span", { class: "report-summary__label", text: label }),
    );
    const other = (totals.incomplete ?? 0) + (totals.cancelled ?? 0);
    summary.append(element("div", { class: "report-summary__head" },
      stat(totals.total, "份报告", "total"),
      stat(totals.passed, "通过", "passed"),
      stat(totals.failed, "失败", "failed"),
      other > 0 ? stat(other, "其他", "other") : null,
    ));
    summary.append(reportMeter(
      { total: totals.total, passed: totals.passed, failed: totals.failed, other },
      `报告 ${totals.total} 份：通过 ${totals.passed}，失败 ${totals.failed}${other > 0 ? `，其他 ${other}` : ""}`,
      "report-summary__meter report-meter",
    ));
    return summary;
  }

  function renderReportFilters(totals) {
    const filters = element("div", {
      class: "report-filter",
      role: "group",
      "aria-label": "筛选测试报告类型",
    });
    const options = [
      ["all", "全部", totals.total],
      ["ui", "UI", totals.ui ?? 0],
      ["api", "接口", totals.api ?? 0],
    ];
    for (const [value, label, count] of options) {
      const button = element("button", {
        type: "button",
        class: "report-filter__button",
        "aria-pressed": String(reportKindFilter === value),
        disabled: busy,
        onclick: () => {
          if (reportKindFilter === value) return;
          reportKindFilter = value;
          reportPage = 1;
          expandedReports.clear();
          void refreshReports();
        },
      },
      element("span", { text: label }),
      element("span", { class: "report-filter__count", text: String(count) }),
      );
      filters.append(button);
    }
    return filters;
  }

  function renderReportPager(page, turn, label, loading = false) {
    const pager = element("div", { class: "case-catalog__pager", role: "group", "aria-label": label });
    if (!page) return pager;
    pager.append(
      element("button", { type: "button", class: "case-card__edit", text: "上一页", disabled: loading || page.page <= 1, onclick: () => turn(page.page - 1) }),
      element("span", { text: `第 ${page.page} / ${page.pages} 页 · 共 ${page.total} 条` }),
      element("button", { type: "button", class: "case-card__edit", text: "下一页", disabled: loading || page.page >= page.pages, onclick: () => turn(page.page + 1) }),
    );
    return pager;
  }

  function renderReportCard(report) {
    const key = reportKey(report);
    const expanded = expandedReports.has(key);
    const article = element("article", {
      class: "report-card",
      dataset: { kind: report.kind, status: report.status, reportKey: key },
    });
    const head = element("button", {
      type: "button",
      class: "report-card__head",
      "aria-expanded": String(expanded),
    });
    const line = element("span", { class: "report-card__line" },
      element("span", {
        class: "report-kind",
        dataset: { kind: report.kind },
        text: REPORT_KIND_LABELS[report.kind] ?? report.kind,
      }),
      element("span", {
        class: "report-card__title",
        text: reportTitle(report),
      }),
      ...(report.parentRunId ? [element("span", { class: "report-repair", text: "修复" })] : []),
      element("span", {
        class: "case-run",
        dataset: { status: report.status },
        text: RUN_STATUS_LABELS[report.status] ?? report.status,
      }),
      element("span", { class: "report-card__chevron", "aria-hidden": "true", text: "›" }),
    );
    const segments = reportSegments(report);
    const meta = [
      formatTime(report.finishedAt),
      report.testCount == null ? "用例数未知" : `${report.testCount} 例`,
      reportCountsText(report.counts),
    ].filter(Boolean).join(" · ");
    head.append(
      line,
      element("span", { class: "report-card__meta", text: meta }),
      reportMeter(
        segments,
        `${reportTitle(report)}：${meta}`,
        "report-card__meter report-meter",
      ),
    );

    const body = element("div", { class: "report-card__body" });
    body.hidden = !expanded;
    if (expanded && !busy) void loadReportDetail(report, body);
    head.addEventListener("click", () => {
      if (expandedReports.has(key)) {
        expandedReports.delete(key);
        body.hidden = true;
        head.setAttribute("aria-expanded", "false");
        return;
      }
      expandedReports.add(key);
      body.hidden = false;
      head.setAttribute("aria-expanded", "true");
      if (reportDetails.get(key)?.error) reportDetails.delete(key);
      void loadReportDetail(report, body);
    });
    article.append(head, body);
    return article;
  }

  function paintReportBody(body, key) {
    const cached = reportDetails.get(key);
    body.replaceChildren();
    if (!cached || cached.loading) {
      body.append(element("p", { class: "right-panel__empty", text: "正在读取报告详情…" }));
    } else if (cached.error) {
      body.append(element("p", { class: "right-panel__empty", text: `读取失败：${cached.error}` }));
    } else if (cached.detail) {
      body.append(renderReportDetail(cached.detail, body));
    }
  }

  async function loadReportDetail(report, body, page = null) {
    const key = reportKey(report);
    if (reportDetails.has(key) && page === null) {
      paintReportBody(body, key);
      return;
    }
    const projectId = selectedId;
    const pending = { loading: true };
    reportDetails.set(key, pending);
    paintReportBody(body, key);
    const current = () => selectedId === projectId && view === "reports" && reportDetails.get(key) === pending;
    try {
      const detail = await api().getTestReport(projectId, report.kind, report.id, { page: page ?? 1 });
      if (!detail || typeof detail !== "object") throw new Error("测试报告内容不可用。");
      if (current()) reportDetails.set(key, { detail });
    } catch (error) {
      if (current()) reportDetails.set(key, { error: errorMessage(error) });
    }
    if (selectedId === projectId && view === "reports") {
      for (const card of content.querySelectorAll(".report-card")) {
        if (card.dataset.reportKey === key) paintReportBody(card.querySelector(".report-card__body"), key);
      }
    }
  }

  function reportVerdictText(detail) {
    const segments = reportSegments(detail);
    return [
      `共 ${segments.total} 个用例`,
      reportCountsText(detail.counts),
    ].filter(Boolean).join(" · ");
  }

  function renderReportDetail(detail, body) {
    const box = element("div", { class: "report-detail" });
    const statusLabel = RUN_STATUS_LABELS[detail.status] ?? detail.status;
    const segments = reportSegments(detail);
    const rate = reportPassRate(segments);
    box.append(element("div", {
      class: "report-verdict",
      dataset: { status: detail.status },
    },
    element("div", { class: "report-verdict__score" },
      element("span", {
        class: "report-verdict__rate",
        text: rate === null ? "—" : `${rate}%`,
      }),
      element("span", { class: "report-verdict__rate-label", text: "通过率" }),
    ),
    element("div", { class: "report-verdict__summary" },
      element("div", { class: "report-verdict__headline" },
        element("span", { class: "report-verdict__label", text: "结论" }),
        element("span", { class: "report-verdict__status", text: statusLabel }),
      ),
      element("span", { class: "report-verdict__text", text: reportVerdictText(detail) }),
      reportMeter(
        segments,
        `本批次 ${segments.total} 个用例：通过 ${segments.passed}，失败 ${segments.failed}，其他 ${segments.other}`,
        "report-verdict__bar report-meter",
      ),
    ),
    ));

    const facts = element("div", { class: "report-detail__facts" });
    const fact = (label, value) => element("span", { class: "report-fact" },
      element("span", { class: "report-fact__label", text: label }),
      element("span", {
        class: "report-fact__value",
        text: value === "" || value === null || value === undefined ? "—" : String(value),
      }),
    );
    const moduleText = Array.isArray(detail.modulePath) && detail.modulePath.length > 0
      ? detail.modulePath.join(" / ")
      : detail.moduleName;
    facts.append(
      fact("模块", moduleText || "未标注"),
      fact("完成", formatTime(detail.finishedAt)),
      fact("耗时", formatDuration(detail.durationMs)),
      fact("清理", CLEANUP_LABELS[detail.cleanup] ?? detail.cleanup),
      fact("Trace", TRACE_POLICY_LABELS[detail.tracePolicy] ?? detail.tracePolicy),
    );
    if (detail.workflow === "browser-use-playwright") {
      facts.append(fact("用途", detail.purpose === "validate" ? "候选验证" : "正式回归"));
    }
    if (detail.parentRunId) facts.append(fact("修复来源", detail.parentRunId));
    if (detail.patchSummary) facts.append(fact("补丁说明", detail.patchSummary));
    if (detail.dataStrategy) facts.append(fact("数据策略", detail.dataCleanup ? `${detail.dataStrategy} · 清理 ${detail.dataCleanup}` : detail.dataStrategy));
    if (detail.writeAuthorization) facts.append(fact("写授权", `${detail.writeAuthorization.kind} · ${detail.writeAuthorization.reference}`));
    box.append(facts);

    if (detail.targetUrl) {
      box.append(element("p", {
        class: "report-detail__target",
        text: `目标：${detail.targetUrl}`,
      }));
    }
    const caseIds = detail.caseIds ?? [];
    if (caseIds.length > 0) {
      box.append(element("p", {
        class: "report-detail__meta",
        text: `范围：${caseIds.length} 个用例`,
      }));
    }

    if (detail.selections?.length) {
      const sources = element("details", { class: "report-sources" }, element("summary", { text: "查看版本与来源" }));
      for (const item of detail.selections) sources.append(element("p", { class: "report-detail__path", text: `${item.caseId} · 版本 ${item.revision} · 来源 ${item.taskId}` }));
      box.append(sources);
    }
    const tests = detail.tests ?? [];
    const failures = detail.failures ?? [];
    const failureCount = detail.failureCount ?? 0;
    box.append(element("p", {
      class: "report-detail__section-title",
      text: `失败与异常（${failureCount}）`,
    }));
    if (failureCount === 0) {
      box.append(element("p", { class: "report-detail__empty", text: "本次没有失败或异常用例。" }));
    } else {
      const list = element("ol", { class: "report-tests report-tests--failures" });
      for (const test of failures.slice(0, 5)) list.append(renderReportTest(test));
      box.append(list);
      if (failureCount > failures.length) {
        box.append(element("p", {
          class: "right-panel__note",
          text: `另有 ${failureCount - failures.length} 条失败或异常，见下方逐例明细。`,
        }));
      }
    }

    const problems = detail.problems ?? [];
    if (problems.length > 0) {
      box.append(element("p", { class: "report-detail__section-title", text: "报告问题" }));
      const list = element("ul", { class: "report-problems" });
      for (const problem of problems) list.append(element("li", { text: problem }));
      box.append(list);
    }

    box.append(element("p", { class: "report-detail__section-title", text: "执行与证据" }));
    const versions = detail.versions ?? {};
    const versionParts = [
      versions.node ? `Node ${versions.node}` : "",
      versions.playwright ? `Playwright ${versions.playwright}` : "",
      versions.files ? `版本文件 ${versions.files}` : "",
    ].filter(Boolean);
    if (versionParts.length > 0) {
      box.append(element("p", {
        class: "report-detail__meta",
        text: `运行环境：${versionParts.join(" · ")}`,
      }));
    }
    if (detail.limits) {
      box.append(element("p", { class: "report-detail__limits", text: detail.limits }));
    }
    if (detail.summaryPath) {
      box.append(element("p", {
        class: "report-detail__path",
        text: `报告文件：${detail.summaryPath}`,
      }));
    }

    if (tests.length > 0) {
      const details = element("details", { class: "report-cases", open: detail.pagination.page > 1 });
      details.append(element("summary", {
        text: `查看逐例结果（共 ${detail.pagination.total} 条）`,
      }));
      const list = element("ol", { class: "report-tests" });
      for (const test of tests) list.append(renderReportTest(test));
      details.append(list);
      details.append(renderReportPager(detail.pagination, (page) => {
        void loadReportDetail(detail, body, page);
      }, "逐例结果分页"));
      box.append(details);
    } else {
      box.append(element("p", { class: "report-detail__empty", text: "没有逐例结果。" }));
    }
    box.append(element("div", { class: "report-detail__actions" },
      element("button", {
        type: "button",
        class: "right-panel__action right-panel__action--danger",
        disabled: busy,
        onclick: () => void deleteReport(detail),
      }, icon("trash"), element("span", { text: "删除报告" })),
    ));
    return box;
  }

  async function deleteReport(report) {
    const projectId = selectedId;
    const confirmed = await confirmAction({
      title: "删除测试报告",
      message: `将删除报告「${reportTitle(report)}」及整个批次目录（摘要、证据、日志），不可恢复。正在执行、尚未收尾或仍被用例版本引用的批次不会被删除。`,
      confirmLabel: "删除报告",
    });
    if (selectedId !== projectId || view !== "reports") return;
    if (!confirmed) {
      setStatus("已取消删除。");
      return;
    }
    busy = true;
    setStatus("正在删除测试报告…");
    render();
    try {
      await api().deleteTestReport(projectId, report.kind, report.id);
      if (selectedId !== projectId || view !== "reports") return;
      const key = reportKey(report);
      expandedReports.delete(key);
      reportDetails.delete(key);
      await refreshReports();
      setStatus(`已删除测试报告「${reportTitle(report)}」。`);
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      render();
    }
  }

  function renderReportTest(test) {
    const item = element("li", {
      class: "report-test",
      dataset: { status: test.status },
    });
    item.append(
      element("div", { class: "report-test__head" },
        element("span", {
          class: "report-test__status",
          dataset: { status: test.status },
          text: CASE_STATUS_LABELS[test.status] ?? test.status,
        }),
        element("span", { class: "report-test__name", text: test.title }),
        element("span", {
          class: "report-test__time",
          text: test.durationMs === null ? "" : formatDuration(test.durationMs),
        }),
      ),
    );
    const where = test.file
      ? `${test.file}${test.line === null ? "" : `:${test.line}`}`
      : "";
    const evidence = (test.attachments ?? []).map((attachment) => attachment.name);
    const meta = [
      where,
      evidence.length > 0
        ? `证据：${evidence.slice(0, 3).join("、")}${evidence.length > 3 ? ` 等 ${evidence.length} 项` : ""}`
        : "",
    ].filter(Boolean);
    if (meta.length > 0) {
      item.append(element("p", { class: "report-test__meta", text: meta.join(" · ") }));
    }
    if (test.error) {
      item.append(element("p", { class: "report-test__error", text: test.error }));
    }
    return item;
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
        confirmDialog.removeEventListener("cancel", escapeHandler);
        if (confirmDialog.open) confirmDialog.close();
        resolve(value);
      };
      const cancelHandler = () => finish(false);
      const confirmHandler = () => finish(true);
      // 只听 Esc 的 cancel 事件，不监听异步派发的 close；否则上一次关闭排队中的
      // close 会命中下一次确认框的监听器并立即把它关掉。
      const escapeHandler = () => finish(false);
      cancel.addEventListener("click", cancelHandler);
      confirm.addEventListener("click", confirmHandler);
      confirmDialog.addEventListener("cancel", escapeHandler);
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
  function activeBrowserTab() {
    return browserTabs.find((tab) => tab.id === activeTabId) ?? null;
  }

  function openBrowser() {
    view = "browser";
    setStatus("");
    render();
  }

  function renderBrowserTabs() {
    if (!browserTabsList) return;
    browserTabsList.replaceChildren(...browserTabs.map((tab) => {
      const wrapper = element("div", { class: "browser-tab" });
      if (tab.id === activeTabId) wrapper.dataset.active = "true";
      const title = tab.title || (tab.url === "" ? "新标签页" : tab.url);
      const label = element("button", {
        type: "button",
        class: "browser-tab__label",
        title,
        text: title,
      });
      label.addEventListener("click", () => setActiveTab(tab.id));
      const close = element("button", {
        type: "button",
        class: "browser-tab__close",
        "aria-label": `关闭标签页：${title}`,
        title: "关闭标签页",
        text: "×",
      });
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeBrowserTab(tab.id);
      });
      wrapper.append(label, close);
      return wrapper;
    }));
  }

  function setActiveTab(id) {
    const tab = browserTabs.find((item) => item.id === id);
    if (!tab) return;
    activeTabId = id;
    browserView = tab.view;
    browserUrl = tab.url;
    browserLoading = tab.loading;
    browserTitle = tab.title;
    for (const item of browserTabs) item.page.hidden = item.id !== id;
    if (browserStart) browserStart.hidden = tab.url !== "";
    renderBrowserTabs();
    setNav(tab.title || "浏览器", () => go("home"));
    syncAddress();
    updateBrowserChrome();
    if (tab.url === "" && browserAddress && document.activeElement !== browserAddress) {
      browserAddress.focus();
    }
  }

  function addBrowserTab() {
    if (browserTabs.length >= MAX_BROWSER_TABS) {
      setStatusText(`最多打开 ${MAX_BROWSER_TABS} 个标签页。`, true);
      return null;
    }
    const tab = {
      id: `tab-${++browserTabSerial}`,
      url: "",
      title: "",
      loading: false,
      view: null,
      page: element("div", { class: "browser-page", hidden: "" }),
    };
    browserPages.append(tab.page);
    browserTabs.push(tab);
    setActiveTab(tab.id);
    return tab;
  }

  function closeBrowserTab(id) {
    const index = browserTabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const [tab] = browserTabs.splice(index, 1);
    tab.view?.remove();
    tab.page.remove();
    if (browserTabs.length === 0) {
      addBrowserTab();
      return;
    }
    if (activeTabId === id) {
      setActiveTab(browserTabs[Math.min(index, browserTabs.length - 1)].id);
      return;
    }
    renderBrowserTabs();
  }

  function ensureBrowserTab() {
    if (browserTabs.length === 0) addBrowserTab();
    return activeBrowserTab() ?? browserTabs[0] ?? null;
  }

  function navigateBrowser(url) {
    const tab = ensureBrowserTab();
    if (!tab) return;
    tab.url = url;
    tab.loading = true;
    browserUrl = url;
    browserLoading = true;
    setStatus("");
    if (browserStart) browserStart.hidden = true;

    if (tab.view && tab.view.isConnected) {
      try {
        tab.view.loadURL(url);
        syncAddress();
        updateBrowserChrome();
        renderBrowserTabs();
        return;
      } catch {
        // 尚未 dom-ready 时改为重建 webview，由 src 触发加载。
      }
    }
    tab.view?.remove();
    tab.view = createBrowserView(tab);
    tab.page.append(tab.view);
    tab.page.hidden = false;
    browserView = tab.view;
    syncAddress();
    updateBrowserChrome();
    renderBrowserTabs();
  }

  function syncAddress() {
    const input = browserLayer.querySelector(".browser-bar__address");
    if (input && document.activeElement !== input) input.value = browserUrl;
  }

  function setStatusText(text, error = false) {
    const node = content.querySelector(".right-panel__status")
      ?? browserLayer.querySelector(".right-panel__status");
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
    const reload = browserLayer.querySelector(".browser-bar__reload");
    if (reload) reload.replaceChildren(icon(browserLoading ? "stop" : "refresh"));
    const back = browserLayer.querySelector(".browser-bar__back");
    if (back) back.disabled = !canGo("back");
    const forward = browserLayer.querySelector(".browser-bar__forward");
    if (forward) forward.disabled = !canGo("forward");
    const external = browserLayer.querySelector(".browser-bar__external");
    if (external) external.disabled = browserUrl === "";
  }

  function createBrowserView(tab) {
    const view = document.createElement("webview");
    view.className = "right-panel__browser-view";
    view.setAttribute("partition", "persist:browser-panel");
    view.setAttribute("webpreferences", "contextIsolation=yes,sandbox=yes,nodeIntegration=no");
    view.setAttribute("src", tab.url);

    view.addEventListener("did-start-loading", () => {
      tab.loading = true;
      if (tab.id === activeTabId) {
        browserLoading = true;
        updateBrowserChrome();
      }
    });
    view.addEventListener("did-stop-loading", () => {
      tab.loading = false;
      if (tab.id === activeTabId) {
        browserLoading = false;
        updateBrowserChrome();
      }
    });
    view.addEventListener("did-navigate", (event) => {
      tab.url = event.url;
      if (tab.id === activeTabId) {
        browserUrl = event.url;
        syncAddress();
        updateBrowserChrome();
      }
      renderBrowserTabs();
    });
    view.addEventListener("did-navigate-in-page", (event) => {
      tab.url = event.url;
      if (tab.id === activeTabId) {
        browserUrl = event.url;
        syncAddress();
        updateBrowserChrome();
      }
      renderBrowserTabs();
    });
    view.addEventListener("page-title-updated", (event) => {
      tab.title = event.title;
      if (tab.id === activeTabId) {
        browserTitle = event.title;
        const title = document.querySelector(".right-panel__nav-title");
        if (title) title.textContent = browserTitle || "浏览器";
      }
      renderBrowserTabs();
    });
    view.addEventListener("did-fail-load", (event) => {
      // -3 是主动取消（例如停止或新导航），不属于加载失败。
      if (event.errorCode === -3) return;
      tab.loading = false;
      if (tab.id !== activeTabId) return;
      browserLoading = false;
      setStatusText(`页面加载失败：${event.errorDescription || event.errorCode}`, true);
      updateBrowserChrome();
    });
    return view;
  }

  function buildBrowserPanel() {
    // 与 DSH 一致：工具栏 + 页面贴边铺满，不使用内层卡片边框。
    const panel = element("div", { class: "right-panel right-panel--browser" });

    const tabsBar = element("div", { class: "browser-tabs" });
    browserTabsList = element("div", {
      class: "browser-tabs__list",
      role: "tablist",
      "aria-label": "浏览器标签页",
    });
    const newTab = element("button", {
      type: "button",
      class: "browser-tabs__new",
      "aria-label": "新建标签页",
      title: "新建标签页",
      text: "+",
    });
    newTab.addEventListener("click", () => { addBrowserTab(); });
    tabsBar.append(browserTabsList, newTab);

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

    browserSurface = element("div", { class: "right-panel__browser" });
    browserStart = element("p", {
      class: "right-panel__browser-start",
      text: "输入网址开始浏览。页面在独立会话中加载，不继承应用权限。",
    });
    browserPages = element("div", { class: "browser-pages" });
    browserSurface.append(browserStart, browserPages);
    panel.append(tabsBar, bar, browserSurface, statusLine());
    browserLayer.append(panel);
    browserAddress = address;
  }

  function renderBrowser() {
    if (!browserBuilt) {
      buildBrowserPanel();
      browserBuilt = true;
    }
    browserLayer.hidden = false;
    const tab = ensureBrowserTab();
    if (!tab) return;

    for (const item of browserTabs) item.page.hidden = item.id !== activeTabId;
    if (browserStart) browserStart.hidden = tab.url !== "";
    browserView = tab.view;
    browserUrl = tab.url;
    browserLoading = tab.loading;
    browserTitle = tab.title;
    setNav(tab.title || "浏览器", () => go("home"));
    renderBrowserTabs();
    if (tab.url === "" && document.activeElement !== browserAddress) browserAddress.focus();
    syncAddress();
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

  // 本轮改动：先读摘要；指定文件时再按需读取该文件的差异。
  async function openChanges(requestId, index = -1) {
    if (typeof requestId !== "string" || requestId === "") return;
    changesRequestId = requestId;
    changesIndex = Number.isInteger(index) ? index : -1;
    changesSummary = null;
    changesDiff = null;
    view = "changes";
    busy = true;
    setStatus("正在读取本轮改动…");
    render();

    try {
      const summary = await api().readWorkspaceChanges(requestId);
      if (!summary || !Array.isArray(summary.files)) {
        throw new Error("本轮没有可查看的改动。");
      }
      changesSummary = summary;
      if (changesIndex >= 0) {
        const diff = await api().readWorkspaceChangeDiff(requestId, changesIndex);
        if (!diff) throw new Error("该文件的差异已不可用。");
        changesDiff = diff;
      }
      setStatus("");
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      render();
    }
  }

  function renderChanges() {
    if (changesIndex >= 0 && changesDiff) {
      renderChangeDiff();
      return;
    }
    const total = changesSummary?.total ?? 0;
    setNav("本轮改动", () => go("home"), [
      iconButton("重新读取", "refresh", () => void openChanges(changesRequestId, changesIndex), busy),
    ]);

    const panel = element("div", { class: "right-panel right-panel--changes" });
    panel.append(statusLine());
    if (!changesSummary) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: busy ? "正在读取本轮改动…" : "无法读取本轮改动，请重新读取。",
      }));
      content.append(panel);
      return;
    }
    let added = 0;
    let deleted = 0;
    for (const file of changesSummary.files) {
      if (file.binary || file.oversized) continue;
      added += file.added || 0;
      deleted += file.deleted || 0;
    }
    const header = element("div", { class: "change-summary" });
    header.append(element("span", { text: `${total} 个文件` }));
    header.append(element("span", { class: "change-summary__stat", text: `+${added} −${deleted}` }));
    panel.append(header);

    if (changesSummary.files.length === 0) {
      panel.append(element("p", { class: "right-panel__empty", text: "本轮没有改动文件。" }));
      content.append(panel);
      return;
    }

    const list = element("ul", { class: "change-list" });
    for (const file of changesSummary.files) {
      const item = element("li");
      const button = element("button", {
        type: "button",
        class: "change-file",
        title: `查看 ${file.display} 的差异`,
      });
      button.append(element("span", { class: "change-file__path", text: file.display }));
      const stat = file.binary ? "二进制" : file.oversized ? "过大" : `+${file.added} −${file.deleted}`;
      const statNode = element("span", { class: "change-file__stat", text: stat });
      if (file.binary) statNode.dataset.kind = "binary";
      if (file.oversized) statNode.dataset.kind = "oversized";
      button.append(statNode);
      button.addEventListener("click", () => {
        void openChanges(changesRequestId, file.index);
      });
      item.append(button);
      list.append(item);
    }
    panel.append(list);
    if (changesSummary.truncated) {
      panel.append(element("p", { class: "change-note", text: `共 ${total} 个文件，仅列出前 ${changesSummary.files.length} 个。` }));
    }
    content.append(panel);
  }

  function renderChangeDiff() {
    const diff = changesDiff;
    setNav(diff.display, () => {
      changesIndex = -1;
      changesDiff = null;
      render();
    }, [
      iconButton("重新读取", "refresh", () => void openChanges(changesRequestId, changesIndex), busy),
    ]);

    const panel = element("div", { class: "right-panel right-panel--change" });
    panel.append(statusLine());
    const header = element("div", { class: "change-summary" });
    header.append(element("span", { text: diff.binary || diff.oversized ? "文件对比" : "逐行差异" }));
    const stat = diff.binary ? "二进制" : diff.oversized ? "过大" : `+${diff.added} −${diff.deleted}`;
    header.append(element("span", { class: "change-summary__stat", text: stat }));
    panel.append(header);

    if (diff.kind === "binary") {
      panel.append(element("p", { class: "change-note", text: "二进制文件，不提供逐行对比。" }));
    } else if (diff.kind === "oversized") {
      panel.append(element("p", { class: "change-note", text: "文件超过 2 MiB，不提供逐行对比。" }));
    } else if (diff.kind === "missing") {
      panel.append(element("p", { class: "change-note", text: "记录的内容已不可用，可能已经清理。" }));
    } else if (diff.kind !== "text") {
      panel.append(element("p", { class: "change-note", text: "无法读取该文件的差异。" }));
    } else if (diff.coarse) {
      panel.append(element("p", {
        class: "change-note",
        text: `文件较大，已按整文件变化处理：−${diff.deleted} / +${diff.added} 行。`,
      }));
    } else if (!Array.isArray(diff.hunks) || diff.hunks.length === 0) {
      panel.append(element("p", { class: "change-note", text: "内容没有变化。" }));
    } else {
      const box = element("div", { class: "change-diff", tabindex: "0", role: "region", "aria-label": "逐行差异，可横向滚动" });
      const MAX_RENDER_ROWS = 2000;
      let rendered = 0;
      let clipped = false;
      for (const hunk of diff.hunks) {
        if (rendered >= MAX_RENDER_ROWS) {
          clipped = true;
          break;
        }
        box.append(element("div", {
          class: "change-hunk",
          text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
        }));
        for (const row of hunk.rows) {
          if (rendered >= MAX_RENDER_ROWS) {
            clipped = true;
            break;
          }
          rendered += 1;
          const line = element("div", { class: "change-row" });
          line.dataset.kind = row.kind;
          line.append(element("span", { class: "change-row__num", text: row.oldLine === null ? "" : String(row.oldLine) }));
          line.append(element("span", { class: "change-row__num", text: row.newLine === null ? "" : String(row.newLine) }));
          line.append(element("span", { class: "change-row__sign", text: row.kind === "add" ? "+" : row.kind === "remove" ? "−" : "" }));
          line.append(element("span", { class: "change-row__text", text: row.text === "" ? " " : row.text }));
          box.append(line);
        }
      }
      panel.append(box);
      if (clipped || diff.truncated) {
        panel.append(element("p", { class: "change-note", text: "差异过长，页面仅显示前一部分。" }));
      }
    }
    content.append(panel);
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
    content.append(panel);
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
    content.append(panel);
  }

  // 切换会话后旧路径不再属于当前工作目录，文件与文件树都回到工作台。
  function resetWorkspaceView() {
    treeChildren.clear();
    treeExpanded.clear();
    treeRootEntries = null;
    changesSummary = null;
    changesDiff = null;
    changesIndex = -1;
    if (view === "file" || view === "files" || view === "changes") go("home");
  }

  return { open, refresh: open, openFile, openFiles: openTree, openReports, openChanges, resetWorkspaceView };
}

// 右侧栏内容：工作台卡片、项目环境 CRUD、测试数据、UI/接口测试报告与文件预览。
// 内容只通过受限 IPC 读写；密码不会从主进程回填到页面。
import { renderMarkdown } from "./markdown-renderer.js";
import { normalizeBrowserUrl } from "./browser-url.js";

const SIZE_UNITS = ["B", "KB", "MB", "GB"];
const CASE_TYPE_LABELS = {
  functional: "功能",
  permission: "权限",
  boundary: "边界",
  exception: "异常",
  regression: "回归",
};
const DATA_POLICY_LABELS = {
  "read-only": "只读",
  "write-unique": "写入（唯一数据）",
  "write-disposable": "写入（可清理）",
  "no-write": "不写数据",
};
const ASSERTION_KIND_LABELS = { business: "业务", guard: "前置" };
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
  const expandedCases = new Set();
  let editingAssertions = null;
  const collapsedModules = new Set();
  let reportsData = null;
  let reportKindFilter = "all";
  const expandedReports = new Set();
  const reportDetails = new Map();
  let status = { text: "", error: false };
  let busy = false;
  let currentFile = null;
  let currentFilePath = "";
  let fileOrigin = "home";
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
    if (data.catalog) return `${data.catalog.totals.cases} 条用例`;
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
        description: "查看并清理 qa/data 中的测试文件",
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
    if (environments.length === 0) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: "还没有项目环境。先添加项目，才能读取它的 qa/data。",
      }));
      panel.append(statusLine());
      content.append(panel);
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
      caseQuery = "";
      expandedCases.clear();
      collapsedModules.clear();
      editingAssertions = null;
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
    } else if (data.items.length === 0 && !data.catalog?.modules?.length) {
      panel.append(element("p", {
        class: "right-panel__empty",
        text: "qa/data 下暂无测试数据。",
      }));
    } else {
      const catalog = data.catalog;
      if (catalog?.modules?.length) {
        panel.append(renderCaseCatalog(catalog));
        if (catalog.truncated) {
          panel.append(element("p", {
            class: "right-panel__note",
            text: "标准化用例超过 200 个，仅展示前 200 个资产。",
          }));
        }
      } else {
        if (catalog?.lastRun) panel.append(renderRunLine(catalog.lastRun));
        panel.append(element("p", {
          class: "right-panel__empty",
          text: "暂无标准化用例。使用 qa-ui-record 录制后，会按实际项目模块层级展示。",
        }));
      }
      if (catalog?.legacy?.length) {
        panel.append(element("p", {
          class: "right-panel__note",
          text: `${catalog.legacy.length} 个资产未包含 qa-ui-case 元数据，未纳入目录。`,
        }));
      }
    }

    panel.append(statusLine());
    content.append(panel);
  }

  // 目录策略覆盖整棵树；旧节点没有 policies 时退回 dataPolicy。
  function catalogPolicies(modules) {
    const policies = new Set();
    const stack = [...modules];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const policy of node.policies ?? []) policies.add(policy);
      if (node.dataPolicy && node.dataPolicy !== "mixed") policies.add(node.dataPolicy);
      stack.push(...(node.children ?? []));
    }
    return [...policies].filter(Boolean);
  }

  function moduleCaseCount(node) {
    return node.caseCount ?? ((node.cases?.length ?? 0) +
      (node.children ?? []).reduce((total, child) => total + moduleCaseCount(child), 0));
  }

  function moduleMetaText(node) {
    const pages = node.pages?.length ? node.pages : node.page ? [node.page] : [];
    const roles = node.roles?.length ? node.roles : node.role ? [node.role] : [];
    const pageText = pages.length === 1
      ? pages[0]
      : pages.length > 1
        ? `${pages.length} 个页面`
        : "";
    const roleText = roles.length === 1
      ? roles[0]
      : roles.length > 1
        ? `${roles.length} 个角色`
        : "";
    return [pageText, roleText].filter(Boolean).join(" · ");
  }

  function moduleMatchText(node) {
    return [
      node.title,
      ...(node.path ?? []),
      node.page,
      node.role,
      ...(node.pages ?? []),
      ...(node.roles ?? []),
      ...(node.tags ?? []),
    ].join(" ").toLowerCase();
  }

  function caseMatchText(item) {
    return [
      item.name,
      item.type,
      item.priority,
      item.page,
      item.role,
      ...(item.assertions ?? []).flatMap((assertion) => [assertion.text, assertion.source]),
    ].join(" ").toLowerCase();
  }

  // 命中的父节点保留完整子树；只命中用例时保留其祖先路径。
  function filterCaseModule(node, needle) {
    if (moduleMatchText(node).includes(needle)) return node;
    const cases = (node.cases ?? []).filter((item) => caseMatchText(item).includes(needle));
    const children = [];
    for (const child of node.children ?? []) {
      const filtered = filterCaseModule(child, needle);
      if (filtered) children.push(filtered);
    }
    if (cases.length === 0 && children.length === 0) return null;
    return {
      ...node,
      cases,
      children,
      caseCount: cases.length +
        children.reduce((total, child) => total + moduleCaseCount(child), 0),
    };
  }

  function renderCaseCatalog(catalog) {
    const container = element("div", { class: "case-catalog" });
    const summary = element("div", { class: "case-catalog__summary" });
    const stat = (value, label) => element("span", { class: "case-catalog__stat" },
      element("strong", { text: String(value) }),
      label,
    );
    summary.append(
      stat(catalog.totals.modules, "模块"),
      catalog.totals.submodules > 0 ? stat(catalog.totals.submodules, "子模块") : null,
      stat(catalog.totals.cases, "用例"),
      stat(catalog.totals.assertions, "断言"),
    );
    const policies = catalogPolicies(catalog.modules);
    summary.append(element("span", {
      class: "case-catalog__policy",
      text: policies.length === 1
        ? DATA_POLICY_LABELS[policies[0]] ?? policies[0]
        : policies.length > 1
          ? "混合数据策略"
          : "—",
    }));

    const search = element("input", {
      type: "search",
      class: "case-catalog__search",
      placeholder: "搜索用例、断言、模块或标签",
      "aria-label": "搜索用例",
      value: caseQuery,
    });
    const list = element("div", { class: "case-catalog__list" });
    const paint = () => {
      list.replaceChildren(...renderCaseModules(catalog, caseQuery));
    };
    let filtering = Boolean(caseQuery.trim());
    search.addEventListener("input", () => {
      caseQuery = search.value;
      const nextFiltering = Boolean(caseQuery.trim());
      // 开始搜索时展开所有分支，避免命中结果藏在折叠节点内。
      if (nextFiltering && !filtering) collapsedModules.clear();
      filtering = nextFiltering;
      paint();
    });
    paint();

    container.append(summary, renderRunLine(catalog.lastRun), search, list);
    return container;
  }

  function renderRunLine(run) {
    const line = element("div", { class: "case-catalog__run" });
    if (!run) {
      line.append(element("span", {
        class: "case-catalog__run-text",
        text: "尚无运行结果",
      }));
      return line;
    }
    line.append(
      element("span", {
        class: "case-run",
        dataset: { status: run.status },
        text: RUN_STATUS_LABELS[run.status] ?? run.status,
      }),
      element("span", {
        class: "case-catalog__run-text",
        text: `最近运行 ${formatTime(run.finishedAt)} · ${run.passed}/${run.total} 通过`,
      }),
    );
    return line;
  }

  function renderCaseModules(catalog, query) {
    const needle = query.trim().toLowerCase();
    const sections = [];
    for (const module of catalog.modules) {
      const filtered = needle ? filterCaseModule(module, needle) : module;
      if (filtered) sections.push(renderCaseModule(filtered));
    }
    if (sections.length === 0) {
      sections.push(element("p", {
        class: "case-catalog__empty",
        text: "没有匹配的用例。",
      }));
    }
    return sections;
  }

  function renderCaseModule(module) {
    const depth = Number.isInteger(module.depth) ? module.depth : 0;
    const cases = module.cases ?? [];
    const children = module.children ?? [];
    const key = module.key ?? [...(module.path ?? [module.title])].join("\u001f");
    const expanded = !collapsedModules.has(key);
    const section = element("section", {
      class: `case-module${depth > 0 ? " case-module--nested" : ""}`,
      dataset: { depth: String(depth) },
    });

    const header = element("button", {
      type: "button",
      class: "case-module__head",
      "aria-expanded": String(expanded),
    });
    const title = element("div", { class: "case-module__title" },
      element("span", { class: "case-module__name", text: module.title }),
    );
    const meta = moduleMetaText(module);
    if (meta) title.append(element("span", { class: "case-module__page", text: meta }));
    header.append(
      element("span", { class: "case-module__chevron", "aria-hidden": "true", text: "›" }),
      title,
      element("span", { class: "case-module__count", text: `${moduleCaseCount(module)} 条` }),
    );
    section.append(header);

    const body = element("div", { class: "case-module__body" });
    body.hidden = !expanded;
    if ((module.tags ?? []).length > 0) {
      body.append(element("div", { class: "case-module__tags" },
        module.tags.slice(0, 4).map((tag) => element("span", { class: "case-tag", text: tag })),
      ));
    }
    if (cases.length > 0) {
      const list = element("div", { class: "case-module__cases" });
      for (const item of cases) list.append(renderCaseCard(module, item));
      body.append(list);
    }
    if (children.length > 0) {
      const group = element("div", { class: "case-module__children" });
      for (const child of children) group.append(renderCaseModule(child));
      body.append(group);
    }
    section.append(body);

    header.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      header.setAttribute("aria-expanded", String(open));
      if (open) collapsedModules.delete(key);
      else collapsedModules.add(key);
    });
    return section;
  }

  function renderCaseCard(module, item) {
    const key = `${item.assetPath}::${item.name}`;
    const editing = editingAssertions?.key === key;
    const expanded = expandedCases.has(key) || editing;
    const businessAssertions = item.assertions.filter((assertion) => assertion.kind === "business");
    const guardAssertions = item.assertions.filter((assertion) => assertion.kind === "guard");
    const previewAssertion = businessAssertions[0] ?? item.assertions[0] ?? null;
    const article = element("article", { class: "case-card" });
    const head = element("button", {
      type: "button",
      class: "case-card__head",
      "aria-expanded": String(expanded),
    });
    head.append(
      element("span", {
        class: "case-card__priority",
        dataset: { priority: item.priority },
        text: item.priority,
      }),
      element("span", { class: "case-card__name", text: item.name }),
      element("span", {
        class: "case-card__meta",
        text: `${CASE_TYPE_LABELS[item.type] ?? item.type} · 业务 ${businessAssertions.length} · 前置 ${guardAssertions.length}`,
      }),
      element("span", {
        class: "case-card__status",
        dataset: { status: item.lastResult?.status ?? "not-run" },
        text: CASE_STATUS_LABELS[item.lastResult?.status] ?? "未运行",
      }),
      element("span", { class: "case-card__chevron", "aria-hidden": "true", text: "›" }),
    );

    const preview = element("p", {
      class: "case-card__assertion-preview",
      text: previewAssertion ? `${previewAssertion.id} ${previewAssertion.text}` : "未登记断言",
    });
    preview.hidden = expanded;

    const detail = element("div", { class: "case-card__body" });
    detail.hidden = !expanded;
    if (editing) {
      detail.append(renderAssertionEditor(item));
    } else {
      const modulePath = (module.path ?? [module.title]).join(" / ");
      const casePage = item.page ?? module.page ?? "";
      const caseRole = item.role ?? module.role ?? "";
      detail.append(element("p", {
        class: "case-card__context",
        text: [
          `模块 ${modulePath}`,
          casePage ? `页面 ${casePage}` : "",
          caseRole ? `角色 ${caseRole}` : "",
        ].filter(Boolean).join(" · "),
      }));
      detail.append(element("p", {
        class: "case-card__result",
        text: item.lastResult
          ? `最近运行 ${CASE_STATUS_LABELS[item.lastResult.status] ?? item.lastResult.status} · ${formatTime(item.lastResult.finishedAt)}${item.lastResult.durationMs === null ? "" : ` · ${item.lastResult.durationMs} ms`}`
          : "最近运行：未运行",
      }));
      if (item.assertions.length > 0) {
        if (businessAssertions.length) {
          detail.append(element("div", { class: "case-assertions__label", text: `业务断言 ${businessAssertions.length}` }));
          detail.append(renderAssertionList(businessAssertions));
        }
        if (guardAssertions.length) {
          detail.append(element("div", { class: "case-assertions__label", text: `前置断言 ${guardAssertions.length}` }));
          detail.append(renderAssertionList(guardAssertions));
        }
        const edit = element("button", {
          type: "button",
          class: "case-card__edit",
          disabled: busy,
          text: "编辑断言",
        });
        edit.addEventListener("click", () => {
          editingAssertions = {
            key,
            assetPath: item.assetPath,
            caseName: item.name,
            draft: item.assertions.map((assertion, index) => ({
              id: assertion.id || `A${index + 1}`,
              kind: assertion.kind === "guard" ? "guard" : "business",
              text: assertion.text,
              source: assertion.source,
            })),
          };
          expandedCases.add(key);
          render();
        });
        detail.append(edit);
      } else {
        detail.append(element("p", { class: "case-card__context", text: "该用例没有登记断言。" }));
      }

      const files = [
        ["资产", item.assetPath],
        ["脚本", item.specPath],
        ["说明", item.documentPath],
        ["录制", item.recordedAt ? formatTime(item.recordedAt) : ""],
      ].filter(([, value]) => value);
      if (files.length > 0) {
        detail.append(element("dl", { class: "case-card__files" },
          files.flatMap(([label, value]) => [
            element("dt", { text: label }),
            element("dd", { text: value }),
          ]),
        ));
      }
    }

    head.addEventListener("click", () => {
      const open = detail.hidden;
      detail.hidden = !open;
      preview.hidden = open;
      head.setAttribute("aria-expanded", String(open));
      if (open) expandedCases.add(key);
      else expandedCases.delete(key);
    });

    article.append(head, preview, detail);
    return article;
  }

  function renderAssertionList(assertions) {
    const list = element("ol", { class: "case-assertions" });
    for (const assertion of assertions) {
      list.append(element("li", { class: "case-assertion" },
        element("span", { class: "case-assertion__id", text: assertion.id }),
        element("div", { class: "case-assertion__body" },
          element("p", { class: "case-assertion__text", text: assertion.text }),
          assertion.source
            ? element("p", { class: "case-assertion__source", text: `来源：${assertion.source}` })
            : null,
        ),
        element("span", {
          class: "case-assertion__kind",
          dataset: { kind: assertion.kind },
          text: ASSERTION_KIND_LABELS[assertion.kind] ?? assertion.kind,
        }),
      ));
    }
    return list;
  }

  function renderAssertionEditor(item) {
    const draft = editingAssertions.draft;
    const container = element("div", { class: "case-editor" });
    container.append(element("p", {
      class: "case-editor__hint",
      text: "编辑只更新用例说明和资产中的断言记录，不修改 spec 代码。",
    }));
    const rows = element("div", { class: "case-editor__list" });
    for (const [index, assertion] of draft.entries()) {
      const row = element("div", { class: "case-editor__row" });
      const kind = element("select", { class: "case-editor__kind", "aria-label": "断言类型" });
      kind.append(
        element("option", { value: "business", text: "业务", selected: assertion.kind !== "guard" }),
        element("option", { value: "guard", text: "前置", selected: assertion.kind === "guard" }),
      );
      kind.addEventListener("change", () => { assertion.kind = kind.value === "guard" ? "guard" : "business"; });
      const content = element("input", {
        type: "text",
        class: "case-editor__text",
        placeholder: "断言内容",
        "aria-label": "断言内容",
        value: assertion.text,
      });
      content.addEventListener("input", () => { assertion.text = content.value; });
      const source = element("input", {
        type: "text",
        class: "case-editor__source",
        placeholder: "断言来源",
        "aria-label": "断言来源",
        value: assertion.source,
      });
      source.addEventListener("input", () => { assertion.source = source.value; });
      const remove = element("button", {
        type: "button",
        class: "case-editor__remove",
        "aria-label": `删除断言 ${assertion.id || index + 1}`,
        text: "删除",
      });
      remove.addEventListener("click", () => {
        if (draft.length <= 1) {
          setStatus("至少保留一条断言。", true);
          render();
          return;
        }
        draft.splice(index, 1);
        render();
      });
      row.append(
        element("span", { class: "case-editor__id", text: assertion.id || `A${index + 1}` }),
        kind,
        content,
        source,
        remove,
      );
      rows.append(row);
    }
    container.append(rows);

    const actions = element("div", { class: "case-editor__actions" });
    const add = element("button", { type: "button", class: "case-editor__button", text: "新增断言" });
    add.addEventListener("click", () => {
      draft.push({ id: `A${draft.length + 1}`, kind: "business", text: "", source: "" });
      render();
    });
    const save = element("button", {
      type: "button",
      class: "case-editor__button case-editor__button--primary",
      text: "保存断言",
      disabled: busy,
    });
    save.addEventListener("click", () => void saveAssertions(item));
    const cancel = element("button", { type: "button", class: "case-editor__button", text: "取消" });
    cancel.addEventListener("click", () => {
      editingAssertions = null;
      render();
    });
    actions.append(add, save, cancel);
    container.append(actions);
    return container;
  }

  async function saveAssertions(item) {
    const draft = editingAssertions?.draft ?? [];
    const assertions = draft.map((assertion, index) => ({
      id: assertion.id || `A${index + 1}`,
      kind: assertion.kind === "guard" ? "guard" : "business",
      text: assertion.text.trim(),
      source: assertion.source.trim(),
    }));
    if (assertions.some((assertion) => !assertion.text || !assertion.source)) {
      setStatus("断言内容和来源不能为空。", true);
      render();
      return;
    }
    if (!assertions.some((assertion) => assertion.kind === "business")) {
      setStatus("至少保留一条业务断言。", true);
      render();
      return;
    }
    busy = true;
    setStatus("正在保存断言…");
    render();
    try {
      await api().updateTestCaseAssertions(selectedId, item.assetPath, item.name, assertions);
      await loadData();
      editingAssertions = null;
      setStatus("断言已保存。");
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      busy = false;
      render();
    }
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

  function reportKey(report) {
    return `${report.kind}:${report.id}`;
  }

  function reportCountsText(counts) {
    return Object.entries(counts ?? {})
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .map(([status, value]) => `${CASE_STATUS_LABELS[status] ?? status} ${value}`)
      .join(" · ");
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
    expandedReports.clear();
    reportDetails.clear();
    setStatus("");
    render();
    void refreshReports();
  }

  async function refreshReports() {
    if (!selectedId) {
      reportsData = null;
      render();
      return;
    }
    const projectId = selectedId;
    busy = true;
    render();
    try {
      const result = await api().listTestReports(projectId);
      if (selectedId === projectId) {
        reportsData = { projectId, ...result };
      }
    } catch (error) {
      if (selectedId === projectId) {
        reportsData = {
          projectId,
          available: false,
          reports: [],
          truncated: false,
          invalid: 0,
          totals: reportTotals([]),
          error: errorMessage(error),
        };
      }
    } finally {
      busy = false;
      if (selectedId === projectId) render();
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
      class: "right-panel__select",
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
      expandedCases.clear();
      editingAssertions = null;
      collapsedModules.clear();
      reportsData = null;
      reportKindFilter = "all";
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
      if (reports.length === 0) {
        panel.append(element("p", {
          class: "right-panel__empty",
          text: reportsData.available
            ? "当前项目还没有测试报告。执行 UI 或接口测试后，这里会显示批次结果。"
            : "当前项目还没有测试运行目录（qa/ui/runs、qa/api/runs）。",
        }));
      } else {
        const totals = reportsData.totals?.total === undefined
          ? reportTotals(reports)
          : reportsData.totals;
        panel.append(renderReportSummary(totals), renderReportFilters(totals));
        const filtered = reportKindFilter === "all"
          ? reports
          : reports.filter((report) => report.kind === reportKindFilter);
        if (filtered.length === 0) {
          panel.append(element("p", {
            class: "right-panel__empty",
            text: "没有该类型的测试报告。",
          }));
        } else {
          const list = element("div", { class: "report-list" });
          for (const report of filtered) list.append(renderReportCard(report));
          panel.append(list);
        }
        if (reportsData.truncated) {
          panel.append(element("p", {
            class: "right-panel__note",
            text: "测试报告超过 50 份，仅展示最近 50 份。",
          }));
        }
      }
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
    const stat = (value, label) => element("span", { class: "report-summary__stat" },
      element("strong", { text: String(value) }),
      label,
    );
    summary.append(
      stat(totals.total, "份报告"),
      stat(totals.passed, "通过"),
      stat(totals.failed, "失败"),
    );
    const other = (totals.incomplete ?? 0) + (totals.cancelled ?? 0);
    if (other > 0) summary.append(stat(other, "其他"));
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
        onclick: () => {
          if (reportKindFilter === value) return;
          reportKindFilter = value;
          render();
        },
      },
      element("span", { text: label }),
      element("span", { class: "report-filter__count", text: String(count) }),
      );
      filters.append(button);
    }
    return filters;
  }

  function renderReportCard(report) {
    const key = reportKey(report);
    const expanded = expandedReports.has(key);
    const article = element("article", {
      class: "report-card",
      dataset: { kind: report.kind, status: report.status },
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
        text: report.runId || report.id,
      }),
      element("span", {
        class: "case-run",
        dataset: { status: report.status },
        text: RUN_STATUS_LABELS[report.status] ?? report.status,
      }),
      element("span", { class: "report-card__chevron", "aria-hidden": "true", text: "›" }),
    );
    const meta = [
      formatTime(report.finishedAt),
      report.testCount == null ? "用例数未知" : `${report.testCount} 例`,
      reportCountsText(report.counts),
    ].filter(Boolean).join(" · ");
    head.append(line, element("span", { class: "report-card__meta", text: meta }));

    const body = element("div", { class: "report-card__body" });
    body.hidden = !expanded;
    if (expanded) paintReportBody(body, key);
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
      body.append(renderReportDetail(cached.detail));
    }
  }

  async function loadReportDetail(report, body) {
    const key = reportKey(report);
    if (reportDetails.has(key)) {
      paintReportBody(body, key);
      return;
    }
    const projectId = selectedId;
    reportDetails.set(key, { loading: true });
    paintReportBody(body, key);
    try {
      const detail = await api().getTestReport(projectId, report.kind, report.id);
      if (!detail || typeof detail !== "object") throw new Error("测试报告内容不可用。");
      if (selectedId === projectId) reportDetails.set(key, { detail });
    } catch (error) {
      if (selectedId === projectId) reportDetails.set(key, { error: errorMessage(error) });
    }
    if (selectedId === projectId) paintReportBody(body, key);
  }

  function renderReportDetail(detail) {
    const box = element("div", { class: "report-detail" });
    const facts = element("div", { class: "report-detail__facts" });
    const fact = (label, value) => element("span", { class: "report-fact" },
      element("span", { class: "report-fact__label", text: label }),
      element("span", {
        class: "report-fact__value",
        text: value === "" || value === null || value === undefined ? "—" : String(value),
      }),
    );
    facts.append(
      fact("用例", detail.testCount == null ? "未知" : `${detail.testCount} 例`),
      fact("耗时", formatDuration(detail.durationMs)),
      fact("清理", CLEANUP_LABELS[detail.cleanup] ?? detail.cleanup),
      fact("Trace", TRACE_POLICY_LABELS[detail.tracePolicy] ?? detail.tracePolicy),
    );
    box.append(facts);

    if (detail.targetUrl) {
      box.append(element("p", {
        class: "report-detail__target",
        text: `目标：${detail.targetUrl}`,
      }));
    }
    const caseIds = detail.caseIds ?? [];
    if (caseIds.length > 0) {
      const shown = caseIds.slice(0, 3).join("、");
      box.append(element("p", {
        class: "report-detail__meta",
        text: `范围：${shown}${caseIds.length > 3 ? ` 等 ${caseIds.length} 个` : ""}`,
      }));
    }
    const counts = reportCountsText(detail.counts);
    if (counts) {
      box.append(element("p", { class: "report-detail__meta", text: `统计：${counts}` }));
    }

    const tests = detail.tests ?? [];
    if (tests.length === 0) {
      box.append(element("p", { class: "report-detail__empty", text: "没有逐例结果。" }));
    } else {
      const list = element("ol", { class: "report-tests" });
      for (const test of tests) list.append(renderReportTest(test));
      box.append(list);
      if (detail.testsTruncated) {
        box.append(element("p", { class: "right-panel__note", text: "仅展示前 100 条逐例结果。" }));
      }
    }

    const problems = detail.problems ?? [];
    if (problems.length > 0) {
      box.append(element("p", { class: "report-detail__section-title", text: "摘要问题" }));
      const list = element("ul", { class: "report-problems" });
      for (const problem of problems) list.append(element("li", { text: problem }));
      box.append(list);
    }

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
    return box;
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
    if (view === "file" || view === "files") go("home");
  }

  return { open, refresh: open, openFile, openFiles: openTree, openReports, resetWorkspaceView };
}

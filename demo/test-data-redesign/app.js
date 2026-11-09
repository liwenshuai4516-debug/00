(() => {
  "use strict";

  const STORAGE_KEY = "swqa.test-data.demo.v1";
  const THEME_KEY = "swqa.test-data.demo.theme";
  const SCHEMA = 1;
  const MAX_FOLDER_DEPTH = 8;
  const MAX_FOLDER_PART = 80;
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  const STATUS = {
    verified: { label: "正式", icon: "check" },
    candidate: { label: "候选", icon: "sparkles" },
    draft: { label: "草稿", icon: "draft" },
  };
  const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const icon = (name, className = "icon") =>
    `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  let state;
  let storageOK = true;
  const ui = {
    folder: "",
    query: "",
    folderQuery: "",
    status: "all",
    sort: "updated",
    expanded: new Set(),
    openCaseId: null,
    editingId: null,
    drawerReturn: null,
  };

  /* ---------- 示例数据 ---------- */

  function seedState() {
    const now = Date.now();
    const ago = (offset) => new Date(now - offset).toISOString();
    return {
      schema: SCHEMA,
      folders: [],
      lastSavedAt: null,
      cases: [
        {
          id: "case-contract-query",
          title: "经营合同列表按合同编号查询、空结果与重置",
          folder: "合同管理/经营合同",
          role: "项目管理系统管理员",
          status: "verified",
          revision: "0004",
          priority: "P1",
          description: "验证经营合同列表按合同编号查询的完整链路：命中时仅展示匹配合同，未命中时展示空状态且不报错，点击重置后恢复默认列表与筛选条件。",
          steps: [
            "登录项目管理系统，进入「合同管理 / 经营合同」列表。",
            "在合同编号输入框输入已存在的编号 CT-2026-001，点击查询。",
            "清空编号，输入不存在的编号 CT-9999-999，点击查询。",
            "点击「重置」，观察列表与筛选条件。",
          ],
          expected: "命中查询仅返回编号对应的合同；无结果时展示「暂无匹配合同」空状态且页面不报错；重置后筛选条件清空，列表恢复默认分页。",
          lastRun: { status: "passed", at: ago(4 * HOUR) },
          createdAt: ago(30 * DAY),
          updatedAt: ago(32 * MINUTE),
        },
        {
          id: "case-contract-create",
          title: "经营合同新增：必填项校验与金额格式",
          folder: "合同管理/经营合同",
          role: "合同经办人",
          status: "candidate",
          revision: null,
          priority: "P1",
          description: "覆盖新增合同弹窗的必填项、金额格式与提交拦截，确认前端校验提示与后端错误提示一致。",
          steps: [
            "进入「合同管理 / 经营合同」，点击「新增合同」。",
            "不填写任何内容直接提交。",
            "填写合同名称，在金额输入 -100、1,234.567 后分别提交。",
            "修正为 1234.56，补齐必填项后保存。",
          ],
          expected: "必填项逐一提示且不发起提交；金额拒绝负数与超过两位小数；修正后保存成功并回到列表首行。",
          lastRun: null,
          createdAt: ago(4 * DAY),
          updatedAt: ago(26 * HOUR),
        },
        {
          id: "case-contract-edit",
          title: "经营合同编辑保存后列表与详情同步",
          folder: "合同管理/经营合同",
          role: "合同经办人",
          status: "verified",
          revision: "0003",
          priority: "P2",
          description: "验证编辑合同名称、金额后，列表缓存、详情页与刷新后的数据保持一致。",
          steps: [
            "打开一条经营合同的详情页，点击编辑。",
            "修改合同名称与金额并保存。",
            "返回列表查看对应行，再刷新页面重新进入详情。",
          ],
          expected: "保存成功提示出现；列表行、详情页与刷新后数据一致，无旧值残留。",
          lastRun: { status: "passed", at: ago(2 * DAY + 4 * HOUR) },
          createdAt: ago(18 * DAY),
          updatedAt: ago(2 * DAY),
        },
        {
          id: "case-contract-delete",
          title: "经营合同删除前的二次确认",
          folder: "合同管理/经营合同",
          role: "项目管理系统管理员",
          status: "draft",
          revision: null,
          priority: "P2",
          description: "验证删除入口的二次确认、取消行为以及删除后的列表与统计变化。",
          steps: [
            "在经营合同列表选择一条可删除合同。",
            "点击删除，在确认弹窗中点击取消。",
            "再次删除并确认。",
          ],
          expected: "取消后合同与列表状态不变；确认后合同从列表移除，统计数量同步减少，历史操作日志保留。",
          lastRun: null,
          createdAt: ago(6 * DAY),
          updatedAt: ago(3 * DAY),
        },
        {
          id: "case-purchase-filter",
          title: "采购合同列表按供应商筛选",
          folder: "采购合同",
          role: "采购专员",
          status: "verified",
          revision: "0002",
          priority: "P1",
          description: "验证采购合同列表的供应商筛选、组合条件与分页结果。",
          steps: [
            "进入「采购合同」列表，展开供应商筛选。",
            "选择供应商 A，叠加合同状态「执行中」。",
            "翻到第二页后返回第一页。",
          ],
          expected: "筛选结果只包含供应商 A 且状态为执行中的合同；分页总数与结果一致，切页后筛选条件保留。",
          lastRun: { status: "passed", at: ago(DAY + 2 * HOUR) },
          createdAt: ago(22 * DAY),
          updatedAt: ago(DAY),
        },
        {
          id: "case-purchase-upload",
          title: "采购合同附件上传失败时保留已填信息",
          folder: "采购合同",
          role: "采购专员",
          status: "candidate",
          revision: null,
          priority: "P2",
          description: "验证大文件或格式不符时附件上传失败的处理，避免整页表单被清空。",
          steps: [
            "进入采购合同新增页，填写合同基本信息。",
            "上传一个超过大小限制的附件。",
            "关闭错误提示，替换为合法附件后再次上传。",
          ],
          expected: "错误提示明确指出失败原因；已填合同信息保留；替换合法附件后可正常上传并提交。",
          lastRun: null,
          createdAt: ago(2 * DAY),
          updatedAt: ago(6 * HOUR),
        },
        {
          id: "case-project-approval",
          title: "项目立项审批提交与撤回",
          folder: "项目管理/项目立项",
          role: "项目经理",
          status: "verified",
          revision: "0001",
          priority: "P0",
          description: "验证项目立项审批流的提交、审批人可见性与撤回后的状态回退。",
          steps: [
            "以项目经理身份填写立项申请并提交审批。",
            "切换审批人账号，在待办中打开该申请。",
            "由申请人撤回审批，查看项目状态。",
          ],
          expected: "提交后生成审批待办；撤回后待办消失，项目回到「草稿」状态并保留申请内容。",
          lastRun: { status: "passed", at: ago(3 * DAY + HOUR) },
          createdAt: ago(26 * DAY),
          updatedAt: ago(3 * DAY),
        },
        {
          id: "case-project-draft",
          title: "项目立项表单草稿自动保存与恢复",
          folder: "项目管理/项目立项",
          role: "项目经理",
          status: "candidate",
          revision: null,
          priority: "P1",
          description: "验证立项表单在未提交时的本地草稿保存、跨刷新恢复与主动清空。",
          steps: [
            "填写项目名称、预算与里程碑，停留 5 秒。",
            "刷新页面并重新进入立项表单。",
            "点击「清空草稿」，再次刷新页面。",
          ],
          expected: "草稿自动保存且有保存时间提示；刷新后字段恢复；清空后刷新不再回填，且不影响已提交的正式申请。",
          lastRun: null,
          createdAt: ago(9 * DAY),
          updatedAt: ago(5 * HOUR),
        },
        {
          id: "case-permission-refresh",
          title: "角色权限变更后菜单与操作按钮即时刷新",
          folder: "系统设置/权限管理",
          role: "系统管理员",
          status: "verified",
          revision: "0005",
          priority: "P0",
          description: "验证管理员调整角色权限后，在线用户的菜单与按钮可见性无需重新登录即可刷新。",
          steps: [
            "管理员在「系统设置 / 权限管理」移除角色的合同删除权限。",
            "该角色用户保持在合同列表页面，触发一次权限刷新。",
            "尝试打开删除入口。",
          ],
          expected: "菜单与删除按钮按新权限即时隐藏；直接访问删除接口返回无权限；恢复权限后入口重新出现。",
          lastRun: { status: "passed", at: ago(6 * DAY) },
          createdAt: ago(40 * DAY),
          updatedAt: ago(2 * DAY),
        },
        {
          id: "case-account-disabled",
          title: "用户停用后登录会话立即失效",
          folder: "系统设置/账号管理",
          role: "系统管理员",
          status: "draft",
          revision: null,
          priority: "P1",
          description: "验证账号被停用后，已登录会话的访问控制与提示文案。",
          steps: [
            "管理员停用测试账号，同时保持该账号另一浏览器已登录。",
            "在已登录页面刷新并调用任意业务接口。",
            "重新登录该账号。",
          ],
          expected: "已登录会话下一次请求即失效并跳转登录页，提示「账号已停用」；重新登录被拒绝。",
          lastRun: null,
          createdAt: ago(12 * DAY),
          updatedAt: ago(4 * DAY),
        },
      ],
    };
  }

  /* ---------- 数据读写 ---------- */

  function normalizeFolder(value) {
    return String(value ?? "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, MAX_FOLDER_DEPTH)
      .map((part) => part.slice(0, MAX_FOLDER_PART))
      .join("/");
  }

  function uniqueId() {
    if (window.crypto?.randomUUID) return `case-${window.crypto.randomUUID()}`;
    return `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeCase(raw) {
    const status = STATUS[raw?.status] ? raw.status : "draft";
    const id = typeof raw?.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.id) ? raw.id : uniqueId();
    const lastRun = raw?.lastRun && typeof raw.lastRun.at === "string"
      ? { status: raw.lastRun.status === "passed" ? "passed" : "failed", at: raw.lastRun.at }
      : null;
    return {
      id,
      title: String(raw?.title ?? "未命名用例").slice(0, 120) || "未命名用例",
      folder: normalizeFolder(raw?.folder) || "未分类",
      role: String(raw?.role ?? "").slice(0, 80),
      status,
      revision: status === "verified" && /^\d{4}$/.test(raw?.revision ?? "") ? raw.revision : null,
      priority: PRIORITY_RANK[raw?.priority] !== undefined ? raw.priority : "P2",
      description: String(raw?.description ?? "").slice(0, 1000),
      steps: Array.isArray(raw?.steps)
        ? raw.steps.map((step) => String(step).trim()).filter(Boolean).slice(0, 30)
        : [],
      expected: String(raw?.expected ?? "").slice(0, 1000),
      lastRun,
      createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  }

  function readStoredState() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      storageOK = false;
      return null;
    }
    if (!raw) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.cases)) return null;
    const seen = new Set();
    const cases = parsed.cases
      .map(normalizeCase)
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    const folders = Array.isArray(parsed.folders)
      ? [...new Set(parsed.folders.map(normalizeFolder).filter(Boolean))]
      : [];
    return {
      schema: SCHEMA,
      cases,
      folders,
      lastSavedAt: typeof parsed.lastSavedAt === "string" ? parsed.lastSavedAt : null,
    };
  }

  function persistState() {
    state.lastSavedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schema: SCHEMA,
        cases: state.cases,
        folders: state.folders,
        lastSavedAt: state.lastSavedAt,
      }));
      storageOK = true;
    } catch {
      storageOK = false;
    }
    updateSaveState();
  }

  function updateSaveState() {
    const wrapper = $("#saveState");
    const text = $("#saveStateText");
    if (!storageOK) {
      wrapper.dataset.state = "local";
      text.textContent = "仅当前页面有效";
      return;
    }
    wrapper.dataset.state = "saved";
    text.textContent = state.lastSavedAt ? `已保存 · ${formatClock(state.lastSavedAt)}` : "已保存到本地";
  }

  /* ---------- 目录与检索 ---------- */

  function allFolderPaths() {
    const paths = new Set();
    const collect = (folder) => {
      const parts = folder.split("/").filter(Boolean);
      for (let index = 1; index <= parts.length; index += 1) {
        paths.add(parts.slice(0, index).join("/"));
      }
    };
    state.cases.forEach((item) => collect(item.folder));
    state.folders.forEach((folder) => collect(folder));
    return paths;
  }

  function expandAllFolders() {
    for (const path of allFolderPaths()) ui.expanded.add(path);
  }

  function expandAncestors(folder) {
    const parts = folder.split("/").filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) {
      ui.expanded.add(parts.slice(0, index).join("/"));
    }
  }

  function getFolderCases(folder = ui.folder) {
    if (!folder) return state.cases;
    return state.cases.filter((item) => item.folder === folder || item.folder.startsWith(`${folder}/`));
  }

  function countByStatus(items) {
    return items.reduce((counts, item) => {
      counts[item.status] += 1;
      return counts;
    }, { verified: 0, candidate: 0, draft: 0 });
  }

  function buildTree() {
    const root = { children: new Map(), count: 0 };
    for (const item of state.cases) {
      const parts = item.folder.split("/").filter(Boolean);
      root.count += 1;
      let node = root;
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index];
        const path = parts.slice(0, index + 1).join("/");
        let child = node.children.get(name);
        if (!child) {
          child = { name, path, children: new Map(), count: 0 };
          node.children.set(name, child);
        }
        child.count += 1;
        node = child;
      }
    }
    for (const folder of state.folders) {
      const parts = folder.split("/").filter(Boolean);
      let node = root;
      for (const part of parts) {
        let child = node.children.get(part);
        if (!child) {
          child = { name: part, path: "", children: new Map(), count: 0 };
          node.children.set(part, child);
        }
        node = child;
      }
    }
    // 自定义空目录同样参与建树；path 在序列化时按父级递归补齐。
    const serialize = (node, parentPath = "") => [...node.children.values()]
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
      .map((child) => {
        const path = parentPath ? `${parentPath}/${child.name}` : child.name;
        return {
          name: child.name,
          path,
          count: child.count,
          children: serialize(child, path),
        };
      });
    return serialize(root);
  }

  function filterTree(nodes, query) {
    if (!query) return nodes;
    const result = [];
    for (const node of nodes) {
      const children = filterTree(node.children, query);
      if (node.name.toLowerCase().includes(query) || children.length > 0) {
        result.push({ ...node, children });
      }
    }
    return result;
  }

  function visibleCases() {
    let items = getFolderCases();
    if (ui.status !== "all") items = items.filter((item) => item.status === ui.status);
    const query = ui.query.trim().toLowerCase();
    if (query) {
      items = items.filter((item) =>
        [item.title, item.description, item.role, item.folder, item.expected, item.id]
          .join("\n")
          .toLowerCase()
          .includes(query));
    }
    return [...items].sort((left, right) => {
      if (ui.sort === "priority") {
        return (PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority])
          || (Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      }
      if (ui.sort === "title") return left.title.localeCompare(right.title, "zh-CN");
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  }

  /* ---------- 渲染 ---------- */

  function renderAll() {
    renderTree();
    renderHeader();
    renderList();
    renderLegend();
    renderFolderOptions();
    updateSaveState();
  }

  function renderTree() {
    const tree = $("#folderTree");
    const query = ui.folderQuery.trim().toLowerCase();
    const nodes = filterTree(buildTree(), query);
    const fragment = document.createDocumentFragment();

    fragment.append(treeRow({ name: "全部用例", path: "", count: state.cases.length, children: [] }, 0, { root: true, query }));
    const divider = document.createElement("div");
    divider.className = "tree-divider";
    fragment.append(divider);

    if (nodes.length === 0 && query) {
      const empty = document.createElement("p");
      empty.className = "tree-empty";
      empty.textContent = "没有匹配的目录。";
      fragment.append(empty);
    }

    const walk = (list, depth) => {
      for (const node of list) {
        fragment.append(treeRow(node, depth, { query }));
        const open = query ? true : ui.expanded.has(node.path);
        if (node.children.length > 0 && open) walk(node.children, depth + 1);
      }
    };
    walk(nodes, 1);
    tree.replaceChildren(fragment);
  }

  function treeRow(node, depth, { root = false, query = false } = {}) {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const expanded = root || query ? true : ui.expanded.has(node.path);
    const row = document.createElement("div");
    row.className = "tree-node";
    row.style.setProperty("--depth", String(depth));
    row.dataset.path = node.path;
    row.dataset.selected = String(node.path === ui.folder);
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", String(node.path === ui.folder));
    row.setAttribute("aria-level", String(depth + 1));
    if (hasChildren) row.setAttribute("aria-expanded", String(expanded));
    if (hasChildren) row.dataset.expanded = String(expanded);

    if (hasChildren && !root) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tree-toggle";
      toggle.dataset.action = "toggle";
      toggle.dataset.path = node.path;
      toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}${node.name}`);
      toggle.innerHTML = icon("chevron");
      row.append(toggle);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "tree-toggle--placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      row.append(placeholder);
    }

    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "tree-name";
    nameButton.dataset.action = "select";
    nameButton.dataset.path = node.path;
    if (node.path === ui.folder) nameButton.setAttribute("aria-current", "true");
    nameButton.title = node.path ? node.path.split("/").join(" / ") : "全部用例";
    nameButton.innerHTML = `${icon(root ? "layers" : "folder")}<span class="tree-label">${esc(node.name || "全部用例")}</span>`;
    row.append(nameButton);

    const count = document.createElement("span");
    count.className = "tree-count";
    count.textContent = String(node.count ?? 0);
    row.append(count);
    return row;
  }

  function renderHeader() {
    const parts = ui.folder ? ui.folder.split("/") : [];
    const breadcrumb = $("#breadcrumb");
    const fragment = document.createDocumentFragment();

    const addCrumb = (label, path, current) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "crumb";
      button.dataset.path = path;
      button.textContent = label;
      if (current) button.setAttribute("aria-current", "page");
      fragment.append(button);
    };

    addCrumb("全部用例", "", parts.length === 0);
    for (let index = 0; index < parts.length; index += 1) {
      const separator = document.createElement("span");
      separator.className = "crumb-sep";
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "/";
      fragment.append(separator);
      addCrumb(parts[index], parts.slice(0, index + 1).join("/"), index === parts.length - 1);
    }
    breadcrumb.replaceChildren(fragment);

    $("#folderTitle").textContent = parts.length > 0 ? parts[parts.length - 1] : "全部用例";
    const folderCases = getFolderCases();
    const counts = countByStatus(folderCases);
    const fragments = [`项目管理系统`, `${folderCases.length} 条用例`, `${counts.verified} 条正式`];
    if (counts.candidate > 0) fragments.push(`${counts.candidate} 条候选`);
    if (counts.draft > 0) fragments.push(`${counts.draft} 条草稿`);
    $("#folderSubtitle").textContent = fragments.join(" · ");

    $("#countAll").textContent = String(folderCases.length);
    $("#countVerified").textContent = String(counts.verified);
    $("#countCandidate").textContent = String(counts.candidate);
    $("#countDraft").textContent = String(counts.draft);
    for (const button of $$("#statusTabs button")) {
      button.setAttribute("aria-pressed", String(button.dataset.status === ui.status));
    }
  }

  function renderLegend() {
    const counts = countByStatus(state.cases);
    $("#legendVerified").textContent = String(counts.verified);
    $("#legendCandidate").textContent = String(counts.candidate);
    $("#legendDraft").textContent = String(counts.draft);
  }

  function renderFolderOptions() {
    const options = document.createDocumentFragment();
    for (const path of [...allFolderPaths()].sort((left, right) => left.localeCompare(right, "zh-CN"))) {
      const option = document.createElement("option");
      option.value = path;
      options.append(option);
    }
    $("#folderOptions").replaceChildren(options);
  }

  function renderList() {
    const items = visibleCases();
    const list = $("#caseList");
    list.hidden = items.length === 0;
    list.innerHTML = items.map(caseRow).join("");

    const query = ui.query.trim();
    let summary = `共 ${items.length} 条用例`;
    if (ui.status !== "all") summary += ` · ${STATUS[ui.status].label}`;
    if (query) summary += ` · 匹配“${query.slice(0, 18)}${query.length > 18 ? "…" : ""}”`;
    $("#resultCount").textContent = summary;

    renderEmptyState(items);
  }

  function caseRow(item) {
    const status = STATUS[item.status] ?? STATUS.draft;
    const badge = item.status === "verified" && item.revision
      ? `正式 <code>${esc(item.revision)}</code>`
      : status.label;
    let run = item.status === "candidate" ? "待验证" : "未发布";
    let runClass = "";
    if (item.status === "verified") {
      if (item.lastRun) {
        run = `${item.lastRun.status === "passed" ? "最近通过" : "最近失败"} · ${formatTime(item.lastRun.at)}`;
        runClass = item.lastRun.status === "passed" ? " is-passed" : " is-failed";
      } else {
        run = "暂无回归结果";
      }
    }
    return `
      <article class="case" data-id="${esc(item.id)}">
        <span class="case__icon case__icon--${item.status}">${icon(status.icon)}</span>
        <div class="case__main">
          <div class="case__title-line">
            <button class="case__title" type="button" data-action="open" title="${esc(item.title)}">${esc(item.title)}</button>
            <span class="pill pill--${item.priority}">${item.priority}</span>
          </div>
          <p class="case__desc">${esc(item.description || "暂无用例说明")}</p>
          <div class="case__meta">
            <span class="meta meta--folder" title="${esc(item.folder)}">${icon("folder")}<span>${esc(item.folder)}</span></span>
            <i class="meta-sep" aria-hidden="true"></i>
            <span class="meta meta--role">${icon("user")}<span>${esc(item.role || "未指定角色")}</span></span>
            <i class="meta-sep" aria-hidden="true"></i>
            <span class="meta meta--time">${icon("clock")}<span>${formatTime(item.updatedAt)} 更新</span></span>
          </div>
        </div>
        <div class="case__end">
          <span class="status status--${item.status}"><i aria-hidden="true"></i>${badge}</span>
          <span class="case__run${runClass}">${esc(run)}</span>
        </div>
        <div class="case__actions">
          <button class="icon-btn icon-btn--sm" type="button" data-action="edit" title="编辑用例" aria-label="编辑 ${esc(item.title)}">${icon("edit")}</button>
          <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-action="delete" title="删除用例" aria-label="删除 ${esc(item.title)}">${icon("trash")}</button>
        </div>
      </article>`;
  }

  function renderEmptyState(items) {
    const empty = $("#emptyState");
    if (items.length > 0) {
      empty.hidden = true;
      empty.replaceChildren();
      return;
    }
    const filtering = Boolean(ui.query.trim()) || ui.status !== "all";
    const title = filtering ? "没有匹配的用例" : "这里还没有用例";
    const text = filtering
      ? "调整搜索关键词或状态筛选后再试。"
      : `在「${ui.folder ? ui.folder.split("/").pop() : "全部用例"}」中创建第一条用例。`;
    empty.innerHTML = `
      <div class="empty__icon">${icon(filtering ? "search" : "inbox")}</div>
      <h2>${title}</h2>
      <p>${esc(text)}</p>
      ${filtering
        ? `<button class="btn" type="button" data-empty="clear">清除筛选</button>`
        : `<button class="btn btn--primary" type="button" data-empty="create">${icon("plus")}新建用例</button>`}`;
    empty.hidden = false;
  }

  /* ---------- 详情抽屉 ---------- */

  function findCase(id) {
    return state.cases.find((item) => item.id === id) ?? null;
  }

  function formatRun(item) {
    if (item.status !== "verified") return "尚未转为正式版本";
    if (!item.lastRun) return "暂无回归结果";
    return `${item.lastRun.status === "passed" ? "通过" : "失败"} · ${formatTime(item.lastRun.at)}`;
  }

  function openDrawer(id) {
    const item = findCase(id);
    if (!item) return;
    if (!ui.openCaseId) ui.drawerReturn = document.activeElement;
    ui.openCaseId = id;
    renderDrawer();
    const drawer = $("#drawer");
    drawer.classList.add("is-open");
    drawer.inert = false;
    drawer.setAttribute("aria-hidden", "false");
    $("#drawerScrim").classList.add("is-open");
    syncBodyLock();
    window.setTimeout(() => {
      if (ui.openCaseId === id) $("#drawerClose")?.focus({ preventScroll: true });
    }, 30);
  }

  function closeDrawer({ restoreFocus = true } = {}) {
    const drawer = $("#drawer");
    if (!ui.openCaseId && !drawer.classList.contains("is-open")) return;
    ui.openCaseId = null;
    drawer.classList.remove("is-open");
    drawer.inert = true;
    drawer.setAttribute("aria-hidden", "true");
    $("#drawerScrim").classList.remove("is-open");
    syncBodyLock();
    const previous = ui.drawerReturn;
    ui.drawerReturn = null;
    if (restoreFocus && previous?.isConnected) {
      previous.focus({ preventScroll: true });
      previous.scrollIntoView?.({ block: "nearest" });
    }
  }

  function renderDrawer() {
    const item = findCase(ui.openCaseId);
    if (!item) return;
    const status = STATUS[item.status] ?? STATUS.draft;
    const badge = item.status === "verified" && item.revision
      ? `正式 <code>${esc(item.revision)}</code>`
      : status.label;
    const steps = item.steps.length > 0
      ? `<ol class="steps">${item.steps.map((step, index) => `
          <li><span class="step-index">${index + 1}</span><span class="step-text">${esc(step)}</span></li>`).join("")}</ol>`
      : `<p class="drawer__empty">尚未填写执行步骤。</p>`;
    const expected = item.expected
      ? `<div class="expected">${esc(item.expected)}</div>`
      : `<p class="drawer__empty">尚未填写预期结果。</p>`;

    $("#drawerContent").innerHTML = `
      <div class="drawer__top">
        <span class="status status--${item.status}"><i aria-hidden="true"></i>${badge}</span>
        <button class="icon-btn" id="drawerClose" type="button" title="关闭" aria-label="关闭详情">${icon("close")}</button>
      </div>
      <h2 id="drawerTitle">${esc(item.title)}</h2>
      <div class="drawer__meta">
        <div class="meta-cell meta-cell--wide"><span>目录</span><strong>${esc(item.folder)}</strong></div>
        <div class="meta-cell"><span>执行角色</span><strong>${esc(item.role || "未指定")}</strong></div>
        <div class="meta-cell"><span>优先级</span><strong>${esc(item.priority)}</strong></div>
        <div class="meta-cell"><span>版本状态</span><strong>${item.status === "verified" ? `正式 ${esc(item.revision ?? "")}` : status.label}</strong></div>
        <div class="meta-cell"><span>更新时间</span><strong>${formatTime(item.updatedAt)}</strong></div>
        <div class="meta-cell meta-cell--wide"><span>最近回归</span><strong>${formatRun(item)}</strong></div>
      </div>
      <section class="drawer__section">
        <h3>用例说明</h3>
        <p class="drawer__desc">${item.description ? esc(item.description) : `<span class="drawer__empty">暂无说明。</span>`}</p>
      </section>
      <section class="drawer__section">
        <h3>执行步骤 <span class="count">${item.steps.length}</span></h3>
        ${steps}
      </section>
      <section class="drawer__section">
        <h3>预期结果</h3>
        ${expected}
      </section>`;

    $("#drawerFoot").innerHTML = `
      <button class="btn btn--danger-ghost" type="button" data-drawer="delete">${icon("trash")}删除</button>
      <button class="btn" type="button" data-drawer="edit">${icon("edit")}编辑用例</button>`;
  }

  /* ---------- 弹层通用逻辑 ---------- */

  const layerReturns = new Map();

  function syncBodyLock() {
    const anyModal = Boolean($(".modal.is-open"));
    const drawerOpen = $("#drawer").classList.contains("is-open");
    document.body.classList.toggle("has-overlay", anyModal || drawerOpen);
  }

  function openLayer(modal, scrim, focusSelector) {
    layerReturns.set(modal, document.activeElement);
    modal.classList.add("is-open");
    modal.inert = false;
    modal.setAttribute("aria-hidden", "false");
    scrim.classList.add("is-open");
    syncBodyLock();
    window.requestAnimationFrame(() => {
      const target = focusSelector ? modal.querySelector(focusSelector) : null;
      target?.focus({ preventScroll: true });
    });
  }

  function closeLayer(modal, scrim, { restoreFocus = true } = {}) {
    modal.classList.remove("is-open");
    modal.inert = true;
    modal.setAttribute("aria-hidden", "true");
    scrim.classList.remove("is-open");
    syncBodyLock();
    const previous = layerReturns.get(modal);
    layerReturns.delete(modal);
    if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
  }

  function trapFocus(modal, event) {
    if (event.key !== "Tab") return;
    const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', modal)
      .filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ---------- 用例编辑 ---------- */

  function nextRevision() {
    const highest = state.cases.reduce((max, item) => Math.max(max, Number(item.revision) || 0), 0);
    return String(highest + 1).padStart(4, "0");
  }

  function setInvalid(fieldName, message) {
    const field = $(`[data-field="${fieldName}"]`, $("#caseForm"));
    if (!field) return;
    field.classList.toggle("is-invalid", Boolean(message));
    const error = $(".field__error", field);
    if (error) error.textContent = message || "";
  }

  function clearFormErrors() {
    for (const field of $$(".field.is-invalid", $("#caseForm"))) {
      field.classList.remove("is-invalid");
    }
    for (const error of $$(".field__error", $("#caseForm"))) error.textContent = "";
  }

  function syncRevisionField() {
    const status = $("#caseStatusSelect").value;
    const input = $("#caseRevisionInput");
    const verified = status === "verified";
    input.disabled = !verified;
    $("#revisionHint").textContent = verified
      ? "正式版本需填写 4 位版本号，例如 0006。"
      : "仅正式版本需要版本号，草稿与候选会自动留空。";
    if (verified && !/^\d{4}$/.test(input.value)) input.value = nextRevision();
    if (!verified) input.value = "";
  }

  function openCaseForm(id = null) {
    const item = id ? findCase(id) : null;
    ui.editingId = item?.id ?? null;
    const form = $("#caseForm");
    form.reset();
    clearFormErrors();

    $("#caseModalTitle").textContent = item ? "编辑用例" : "新建用例";
    $("#caseModalSub").textContent = item
      ? `最后更新于 ${formatTime(item.updatedAt)}`
      : "填写用例信息，保存后可继续完善。";
    $("#caseTitleInput").value = item?.title ?? "";
    $("#caseFolderInput").value = item?.folder ?? ui.folder ?? "";
    $("#caseRoleInput").value = item?.role ?? "";
    $("#caseStatusSelect").value = item?.status ?? "candidate";
    $("#caseDescriptionInput").value = item?.description ?? "";
    $("#caseStepsInput").value = (item?.steps ?? []).join("\n");
    $("#caseExpectedInput").value = item?.expected ?? "";
    const priority = item?.priority ?? "P1";
    for (const radio of $$('input[name="priority"]', form)) radio.checked = radio.value === priority;
    $("#caseRevisionInput").value = item?.revision ?? "";
    syncRevisionField();
    openLayer($("#caseModal"), $("#caseScrim"), "#caseTitleInput");
  }

  function closeCaseForm() {
    ui.editingId = null;
    closeLayer($("#caseModal"), $("#caseScrim"));
  }

  function saveCase(event) {
    event.preventDefault();
    const title = $("#caseTitleInput").value.trim();
    const folder = normalizeFolder($("#caseFolderInput").value);
    const role = $("#caseRoleInput").value.trim() || "未指定角色";
    const status = $("#caseStatusSelect").value;
    const priority = $('input[name="priority"]:checked', $("#caseForm"))?.value ?? "P1";
    const revision = $("#caseRevisionInput").value.trim();
    const description = $("#caseDescriptionInput").value.trim();
    const steps = $("#caseStepsInput").value.split("\n").map((step) => step.trim()).filter(Boolean).slice(0, 30);
    const expected = $("#caseExpectedInput").value.trim();

    let valid = true;
    if (!title) {
      setInvalid("title", "请填写用例标题。");
      valid = false;
    } else if (title.length > 120) {
      setInvalid("title", "标题不能超过 120 个字符。");
      valid = false;
    } else {
      setInvalid("title", "");
    }
    if (status === "verified" && !/^\d{4}$/.test(revision)) {
      setInvalid("revision", "请填写 4 位数字版本号。");
      valid = false;
    } else {
      setInvalid("revision", "");
    }
    if (!valid) {
      const invalid = $(".field.is-invalid input, .field.is-invalid textarea", $("#caseForm"));
      invalid?.focus();
      return;
    }

    const now = new Date().toISOString();
    const savedFolder = folder || "未分类";
    const base = {
      title,
      folder: savedFolder,
      role,
      status,
      revision: status === "verified" ? revision : null,
      priority,
      description,
      steps,
      expected,
      updatedAt: now,
    };

    const wasDrawerOpen = Boolean(ui.openCaseId);
    const wasEditing = Boolean(ui.editingId);
    let savedId = null;
    if (ui.editingId) {
      const target = findCase(ui.editingId);
      if (target) {
        Object.assign(target, base);
        savedId = target.id;
      }
    } else {
      savedId = uniqueId();
      state.cases.unshift({
        ...base,
        id: savedId,
        createdAt: now,
        lastRun: null,
      });
    }
    if (savedFolder && !allFolderPaths().has(savedFolder)) state.folders.push(savedFolder);
    persistState();

    ui.editingId = null;
    ui.folder = savedFolder;
    ui.query = "";
    ui.status = "all";
    $("#caseSearch").value = "";
    expandAncestors(savedFolder);
    closeLayer($("#caseModal"), $("#caseScrim"), { restoreFocus: false });
    renderAll();

    if (wasEditing) {
      if (wasDrawerOpen) openDrawer(savedId);
      toast("已保存修改，数据已写入本地");
    } else {
      openDrawer(savedId);
      toast("已创建用例，数据已写入本地");
    }
  }

  /* ---------- 删除与重置 ---------- */

  let confirmHandler = null;

  function openConfirm({ title, message, confirmLabel, iconName = "trash", onConfirm }) {
    $("#confirmTitle").textContent = title;
    $("#confirmMessage").textContent = message;
    $("#confirmOkBtn").textContent = confirmLabel;
    $("#confirmIcon").innerHTML = icon(iconName);
    confirmHandler = onConfirm;
    openLayer($("#confirmModal"), $("#confirmScrim"), "#confirmCancelBtn");
  }

  function closeConfirm({ restoreFocus = true } = {}) {
    confirmHandler = null;
    closeLayer($("#confirmModal"), $("#confirmScrim"), { restoreFocus });
  }

  function requestDelete(id) {
    const item = findCase(id);
    if (!item) return;
    openConfirm({
      title: "删除这条用例？",
      message: `将删除「${item.title}」及其执行步骤，操作不可恢复。`,
      confirmLabel: "删除用例",
      onConfirm() {
        state.cases = state.cases.filter((entry) => entry.id !== id);
        if (ui.openCaseId === id) closeDrawer({ restoreFocus: false });
        persistState();
        renderAll();
        $("#caseSearch").focus();
        toast("已删除用例");
      },
    });
  }

  function requestReset() {
    openConfirm({
      title: "重置演示数据？",
      message: "当前本地修改将被清除，并恢复为 10 条初始示例用例。",
      confirmLabel: "重置示例",
      iconName: "refresh",
      onConfirm() {
        state = seedState();
        persistState();
        ui.folder = "";
        ui.query = "";
        ui.folderQuery = "";
        ui.status = "all";
        ui.expanded = new Set();
        $("#caseSearch").value = "";
        $("#folderSearch").value = "";
        $("#clearFolderSearch").hidden = true;
        closeDrawer({ restoreFocus: false });
        expandAllFolders();
        renderAll();
        $("#caseSearch").focus();
        toast("已重置为示例数据");
      },
    });
  }

  /* ---------- 目录弹窗 ---------- */

  function openFolderForm() {
    const form = $("#folderForm");
    form.reset();
    const field = $('[data-field="folderName"]', $("#folderModal"));
    field.classList.remove("is-invalid");
    $(".field__error", field).textContent = "";
    openLayer($("#folderModal"), $("#folderScrim"), "#folderNameInput");
  }

  function closeFolderForm() {
    closeLayer($("#folderModal"), $("#folderScrim"));
  }

  function saveFolder(event) {
    event.preventDefault();
    const field = $('[data-field="folderName"]', $("#folderModal"));
    const error = $(".field__error", field);
    const folder = normalizeFolder($("#folderNameInput").value);
    if (!folder) {
      field.classList.add("is-invalid");
      error.textContent = "请填写目录路径。";
      $("#folderNameInput").focus();
      return;
    }
    if (allFolderPaths().has(folder)) {
      field.classList.add("is-invalid");
      error.textContent = "该目录已存在，请直接选择左侧目录。";
      $("#folderNameInput").focus();
      return;
    }
    state.folders.push(folder);
    persistState();
    closeLayer($("#folderModal"), $("#folderScrim"), { restoreFocus: false });
    selectFolder(folder);
    toast(`已创建目录「${folder}」`);
  }

  /* ---------- 选择与筛选 ---------- */

  function selectFolder(path) {
    ui.folder = path;
    ui.query = "";
    $("#caseSearch").value = "";
    if (path) expandAncestors(path);
    renderAll();
  }

  function clearFilters() {
    ui.query = "";
    ui.status = "all";
    $("#caseSearch").value = "";
    renderHeader();
    renderList();
  }

  function clearFolderSearch() {
    ui.folderQuery = "";
    $("#folderSearch").value = "";
    $("#clearFolderSearch").hidden = true;
    renderTree();
  }

  /* ---------- 主题、刷新与提示 ---------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const button = $("#themeBtn");
    const label = theme === "dark" ? "切换到浅色主题" : "切换到深色主题";
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function initTheme() {
    let theme = null;
    try {
      theme = localStorage.getItem(THEME_KEY);
    } catch {
      theme = null;
    }
    applyTheme(theme === "light" ? "light" : "dark");
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 主题偏好无法持久化时只影响本次页面，不阻断演示。
    }
  }

  function refreshFromStorage() {
    const stored = readStoredState();
    if (!stored) {
      renderAll();
      toast("已刷新当前页面");
      return;
    }
    state = stored;
    if (ui.folder && !allFolderPaths().has(ui.folder)) ui.folder = "";
    if (ui.openCaseId && !findCase(ui.openCaseId)) closeDrawer({ restoreFocus: false });
    renderAll();
    toast("已重新读取本地数据");
  }

  function toast(message) {
    const element = $("#toast");
    $("#toastText").textContent = message;
    element.classList.add("is-visible");
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => element.classList.remove("is-visible"), 2400);
  }

  /* ---------- 时间格式化 ---------- */

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未知时间";
    const now = new Date();
    const dayStart = (input) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
    const days = Math.round((dayStart(now) - dayStart(date)) / DAY);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (days === 0) return `今天 ${time}`;
    if (days === 1) return `昨天 ${time}`;
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function formatClock(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function isTyping(target) {
    if (!(target instanceof HTMLElement)) return false;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    $("#newCaseBtn").addEventListener("click", () => openCaseForm());
    $("#addFolderBtn").addEventListener("click", openFolderForm);
    $("#resetBtn").addEventListener("click", requestReset);
    $("#refreshBtn").addEventListener("click", refreshFromStorage);
    $("#themeBtn").addEventListener("click", toggleTheme);

    $("#folderTree").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const path = button.dataset.path ?? "";
      if (button.dataset.action === "toggle") {
        if (ui.expanded.has(path)) ui.expanded.delete(path);
        else ui.expanded.add(path);
        renderTree();
      } else if (button.dataset.action === "select") {
        selectFolder(path);
      }
    });

    $("#breadcrumb").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-path]");
      if (button) selectFolder(button.dataset.path ?? "");
    });

    $("#statusTabs").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-status]");
      if (!button) return;
      ui.status = button.dataset.status;
      renderHeader();
      renderList();
    });

    $("#sortSelect").addEventListener("change", (event) => {
      ui.sort = event.target.value;
      renderList();
    });

    $("#caseSearch").addEventListener("input", (event) => {
      ui.query = event.target.value;
      renderList();
    });

    $("#folderSearch").addEventListener("input", (event) => {
      ui.folderQuery = event.target.value;
      $("#clearFolderSearch").hidden = !event.target.value;
      renderTree();
    });
    $("#folderSearch").addEventListener("keydown", (event) => {
      if (event.key === "Escape" && event.target.value) {
        event.stopPropagation();
        clearFolderSearch();
      }
    });
    $("#clearFolderSearch").addEventListener("click", clearFolderSearch);

    $("#caseList").addEventListener("click", (event) => {
      const row = event.target.closest(".case");
      if (!row) return;
      const id = row.dataset.id;
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "edit") openCaseForm(id);
      else if (action === "delete") requestDelete(id);
      else openDrawer(id);
    });

    $("#emptyState").addEventListener("click", (event) => {
      if (event.target.closest('[data-empty="create"]')) openCaseForm();
      if (event.target.closest('[data-empty="clear"]')) clearFilters();
    });

    $("#drawer").addEventListener("click", (event) => {
      if (event.target.closest("#drawerClose")) {
        closeDrawer();
        return;
      }
      const action = event.target.closest("[data-drawer]")?.dataset.drawer;
      if (action === "edit") openCaseForm(ui.openCaseId);
      if (action === "delete") requestDelete(ui.openCaseId);
    });
    $("#drawerScrim").addEventListener("click", () => closeDrawer());

    $("#caseForm").addEventListener("submit", saveCase);
    $("#caseModalClose").addEventListener("click", closeCaseForm);
    $("#caseCancelBtn").addEventListener("click", closeCaseForm);
    $("#caseStatusSelect").addEventListener("change", syncRevisionField);
    $("#caseTitleInput").addEventListener("input", () => setInvalid("title", ""));
    $("#caseRevisionInput").addEventListener("input", () => setInvalid("revision", ""));

    $("#folderForm").addEventListener("submit", saveFolder);
    $("#folderModalClose").addEventListener("click", closeFolderForm);
    $("#folderCancelBtn").addEventListener("click", closeFolderForm);
    $("#folderNameInput").addEventListener("input", () => {
      const field = $('[data-field="folderName"]', $("#folderModal"));
      field.classList.remove("is-invalid");
      $(".field__error", field).textContent = "";
    });

    $("#confirmOkBtn").addEventListener("click", () => {
      const handler = confirmHandler;
      closeConfirm({ restoreFocus: false });
      if (handler) handler();
    });
    $("#confirmCancelBtn").addEventListener("click", () => closeConfirm());
    $("#confirmScrim").addEventListener("click", () => closeConfirm());
    $("#folderScrim").addEventListener("click", closeFolderForm);

    for (const modal of [$("#caseModal"), $("#folderModal"), $("#confirmModal")]) {
      modal.addEventListener("keydown", (event) => trapFocus(modal, event));
    }

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        $("#caseSearch").focus();
        $("#caseSearch").select();
        return;
      }
      if (event.key === "/" && !isTyping(event.target)) {
        event.preventDefault();
        $("#caseSearch").focus();
        return;
      }
      if (event.key !== "Escape") return;
      if ($("#confirmModal").classList.contains("is-open")) {
        closeConfirm();
      } else if ($("#folderModal").classList.contains("is-open")) {
        closeFolderForm();
      } else if ($("#caseModal").classList.contains("is-open")) {
        closeCaseForm();
      } else if ($("#drawer").classList.contains("is-open")) {
        closeDrawer();
      }
    });

    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      const stored = readStoredState();
      if (!stored) return;
      state = stored;
      if (ui.folder && !allFolderPaths().has(ui.folder)) ui.folder = "";
      if (ui.openCaseId && !findCase(ui.openCaseId)) closeDrawer({ restoreFocus: false });
      renderAll();
      toast("已同步其他标签页的修改");
    });
  }

  /* ---------- 启动 ---------- */

  function init() {
    initTheme();
    const stored = readStoredState();
    if (stored) {
      state = stored;
    } else {
      state = seedState();
      persistState();
    }
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    $("#searchKbd").textContent = isMac ? "⌘ K" : "Ctrl K";
    expandAllFolders();
    bindEvents();
    renderAll();
    updateSaveState();
  }

  init();
})();

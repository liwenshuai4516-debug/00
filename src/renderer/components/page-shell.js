import {
  createSidebarShell,
  SIDEBAR_AUTO_COLLAPSE_BELOW,
} from "./sidebar-shell.js";
import { createRightSidebar } from "./right-sidebar.js";
import { createRightSidebarPanel } from "./right-sidebar-panel.js";

// 只管理页面展示，不调用 window.agent，不改变业务状态。
const sidebar = document.getElementById("app-sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const narrowWindow = window.matchMedia(
  `(max-width: ${SIDEBAR_AUTO_COLLAPSE_BELOW - 1}px)`,
);

const searchToggle = document.getElementById("session-search-toggle");
const searchField = document.getElementById("session-search-field");
const sessionSearch = document.getElementById("session-search");

function setSearch(open, { focus = true } = {}) {
  searchField.hidden = !open;
  searchToggle.setAttribute("aria-expanded", String(open));
  searchToggle.setAttribute("aria-label", open ? "收起对话搜索" : "搜索对话");
  searchToggle.title = open ? "收起对话搜索" : "搜索对话";
  if (open) {
    const recent = document.querySelector(".recent-sessions");
    if (recent) recent.open = true;
    if (focus) sessionSearch.focus();
    return;
  }
  // 收起时一并移除筛选，避免列表在没有可见关键词时仍被过滤。
  sessionSearch.value = "";
  sessionSearch.dispatchEvent(new Event("input", { bubbles: true }));
  if (focus) searchToggle.focus();
}

const sidebarShell = createSidebarShell({
  sidebar,
  toggle: sidebarToggle,
  // 收起会隐藏宽内容，先关闭搜索，避免焦点留在不可见输入框里。
  onCollapse: () => {
    if (!searchField.hidden) setSearch(false, { focus: false });
  },
});

const rightSidebarPanel = createRightSidebarPanel({
  body: document.getElementById("right-sidebar-body"),
  tabs: document.getElementById("right-sidebar-tabs"),
  confirmDialog: document.getElementById("right-sidebar-confirm-dialog"),
});

const rightSidebar = createRightSidebar({
  sidebar: document.getElementById("app-right-sidebar"),
  toggle: document.getElementById("right-sidebar-toggle"),
  close: document.getElementById("right-sidebar-close"),
  getLeftWidth: () => sidebarShell.getWidth(),
  collapseLeft: (options) => sidebarShell.collapse(options),
  onOpen: () => rightSidebarPanel.open(),
});

// Markdown 中的本地路径由页面事件打开；侧栏已收起时先展开。
document.addEventListener("open-file-preview", (event) => {
  const filePath = event.detail?.path;
  if (typeof filePath !== "string" || filePath === "") return;
  if (!rightSidebar.isOpen()) rightSidebar.open();
  void rightSidebarPanel.openFile(filePath);
});

// 会话切换后关闭旧工作目录的文件预览，避免把上一个项目的文件留在侧栏。
document.addEventListener("session-changed", () => rightSidebarPanel.resetWorkspaceView());

searchToggle.addEventListener("click", () => setSearch(searchField.hidden));

// 业务确认项目已打开后再收起侧栏；失败时保留项目区的错误提示。
function collapseForNarrow() {
  if (narrowWindow.matches) sidebarShell.collapse();
}

document.addEventListener("project-opened", collapseForNarrow);

const sessionList = document.getElementById("session-list");
const title = document.getElementById("conversation-title");
function refreshTitle() {
  // 标题跟随业务代码已确认的选中状态，不提前假定切换成功。
  const active = sessionList.querySelector('button[aria-current="true"]');
  title.textContent = active?.textContent || "项目助手";
  title.title = title.textContent;
}
new MutationObserver(refreshTitle).observe(sessionList, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["aria-current"],
});
refreshTitle();

// 只在业务确认打开成功后收起；行内置顶操作和打开失败均保留侧栏。
document.addEventListener("session-opened", collapseForNarrow);
document.getElementById("new-chat-button").addEventListener("click", () => {
  if (narrowWindow.matches && !sidebarShell.isCollapsed()) {
    sidebarShell.collapse();
    sidebarToggle.focus();
  }
});

const drafts = document.getElementById("proposal-review-panel");
const draftToggle = document.getElementById("draft-toggle");
const draftSummary = document.getElementById("proposal-summary");
function refreshDraftToggle() {
  draftToggle.setAttribute("aria-expanded", String(drafts.open));
  draftToggle.setAttribute("aria-label", draftSummary.textContent);
  draftToggle.title = draftSummary.textContent;
}
draftToggle.addEventListener("click", () => {
  drafts.open = !drafts.open;
});
drafts.addEventListener("toggle", refreshDraftToggle);
new MutationObserver(refreshDraftToggle).observe(draftSummary, {
  childList: true,
  characterData: true,
  subtree: true,
});
refreshDraftToggle();

const menu = document.getElementById("conversation-menu");
document.addEventListener("click", (event) => {
  if (menu.open && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing) return;
  // 模态配置页面自行处理 Escape，不同时收起背后的侧栏。
  if (document.querySelector("dialog[open]")) return;
  if (!searchField.hidden && sidebar.contains(document.activeElement)) {
    event.preventDefault();
    setSearch(false);
    return;
  }
  if (menu.open) {
    const containedFocus = menu.contains(document.activeElement);
    menu.open = false;
    if (containedFocus) menu.querySelector("summary").focus();
  } else if (narrowWindow.matches && !sidebarShell.isCollapsed()) {
    event.preventDefault();
    sidebarShell.collapse();
    sidebarToggle.focus();
  }
});
// 只在业务确认恢复成功后收起窄窗口侧栏，失败时保留重试入口。
document.addEventListener("unsent-session-opened", collapseForNarrow);

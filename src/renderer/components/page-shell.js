// 只管理页面展示，不调用 window.agent，不改变业务状态。
const shell = document.querySelector(".app-shell");
const sidebar = document.getElementById("app-sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarClose = document.getElementById("sidebar-close");
const narrowWindow = window.matchMedia("(max-width: 760px)");

function setSidebar(open) {
  sidebar.hidden = !open;
  shell.classList.toggle("sidebar-closed", !open);
  sidebarToggle.setAttribute("aria-expanded", String(open));
  sidebarToggle.setAttribute("aria-label", open ? "收起侧栏" : "展开侧栏");
}

setSidebar(!narrowWindow.matches);
sidebarToggle.addEventListener("click", () => {
  const open = sidebar.hidden;
  setSidebar(open);
  if (open && narrowWindow.matches) sidebarClose.focus();
});
sidebarClose.addEventListener("click", () => {
  setSidebar(false);
  sidebarToggle.focus();
});

const searchToggle = document.getElementById("session-search-toggle");
const searchField = document.getElementById("session-search-field");
const sessionSearch = document.getElementById("session-search");
function setSearch(open) {
  searchField.hidden = !open;
  searchToggle.setAttribute("aria-expanded", String(open));
  searchToggle.setAttribute("aria-label", open ? "收起对话搜索" : "搜索对话");
  searchToggle.title = open ? "收起对话搜索" : "搜索对话";
  if (open) {
    document.querySelector(".recent-sessions").open = true;
    sessionSearch.focus();
  }
  else {
    // 收起时一并移除筛选，避免列表在没有可见关键词时仍被过滤。
    sessionSearch.value = "";
    sessionSearch.dispatchEvent(new Event("input", { bubbles: true }));
    searchToggle.focus();
  }
}
searchToggle.addEventListener("click", () => setSearch(searchField.hidden));
narrowWindow.addEventListener("change", () => {
  // 窗口跨越断点时，避免焦点停在已经隐藏的区域。
  const focused = document.activeElement;
  setSidebar(!narrowWindow.matches);
  if (narrowWindow.matches && sidebar.contains(focused)) sidebarToggle.focus();
});

// 业务确认项目已打开后再收起侧栏；失败时保留项目区的错误提示。
document.addEventListener("project-opened", () => {
  if (narrowWindow.matches) setSidebar(false);
});

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
document.addEventListener("session-opened", () => {
  if (narrowWindow.matches) setSidebar(false);
});
document.getElementById("new-chat-button").addEventListener("click", () => {
  if (narrowWindow.matches) {
    setSidebar(false);
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
draftToggle.addEventListener("click", () => { drafts.open = !drafts.open; });
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
  } else if (narrowWindow.matches && !sidebar.hidden) {
    setSidebar(false);
    sidebarToggle.focus();
  }
});

// 只在业务确认恢复成功后收起窄窗口侧栏，失败时保留重试入口。
document.addEventListener("unsent-session-opened", () => {
  if (narrowWindow.matches) setSidebar(false);
});

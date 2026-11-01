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
narrowWindow.addEventListener("change", () => {
  // 窗口跨越断点时，避免焦点停在已经隐藏的区域。
  const focused = document.activeElement;
  setSidebar(!narrowWindow.matches);
  if (narrowWindow.matches && sidebar.contains(focused)) sidebarToggle.focus();
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

sessionList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (narrowWindow.matches && button && !button.disabled) {
    setSidebar(false);
    sidebarToggle.focus();
  }
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
  if (menu.open) {
    const containedFocus = menu.contains(document.activeElement);
    menu.open = false;
    if (containedFocus) menu.querySelector("summary").focus();
  } else if (narrowWindow.matches && !sidebar.hidden) {
    setSidebar(false);
    sidebarToggle.focus();
  }
});

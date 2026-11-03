import { createExtensionUi } from "./components/extension-ui.js";
import { createProposalPanel } from "./components/proposal-panel.js";
import { createProjectPanel } from "./components/project-panel.js";
import { mountHistoryPreview } from "./components/history-preview.js";
import { createSessionInfoPanel, formatContextUsage } from "./components/session-info-panel.js";
import { createContextUsage } from "./components/context-usage.js";
import { createMessageScroll } from "./components/message-scroll.js";
import { createSessionList } from "./components/session-list.js";
import { createUnsentSendPanel } from "./components/unsent-send-panel.js";
import { TASK_TEMPLATES } from "./components/task-templates.js";

import {
  appendMessage,
  updateAssistantMessage,
  updateToolMessage,
} from "./components/message-view.js";

import { createModelSelector } from "./components/model-selector.js";
import { createSettingsPanel } from "./components/settings/settings-panel.js";

import { createComposerPersistence } from "./components/composer-persistence.js";
import { createWindowCloseController } from "./components/window-close-controller.js";

const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
const templateSelect = document.getElementById("task-template-select");
const templateInsert = document.getElementById("task-template-insert");
for (const template of TASK_TEMPLATES) {
  const option = document.createElement("option");
  option.value = template.id;
  option.textContent = template.name;
  templateSelect.append(option);
}

// 页面忙碌与输入就绪分别管理，保存确认不能解除其他操作的忙碌状态。
let extensionUiPanel;
let pageBusy = true;
let pageGenerating = false;

let closing = false;
let archiveSyncPending = false;
let composing = false;
let closeController = null;
const closeDialog = document.getElementById("window-close-dialog");
let focusBeforeClose = null;

// 不在输入法组词尚未结束时确认保存；模态窗口会使输入框失焦。
input.addEventListener("compositionstart", () => {
  composing = true;
  renderComposerState();
});
input.addEventListener("compositionend", () => {
  composing = false;
  renderComposerState();

  closeController?.notify();
});
closeDialog.addEventListener("cancel", (event) => event.preventDefault());

function setClosing(value) {
  closing = value;
  setBusy(pageBusy, pageGenerating);
  if (value) {
    focusBeforeClose = document.activeElement;
    closeDialog.showModal();
  } else {
    closeDialog.close();
    const target = focusBeforeClose;
    if (target?.isConnected && !target.disabled) target.focus();
    else input.focus();
  }
}

let composerState = { canSend: false, retryable: false, pendingSend: null };
const composerStatus = document.getElementById("composer-draft-status");
const composerRetry = document.getElementById("composer-draft-retry");
const unconfirmedSend = document.getElementById("unconfirmed-send");
const unconfirmedText = document.getElementById("unconfirmed-send-text");
let shownSendId = null;
const dismissSendButton = document.getElementById("dismiss-send-button");
const dismissConfirm = document.getElementById("dismiss-send-confirm");
const dismissAccept = document.getElementById("dismiss-send-accept");
const dismissCancel = document.getElementById("dismiss-send-cancel");
let dismissTarget = null;

function renderComposerState() {
  const busy = pageBusy || closing || archiveSyncPending;
  const message = composerState.message || "正在读取输入……";
  if (composerStatus.textContent !== message)
    composerStatus.textContent = message;
  composerRetry.hidden = !composerState.retryable;
  composerRetry.disabled = busy;
  sendButton.disabled = busy || !composerState.canSend;

  // 模板写入与发送共用就绪条件；输入法组词期间不能程序改写正文。
  templateSelect.disabled =
    busy || !composerState.canSend || composing || input.readOnly;
  templateInsert.disabled = templateSelect.disabled || !templateSelect.value;

  // 生成中的临时快照等待请求结束后再展示，避免误报为异常。
  const pending = pageGenerating ? null : composerState.pendingSend;
  unconfirmedSend.hidden = !pending;
  if (shownSendId !== pending?.id) unconfirmedSend.open = false;
  shownSendId = pending?.id ?? null;
  unconfirmedText.textContent = pending?.text ?? "";
  // 确认只属于打开时的会话和快照；切换后必须重新核对。
  if (
    dismissTarget &&
    (dismissTarget.sessionId !== composerState.sessionId ||
      dismissTarget.sendId !== pending?.id)
  ) {
    dismissTarget = null;
  }
  const disabled = busy || !composerState.canDismiss;
  dismissSendButton.disabled = disabled;
  dismissAccept.disabled = disabled;
  dismissCancel.disabled = busy;
  dismissConfirm.hidden = !dismissTarget;
  dismissSendButton.setAttribute(
    "aria-expanded",
    String(Boolean(dismissTarget)),
  );
}

const composerPersistence = createComposerPersistence(
  input,
  window.agent,
  (state) => {
    composerState = state;
    renderComposerState();
    extensionUiPanel?.setSession(state.sessionId);
  },
);

extensionUiPanel = createExtensionUi(window.agent, input, {
  canEdit: () => composerState.loaded && !composing && !closing && !input.readOnly,
});

templateSelect.addEventListener("change", renderComposerState);
templateInsert.addEventListener("click", () => {
  // 处理点击时再次检查，不能只依赖上一次渲染的按钮状态。
  if (
    pageBusy ||
    closing ||
    archiveSyncPending ||
    composing ||
    !composerState.canSend ||
    input.readOnly
  )
    return;
  const template = TASK_TEMPLATES.find(
    (item) => item.id === templateSelect.value,
  );
  if (!template) return;
  try {
    composerPersistence.appendTemplate(template.text);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  } catch (error) {
    setRequestStatus(error.message);
  }
});

// 主进程已切换成功时，输入读取失败只影响输入区，不误报为会话切换失败。
async function bindComposer(sessionId) {
  // 会话一变就隐藏旧目录条目，并作废尚未完成的列表读取。
  unsentReadVersion += 1;
  draftSessions = [];
  draftSessionOwner = sessionId;
  renderSessionLists();
  try {
    await composerPersistence.switchTo(sessionId);
  } catch (error) {
    addMessage("error", `当前对话已打开，输入读取失败：${error.message}`);
  }
}

composerRetry.addEventListener("click", async () => {
  if (composerRetry.disabled) return;
  setBusy(true);
  try {
    await composerPersistence.retry();
  } catch {
    // 组件已在输入区展示具体错误；继续保留编辑内容和重试入口。
  } finally {
    setBusy(false);
    input.focus();
  }
});

// 第一次点击只展示影响说明，不调用后端；焦点先放到取消按钮。
dismissSendButton.addEventListener("click", () => {
  if (dismissSendButton.disabled) return;
  dismissTarget = {
    sessionId: composerState.sessionId,
    sendId: composerState.pendingSend.id,
  };
  renderComposerState();
  dismissCancel.focus();
});

function cancelDismiss() {
  dismissTarget = null;
  renderComposerState();
  dismissSendButton.focus();
}
dismissCancel.addEventListener("click", cancelDismiss);
dismissConfirm.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.isComposing && !pageBusy) {
    event.preventDefault();
    cancelDismiss();
  }
});

dismissAccept.addEventListener("click", async () => {
  const target = dismissTarget;
  if (
    dismissAccept.disabled ||
    !target ||
    target.sessionId !== composerState.sessionId ||
    target.sendId !== composerState.pendingSend?.id
  )
    return;
  setBusy(true);
  dismissTarget = null;
  renderComposerState();
  try {
    await composerPersistence.dismissPendingSend(target.sendId);
    setRequestStatus("发送限制已解除，当前输入已保留；没有重新发送消息。");
  } catch (error) {
    setRequestStatus("解除尚未完成，请查看输入区状态或重新核对原文。");
    addMessage("error", `解除发送限制：${error.message}`);
  } finally {
    setBusy(false);
    input.focus();
  }
});
window.addEventListener("pagehide", () => composerPersistence.dispose(), {
  once: true,
});

const newChatButton = document.getElementById("new-chat-button");
const selectWorkspaceButton = document.getElementById(
  "select-workspace-button",
);
const compactSessionButton = document.getElementById("compact-session-button");
const exportConversationButton = document.getElementById(
  "export-conversation-button",
);

const cancelCompactionButton = document.getElementById(
  "cancel-compaction-button",
);
let historySessions = [];
let draftSessions = [];
let draftSessionOwner = "";

const unsentSendPanel = createUnsentSendPanel(
  document.getElementById("unsent-send-dialog"), window.agent,
  async operation => {
    if (pageBusy || closing || archiveSyncPending) throw new Error("请等待当前操作结束。");
    setBusy(true);
    try { return await operation(); }
    finally { setBusy(false); }
  },
  async () => {
    if ((await refreshUnsentSessions()) === false) throw new Error("请关闭弹窗后刷新对话列表。");
  },
);

function inspectUnsentSend(sessionId) {
  if (pageBusy || closing || archiveSyncPending) return;
  // 当前会话沿用已有输入核对与清理流程，避免两份组件状态不同步。
  if (sessionId === composerState.sessionId) {
    unconfirmedSend.open = true;
    unconfirmedText.focus();
  } else unsentSendPanel.open(sessionId);
}

const sessionList = createSessionList(
  document.getElementById("session-list"),
  selectSidebarSession,
  (project) => projectPanel.open(project),
  {
    onSetPinned: setSessionPinned,
    onReload: reloadSessionList,
    onSetArchived: setSessionArchived,
    onRenameProject: (project) => projectPanel.rename(project),
    onInspectUnsent: inspectUnsentSend,
  },
);
const archiveList = createSessionList(
  document.getElementById("archive-session-list"),
  () => {},
  () => {},
  {
    archived: true,
    onReload: reloadSessionList,
    onSetArchived: setSessionArchived,
    onPreview: (id, title) => archivePreview.preview(id, title),
  },
);
const sessionLists = [sessionList, archiveList];
window.addEventListener(
  "pagehide",
  () => sessionLists.forEach((list) => list.dispose()),
  { once: true },
);
document
  .getElementById("archive-session-search")
  .addEventListener("input", (event) => {
    archiveList.setQuery(event.target.value);
  });

function focusSessionActions(sessionId) {
  const inArchive =
    document.getElementById("model-settings-dialog").open &&
    !document.getElementById("settings-archive-panel").hidden;
  (inArchive ? archiveList : sessionList).focusActions(sessionId);
}
// 搜索只更新侧栏展示，不切换当前会话。
const sessionSearch = document.getElementById("session-search");

sessionSearch.addEventListener("input", () => {
  sessionList.setQuery(sessionSearch.value);
});

let unsentReadVersion = 0;
window.addEventListener(
  "pagehide",
  () => {
    unsentReadVersion += 1;
  },
  { once: true },
);

// 与输入核对、文件草稿读取顺序调用，不并行争用主进程互斥入口。
async function refreshUnsentSessions() {
  const version = ++unsentReadVersion;
  const sessionId = composerState.sessionId;
  draftSessions = [];
  draftSessionOwner = sessionId;
  renderSessionLists();
  try {
    const rows = await window.agent.listUnsentSessions();
    if (version !== unsentReadVersion || sessionId !== composerState.sessionId)
      return;
    draftSessions = rows.map((row) => ({ ...row, empty: true, updatedAt: 0 }));
    renderSessionLists();
  } catch (error) {
    if (
      version === unsentReadVersion &&
      sessionId === composerState.sessionId
    ) {
      sessionList.setStatus(`对话输入读取失败：${error.message}`, true);
      return false;
    }
  }
}

function renderSessionLists() {
  const ids = new Set(historySessions.map((session) => session.id));
  const drafts =
    draftSessionOwner === composerState.sessionId
      ? draftSessions.filter((session) => !ids.has(session.id))
      : [];
  sessionList.render([...historySessions, ...drafts], composerState.sessionId);
  archiveList.render(historySessions, composerState.sessionId);
}

function selectSidebarSession(sessionId) {
  if (historySessions.some((session) => session.id === sessionId))
    void openHistorySession(sessionId);
  else if (
    draftSessionOwner === composerState.sessionId &&
    draftSessions.some((session) => session.id === sessionId)
  )
    void openUnsentSession(sessionId);
}

async function openUnsentSession(sessionId) {
  if (pageBusy || sessionId === composerState.sessionId) return;
  setBusy(true);
  const wasReadOnly = input.readOnly;
  // 恢复期间暂时只读，仍可选择和复制；避免离开前又产生待保存输入。
  input.readOnly = true;
  let restored = false;
  setRequestStatus("正在保存输入并恢复未发送对话……");
  try {
    await composerPersistence.flush();
    sessionInfoPanel.invalidate();
    const result = await window.agent.restoreUnsentSession(sessionId);
    restored = true;
    // 主进程已确认切换，先更新消息，再绑定新编号读取完整输入与快照。
    showHistory(result.history);
    sessionList.setActive(result.sessionId);
    sessionName.value = "";
    await bindComposer(result.sessionId);
    setRequestStatus("未发送对话已恢复。请核对输入后再发送。");
    // 分区刷新失败不撤回已经完成的恢复；互斥读取依次进行。
    for (const refresh of [
      restoreProposalPanel,
      refreshSessions,
      () => sessionInfoPanel.refresh(),
      () => modelSelector.refresh(),
    ]) {
      try {
        await refresh();
      } catch (error) {
        setRequestStatus("对话已恢复，但部分页面信息读取失败。");
        addMessage("error", `对话已恢复，刷新失败：${error.message}`);
      }
    }
  } catch (error) {
    setRequestStatus(
      restored
        ? "对话已恢复，但页面更新未完成。"
        : "未能恢复，原对话和输入已保留。",
    );
    addMessage(
      "error",
      `${restored ? "恢复后的页面更新失败" : "恢复未发送对话失败"}：${error.message}`,
    );
  } finally {
    await refreshUnsentSessions();
    input.readOnly = wasReadOnly;
    setBusy(false);
    if (restored) {
      document.dispatchEvent(new CustomEvent("unsent-session-opened"));
      input.focus();
    } else sessionList.focusActions(sessionId);
  }
}

const messages = document.getElementById("messages");

const messageScroll = createMessageScroll(
  messages,
  document.getElementById("latest-message-button"),
);
const sessionName = document.getElementById("session-name");
const renameButton = document.getElementById("rename-button");

const requestStatus = document.getElementById("request-status");

function setRequestStatus(text) {
  // 相同状态不重复修改，避免每段文本都触发辅助阅读播报。
  if (requestStatus.textContent !== text) {
    requestStatus.textContent = text;
  }
}

const contextUsage = createContextUsage(
  document.getElementById("context-usage"),
  {
    onRefresh: () => sessionInfoPanel.refresh(),
    onCompact: () => compactSessionButton.click(),
  },
);
// 菜单信息与常驻用量共用一次读取，不另发模型请求。
const sessionInfoPanel = createSessionInfoPanel(
  document.getElementById("session-info"),
  () => window.agent.getSessionInfo(),
  {
    readSessionId: () => composerState.sessionId,
    onState: (state) => contextUsage.render(state),
  },
);
window.addEventListener(
  "pagehide",
  () => {
    sessionInfoPanel.dispose();
    contextUsage.dispose();
  },
  { once: true },
);

// 模型选择器与设置页共用切换入口，在请求前使旧模型估算失效。
const modelApi = {
  ...window.agent,
  switchModel(id, provider) {
    sessionInfoPanel.invalidate();
    return window.agent.switchModel(id, provider);
  },
};

// 模型切换复用全页面忙碌状态，并刷新现有会话信息。
const modelSelector = createModelSelector(
  document.getElementById("model-selector"),
  modelApi,
  setBusy,
  () => sessionInfoPanel.refresh(),
);

//配置读取独立于当前会话；保存后不刷新或替换聊天内容。
const settingsPanel = createSettingsPanel(
  document.getElementById("model-settings-dialog"),
  document.getElementById("model-settings-button"),
  modelApi,
  setBusy,
  () => Promise.all([modelSelector.refresh(), sessionInfoPanel.refresh()]),
  text => composerPersistence.appendTemplate(text),
);

const projectPanel = createProjectPanel(
  document.getElementById("project-panel"),
  window.agent,
  setBusy,
  openProject,
  (projects) => sessionLists.forEach((list) => list.setProjects(projects)),
  document.getElementById("project-rename-dialog"),
);

// 在页面初始化时创建面板，供所有函数和事件处理使用。
const proposalPanelElement = document.getElementById("proposal-panel");
const proposalReviewPanel = document.getElementById("proposal-review-panel");
const proposalSummary = document.getElementById("proposal-summary");

const proposalPanel = createProposalPanel(
  document.getElementById("proposal-list"),
  (id) => window.agent.getProposal(id),
  async (id) => {
    const result = await window.agent.applyProposal(id);
    // 保存事实可能增加上下文；读取失败不撤销已经确认的文件保存。
    await sessionInfoPanel.refresh();
    return result;
  },
  (id) => window.agent.discardProposal(id),
  setBusy,
  (error) => addMessage("error", error.message),
  (count) => {
    // 新增、恢复、保存、放弃和清空后都使用同一更新入口。
    proposalSummary.textContent = `文件草稿（${count} 项未保存）`;
  },
);

function addMessage(role, text) {
  const body = appendMessage(messages, role, text);

  if (role === "tool") {
    // 展开、收起改变消息高度，继续遵循当前滚动跟随状态。
    body.parentElement.addEventListener("toggle", () => {
      messageScroll.update();
    });
  }

  messageScroll.update();
  return body;
}

// 统一更新按钮、模型选择器和历史列表的可用状态。

function setBusy(busy, generating = false) {
  pageBusy = busy;
  pageGenerating = generating;
  const blocked = busy || closing || archiveSyncPending;
  // 关闭冻结与原操作忙碌分别保存；原 finally 不能提前解除关闭冻结。
  proposalPanelElement.disabled = blocked;
  modelSelector.setBusy(blocked);
  settingsPanel.setBusy(blocked);
  contextUsage.setBusy(blocked, generating, closing || archiveSyncPending);
  renderComposerState();
  newChatButton.disabled = blocked;
  selectWorkspaceButton.disabled = blocked;
  compactSessionButton.disabled = blocked;
  exportConversationButton.disabled = blocked;
  sessionLists.forEach((list) =>
    list.setBusy(blocked, archiveSyncPending && !busy && !closing),
  );
  projectPanel.setBusy(blocked);
  unsentSendPanel.setBusy(blocked);
  stopButton.disabled = closing || !generating;
  renameButton.disabled = blocked;
  closeController?.notify();
  // 切换失败也重新读取实际会话；正常已刷新的路径不重复请求。
  if (!blocked) void sessionInfoPanel.refreshIfNeeded();
}

// 用历史消息替换当前页面内容。
function showHistory(history) {
  proposalPanel.clear();
  messages.replaceChildren();

  // 切换会话后恢复跟随最新消息。
  messageScroll.followLatest();

  for (const message of history) {
    addMessage(message.role, message.text);
  }
}
// 获取历史列表，并标记当前正在使用的会话。
// 主进程保存草稿数据；切换会话后由页面重新建立操作入口。
async function restoreProposalPanel() {
  const proposals = await window.agent.listProposals();

  // 先清空，避免重复建立按钮。
  proposalPanel.clear();

  for (const proposal of proposals) {
    proposalPanel.add(proposal.id);
  }
}
async function refreshSessions() {
  const sessions = await window.agent.listSessions();
  const currentId = await window.agent.currentSession();

  // 会话数据和当前编号仍由主进程提供。
  historySessions = sessions;
  renderSessionLists();
  sessionList.setActive(currentId);
}

async function setSessionPinned(sessionId, pinned) {
  if (pageBusy || closing) return;
  setBusy(true);
  let saved = false;
  try {
    const result = await window.agent.setSessionPinned(sessionId, pinned);
    saved = true;
    // 确认落盘后立即使用实际结果；列表刷新失败也不会显示成保存失败。
    historySessions = historySessions.map((session) =>
      session.id === sessionId
        ? { ...session, pinnedAt: result.pinnedAt }
        : session,
    );
    sessionLists.forEach((list) =>
      list.updatePinned(sessionId, result.pinnedAt),
    );
    await refreshSessions();
    sessionLists.forEach((list) =>
      list.setStatus(pinned ? "已置顶该对话。" : "已取消置顶。"),
    );
  } catch (error) {
    sessionLists.forEach((list) =>
      list.setStatus(
        `${saved ? "置顶状态已保存，列表刷新失败" : "置顶结果未确认，请刷新列表核对"}：${error.message}`,
        true,
      ),
    );
  } finally {
    setBusy(false);
    focusSessionActions(sessionId);
  }
}

async function reloadSessionList() {
  if (pageBusy || closing) return;
  setBusy(true);
  try {
    await composerPersistence.flush();
    if (archiveSyncPending) await syncArchivedPage();
    await refreshSessions();
    if ((await refreshUnsentSessions()) !== false)
      sessionLists.forEach((list) => list.setStatus("对话列表已刷新。"));
  } catch (error) {
    sessionLists.forEach((list) =>
      list.setStatus(`列表刷新失败：${error.message}`, true),
    );
  } finally {
    if (!archiveSyncPending) input.readOnly = false;
    setBusy(false);
    focusSessionActions(composerState.sessionId);
  }
}

async function syncArchivedPage(result) {
  const sessionId = result?.sessionId ?? (await window.agent.currentSession());
  if (sessionId !== composerState.sessionId) {
    const history = result?.history ?? (await window.agent.loadHistory());
    showHistory(history);
    sessionList.setActive(sessionId);
    proposalPanel.clear();
    sessionName.value = "";
    await bindComposer(sessionId);
    for (const refresh of [
      restoreProposalPanel,
      () => sessionInfoPanel.refresh(),
      () => modelSelector.refresh(),
    ]) {
      try {
        await refresh();
      } catch (error) {
        addMessage("error", `归档状态已更新，刷新失败：${error.message}`);
      }
    }
  }
  archiveSyncPending = false;
}

async function setSessionArchived(sessionId, archived) {
  if (pageBusy || closing || archiveSyncPending) return;
  setBusy(true);
  const wasReadOnly = input.readOnly;
  // 当前会话即将离开，先冻结输入并确认落盘，避免切换期间新编辑丢失。
  if (archived && sessionId === composerState.sessionId) input.readOnly = true;
  let saved = false;
  try {
    if (archived && sessionId === composerState.sessionId)
      await composerPersistence.flush();
    archiveSyncPending = true;
    if (archived && sessionId === composerState.sessionId)
      sessionInfoPanel.invalidate();
    const result = await window.agent.setSessionArchived(sessionId, archived);
    saved = true;
    historySessions = historySessions.map((session) =>
      session.id === sessionId
        ? { ...session, archivedAt: result.archivedAt }
        : session,
    );
    sessionLists.forEach((list) =>
      list.updateArchived(sessionId, result.archivedAt),
    );
    await syncArchivedPage(result.changed ? result : undefined);
    await refreshSessions();
    sessionLists.forEach((list) =>
      list.setStatus(
        archived
          ? "已归档，可撤销或在设置的已归档聊天中恢复。"
          : "已恢复对话，当前输入保持不变。",
      ),
    );
  } catch (error) {
    if (archiveSyncPending) {
      // 返回丢失也可能已完成归档与切换；先只读核对实际编号，不重复提交。
      try {
        await syncArchivedPage();
      } catch {
        /* 保持冻结，允许刷新入口再次核对。 */
      }
    }
    sessionLists.forEach((list) =>
      list.setStatus(
        `${saved ? "归档状态已保存，页面更新未完成" : "归档操作未完成，请刷新核对"}：${error.message}`,
        true,
      ),
    );
  } finally {
    await refreshUnsentSessions();
    input.readOnly = archiveSyncPending || wasReadOnly;
    setBusy(false);
    focusSessionActions(sessionId);
  }
}

// 启动时恢复最近会话并加载历史列表。
async function loadHistory() {
  setBusy(true);

  try {
    const history = await window.agent.loadHistory();
    await bindComposer(await window.agent.currentSession());
    showHistory(history);
    await sessionInfoPanel.refresh();

    await restoreProposalPanel();
    await refreshSessions();
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    // 操作结束后读取实际会话的模型，再恢复交互。
    await modelSelector.refresh();
    await refreshUnsentSessions();
    setBusy(false);
    input.focus();
  }
}

// 先建立独立预览入口，再尝试恢复当前聊天。
const archivePreview = mountHistoryPreview(
  document.getElementById("archive-history-preview"),
  {
    listSessions: async () =>
      (await window.agent.listSessions()).filter(
        (session) => session.archivedAt != null,
      ),
    previewSession: (id) => window.agent.previewSession(id),
  },
);

// 项目清单独立读取，不依赖当前模型会话初始化成功。
projectPanel.refresh();

extensionUiPanel.ready.then(loadHistory).catch(error => addMessage("error", `扩展交互连接失败：${error.message}`));

// 斜杠命令：Pi 资源命令由主进程读取，桌面内置命令直接复用现有操作。
const slashMenu = document.getElementById("slash-command-menu");
const commandSources = {
  host: "内置",
  extension: "扩展",
  prompt: "模板",
  skill: "技能",
};
const hostCommands = Object.freeze([
  { name: "new", description: "新建对话", source: "host" },
  { name: "compact", description: "整理当前上下文，可附带整理说明", argumentHint: "[说明]", source: "host" },
  { name: "export", description: "导出当前对话", source: "host" },
  { name: "reload", description: "重新加载扩展、技能、模板和上下文", source: "host" },
  { name: "session", description: "查看当前会话信息", source: "host" },
  { name: "model", description: "切换模型", argumentHint: "[供应商/模型]", source: "host" },
  { name: "thinking", description: "设置或查看思考等级", argumentHint: "[等级]", source: "host" },
  { name: "name", description: "重命名当前对话", argumentHint: "[名称]", source: "host" },
]);

let slashCommands = null;
let slashCommandsOwner = "";
let slashCommandsRequest = null;
let slashCommandsError = "";
let slashMatches = [];
let slashActive = -1;

// 首次打开菜单或会话变化时读取；读取失败仍保留内置命令。
async function loadSlashCommands(force = false) {
  if (slashCommands && !force) return slashCommands;
  if (slashCommandsRequest) return slashCommandsRequest;

  slashCommandsRequest = window.agent
    .listSlashCommands()
    .then((result) => {
      const seen = new Set(hostCommands.map((command) => command.name));
      const merged = [...hostCommands];

      for (const command of result?.commands ?? []) {
        // 名称冲突时保留桌面内置命令，避免同一名称执行两种语义。
        if (typeof command?.name !== "string" || !command.name || seen.has(command.name)) {
          continue;
        }
        seen.add(command.name);
        merged.push({ ...command });
      }

      slashCommands = merged;
      slashCommandsOwner = composerState.sessionId;
      slashCommandsError = "";
      return merged;
    })
    .catch((error) => {
      slashCommands = [...hostCommands];
      slashCommandsOwner = composerState.sessionId;
      slashCommandsError = error.message;
      return slashCommands;
    })
    .finally(() => {
      slashCommandsRequest = null;

      // 读取期间输入框可能仍停在命令前缀上。
      if (/^\/[^\s]*$/.test(input.value)) updateSlashMenu();
    });

  return slashCommandsRequest;
}

function closeSlashMenu() {
  slashMenu.hidden = true;
  slashMenu.replaceChildren();
  slashMatches = [];
  slashActive = -1;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function setSlashActive(index) {
  if (!slashMatches.length) return;

  // 方向键在首尾循环，避免长列表需要反复按键。
  slashActive = (index + slashMatches.length) % slashMatches.length;
  const items = slashMenu.querySelectorAll(".slash-command-item");
  items.forEach((item, itemIndex) => {
    item.setAttribute("aria-selected", String(itemIndex === slashActive));
  });
  const active = items[slashActive];
  if (active) {
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }
}

// 选中命令只填入名称，参数和发送仍由用户确认。
function applySlashCommand(command) {
  if (!command) return;

  input.value = `/${command.name}${command.argumentHint ? " " : ""}`;
  input.dispatchEvent(new Event("input"));
  closeSlashMenu();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function drawSlashMenu(token) {
  const matches = (slashCommands ?? hostCommands).filter((command) =>
    command.name.toLowerCase().startsWith(token),
  );

  slashMenu.replaceChildren();
  slashMatches = matches;
  slashActive = -1;

  if (!matches.length) {
    closeSlashMenu();
    return;
  }

  for (const [index, command] of matches.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "slash-command-item";
    item.id = `slash-command-option-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");

    const name = document.createElement("span");
    name.className = "slash-command-name";
    name.textContent = `/${command.name}`;
    if (command.argumentHint) {
      const hint = document.createElement("span");
      hint.className = "slash-command-argument";
      hint.textContent = ` ${command.argumentHint}`;
      name.append(hint);
    }

    const description = document.createElement("span");
    description.className = "slash-command-description";
    description.textContent = command.description ?? "";

    const source = document.createElement("span");
    source.className = "slash-command-source";
    source.textContent = commandSources[command.source] ?? "命令";

    item.append(name, description, source);
    // 点击不抢走焦点，保证键盘选择与输入状态一致。
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => applySlashCommand(slashMatches[index]));
    item.addEventListener("mousemove", () => setSlashActive(index));
    slashMenu.append(item);
  }

  if (slashCommandsError) {
    const note = document.createElement("p");
    note.className = "slash-command-note";
    note.setAttribute("role", "presentation");
    note.textContent = "扩展、模板和技能命令读取失败，仅显示内置命令。";
    slashMenu.append(note);
  }

  slashMenu.hidden = false;
  input.setAttribute("aria-expanded", "true");
  setSlashActive(0);
}

function updateSlashMenu(event) {
  // 输入法组词期间不展示命令列表，避免候选词被当成命令名。
  if (event?.isComposing) {
    closeSlashMenu();
    return;
  }

  // 只在输入第一个词时提示命令，带空格的参数不拦截。
  const match = /^\/([^\s]*)$/.exec(input.value);
  if (!match || input.disabled || input.readOnly) {
    closeSlashMenu();
    return;
  }

  if (!slashCommands || slashCommandsOwner !== composerState.sessionId) {
    closeSlashMenu();
    void loadSlashCommands(true);
    return;
  }

  drawSlashMenu(match[1].toLowerCase());
}

input.addEventListener("input", updateSlashMenu);
// 焦点离开输入框时收起菜单，避免浮层遮挡其他控件。
input.addEventListener("blur", () => closeSlashMenu());

// 解析内置命令；资源命令仍需交给 Pi 展开。
function parseHostCommand(text) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;

  const name = match[1];
  if (!hostCommands.some((command) => command.name === name)) return null;
  return { name, args: (match[2] ?? "").trim() };
}

async function runHostCommand({ name, args }) {
  // 命令本身不进入对话记录，先清空并保存输入，再执行桌面操作。
  input.value = "";
  input.dispatchEvent(new Event("input"));
  closeSlashMenu();

  if (name === "new") return startNewChat();
  if (name === "compact") return compactContext(args);
  if (name === "export") return exportCurrentConversation();

  setBusy(true);
  try {
    if (name === "reload") {
      const result = await window.agent.reloadResources();
      // 资源可能已变化，下次打开菜单重新读取。
      slashCommands = null;
      slashCommandsError = "";
      setRequestStatus(
        result.diagnostics?.length
          ? "资源已重新加载，存在需要检查的诊断信息。"
          : "Pi 资源已重新加载。",
      );
    } else if (name === "session") {
      const info = await window.agent.getSessionInfo();
      addMessage("status", [
        `会话编号：${info.sessionId}`,
        `工作目录：${info.workspaceDir ?? "未绑定"}`,
        `模型：${info.provider}/${info.modelId}`,
        `思考等级：${info.thinkingLevel}`,
        formatContextUsage(info.contextUsage),
      ].join(" · "));
      setRequestStatus("已读取当前会话信息。");
    } else if (name === "model") {
      await switchModelFromCommand(args);
    } else if (name === "thinking") {
      await setThinkingFromCommand(args);
    } else if (name === "name") {
      await renameFromCommand(args);
    }
  } catch (error) {
    setRequestStatus("命令未完成。");
    addMessage("error", error.message);
  } finally {
    setBusy(false);
    input.focus();
  }
}

async function switchModelFromCommand(args) {
  if (!args) {
    setRequestStatus("请在输入框下方的模型选择器中选择模型，或使用 /model 供应商/模型编号。");
    document.getElementById("model-select").focus();
    return;
  }

  const result = await window.agent.listModels();
  const wanted = args.toLowerCase();
  const model = result.models.find((item) =>
    [`${item.provider}/${item.id}`, item.id, item.name]
      .filter(Boolean)
      .some((value) => value.toLowerCase() === wanted),
  );

  if (!model) throw new Error(`未找到模型：${args}。可用格式为 供应商/模型编号。`);

  setRequestStatus(`正在切换到 ${model.name ?? model.id}……`);
  await window.agent.switchModel(model.id, model.provider);
  await modelSelector.refresh();
  await sessionInfoPanel.refresh();
  setRequestStatus(`已切换模型：${model.name ?? model.id}。`);
}

async function setThinkingFromCommand(args) {
  if (!args) {
    const info = await window.agent.getSessionInfo();
    setRequestStatus(
      `当前思考等级：${info.thinkingLevel}；可选：${info.thinkingLevels.join("、")}。`,
    );
    return;
  }

  const level = args.toLowerCase();
  await window.agent.setThinkingLevel(level);
  await sessionInfoPanel.refresh();
  setRequestStatus(`思考等级已设置为 ${level}。`);
}

async function renameFromCommand(args) {
  if (!args) {
    setRequestStatus("请在标题栏输入名称后保存，或使用 /name 名称。");
    sessionName.focus();
    return;
  }

  await window.agent.renameSession(args);
  await refreshSessions();
  sessionName.value = "";
  setRequestStatus(`对话已重命名为“${args}”。`);
}

// Enter 发送；Shift+Enter 保留 textarea 的默认换行行为。
input.addEventListener("keydown", (event) => {
  // 命令菜单打开时优先处理方向键、补全和关闭。
  if (!event.isComposing && !slashMenu.hidden) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSlashActive(slashActive + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSlashMenu();
      return;
    }
    const active = slashMatches[slashActive];
    if (active && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      const typed = /^\/([^\s]*)$/.exec(input.value)?.[1];
      // 已完整输入同一命令时，Enter 直接交给发送流程，避免重复补全。
      if (event.key === "Enter" && active.name === typed) {
        closeSlashMenu();
      } else {
        event.preventDefault();
        applySlashCommand(active);
        return;
      }
    }
  }

  // 中文输入法选词时的 Enter 不应触发发送。
  if (event.isComposing || event.key !== "Enter" || event.shiftKey) {
    return;
  }

  // 普通 Enter 用于发送，阻止它在文本框里插入换行。
  event.preventDefault();

  // 长按 Enter 或当前不可发送时，不重复提交。
  if (event.repeat || sendButton.disabled) return;

  // 键盘与发送按钮共用 submit，统一处理校验和请求状态。
  form.requestSubmit(sendButton);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!input.value.trim() || sendButton.disabled) return;

  // 内置命令由页面执行，不进入模型对话；资源命令仍走发送链路。
  const hostCommand = parseHostCommand(input.value);
  if (hostCommand) {
    await runHostCommand(hostCommand);
    return;
  }

  setBusy(true);
  let ticket;
  try {
    ticket = await composerPersistence.prepareSend();
  } catch (error) {
    addMessage("error", error.message);
    setBusy(false);
    input.focus();
    return;
  }

  messageScroll.followLatest();
  // 等待保存期间可能继续编辑，展示和发送都使用最终固定的同一份原文。
  addMessage("user", ticket.text.trim());
  setBusy(true, true);
  setRequestStatus("正在准备请求并等待模型回复……");

  // 模型请求和随后刷新历史列表是两个不同阶段。
  let requestReturned = false;
  let inputSettled = false;
  let replyElement;
  let reply = "";

  // 每轮请求独立管理，使用调用编号关联，不能按工具名称匹配。
  const pendingTools = new Map();
  // 一帧内合并流式更新；工具调用前后的回复节点分别保留。
  const pendingReplies = new Map();
  let replyFrame;

  function flushReplies() {
    replyFrame = undefined;

    for (const [body, text] of pendingReplies) {
      updateAssistantMessage(body, text);
    }

    pendingReplies.clear();
    messageScroll.update();
  }

  // 请求发起之前先监听，避免遗漏早期状态。
  const unsubscribeStatus = window.agent.onRequestStatus(setRequestStatus);
  const unsubscribeConsumed = window.agent.onDraftConsumed((ack) => {
    composerPersistence.confirmConsumed(ticket, ack);
  });

  const unsubscribe = window.agent.onTextDelta((delta) => {
    setRequestStatus("正在接收回复……");

    if (!replyElement) {
      replyElement = addMessage("assistant", "");
    }

    reply += delta;

    pendingReplies.set(replyElement, reply);

    if (replyFrame === undefined) {
      replyFrame = requestAnimationFrame(flushReplies);
    }
  });

  const unsubscribeTool = window.agent.onToolEvent((event) => {
    if (event.type === "message") { addMessage("status", event.text); return; }
    if (event.type === "start") {
      setRequestStatus(`正在调用工具：${event.name}`);

      // 工具事件将连续的模型文本分成不同段落。
      replyElement = undefined;
      reply = "";

      const body = addMessage("tool", `正在调用 ${event.name}`);

      pendingTools.set(event.toolCallId, {
        body,
        name: event.name,
      });
    } else if (event.type === "end") {
      setRequestStatus("工具已返回，正在继续处理……");

      replyElement = undefined;
      reply = "";

      const text = event.proposal
        ? `${event.text}\n草稿编号：${event.proposal.id}`
        : event.text;

      const pending = pendingTools.get(event.toolCallId);

      if (pending) {
        // 更新开始时创建的记录，避免留下重复的“正在调用”。
        updateToolMessage(pending.body, text);
        pendingTools.delete(event.toolCallId);
        messageScroll.update();
      } else {
        // 未收到开始事件时，也保留实际完成结果。
        addMessage("tool", text);
      }

      if (event.proposal) {
        proposalPanel.add(event.proposal.id);
        proposalReviewPanel.open = true;
      }
    }
  });
  try {
    const result = await window.agent.sendMessage(ticket.text, {
      sessionId: ticket.sessionId,
      revision: ticket.revision,
    });
    // 已返回的请求与随后页面刷新分别处理，输入补保存失败不恢复已发送原文。
    requestReturned = true;
    await composerPersistence.finishSend(ticket, result);
    inputSettled = true;

    if (result.outcome === "unconfirmed") {
      setRequestStatus(
        "请求结果尚未确认，发送原文已单独保留。可以查看后新建对话继续。",
      );
      addMessage("error", result.error || "请求结果尚未确认。");
    } else {
      setRequestStatus(result.stopped ? "生成已停止。" : result.completionStatus || "本次回复已结束。");
      if (result.stopped) addMessage("status", "生成已停止");
    }
    if (result.sessionChanged) {
      // 先完成原会话发送收尾，再绑定官方 runtime 实际替换后的会话。
      await bindComposer(await window.agent.currentSession());
      showHistory(await window.agent.loadHistory());
      await modelSelector.refresh();
    }
    if (result.warning) addMessage("status", result.warning);
    await refreshSessions();
  } catch (error) {
    if (requestReturned && inputSettled) {
      setRequestStatus("请求已返回，但历史列表刷新失败；输入保持当前状态。");
      addMessage("error", `历史列表刷新失败：${error.message}`);
    } else {
      try {
        const recovered = await composerPersistence.recoverSend(ticket);
        setRequestStatus(
          recovered?.status === "not-consumed"
            ? "本次请求未发送，已保留输入，可检查后重试。"
            : "请求结果尚未确认，已核对输入状态；请先查看聊天记录。",
        );
      } catch (recoveryError) {
        setRequestStatus(
          "请求结果及输入状态尚未确认，请使用输入区的重试入口核对。",
        );
        addMessage("error", `输入状态核对失败：${recoveryError.message}`);
      }
      addMessage("error", error.message);
    }
  } finally {
    // 每轮请求都清理全部监听，避免下一轮重复接收事件。
    unsubscribe();
    unsubscribeTool();
    unsubscribeStatus();
    unsubscribeConsumed();
    // 正常结束、停止或失败时，立即展示尚未绘制的最后一段。
    if (replyFrame !== undefined) cancelAnimationFrame(replyFrame);
    flushReplies();
    // 停止或异常可能没有完成事件，不能继续显示“正在调用”。
    for (const { body, name } of pendingTools.values()) {
      updateToolMessage(
        body,
        `${name} 结果未确认\n本轮请求已结束，未收到该工具的完成结果。`,
      );
    }

    pendingTools.clear();
    messageScroll.update();

    // 成功、失败或停止后都重新读取当前会话的上下文估算。
    await sessionInfoPanel.refresh();
    await refreshUnsentSessions();
    setBusy(false);
    input.focus();
  }
});

// 新建对话也供内置命令复用，不另建一套清空与刷新逻辑。
async function startNewChat() {
  setBusy(true);

  try {
    sessionInfoPanel.invalidate();
    const sessionId = await window.agent.newChat();
    await bindComposer(sessionId);

    setRequestStatus("就绪");
    await sessionInfoPanel.refresh();

    messages.replaceChildren();

    // 新建会话只需恢复一次跟随状态。
    messageScroll.followLatest();

    proposalPanel.clear();
    // 新会话尚未发送消息时，可能还没有历史列表项。
    sessionList.setActive("");
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    // 操作结束后读取实际会话的模型，再恢复交互。
    await modelSelector.refresh();
    await refreshUnsentSessions();
    setBusy(false);
    input.focus();
  }
}

newChatButton.addEventListener("click", startNewChat);

// 项目面板负责忙碌状态；这里在主进程确认成功后更新聊天页面。
async function openProject(projectId) {
  sessionInfoPanel.invalidate();
  const result = await window.agent.openProject(projectId);

  // 等待期间的新输入也归入原会话，再恢复目标会话的输入。
  await bindComposer(result.sessionId);
  showHistory(result.history);

  sessionList.setActive(result.sessionId);
  sessionName.value = "";
  setRequestStatus("就绪");

  // 各区域独立刷新；某一区域失败不阻止其他区域恢复。
  const updates = await Promise.allSettled([
    restoreProposalPanel(),
    refreshSessions(),
    sessionInfoPanel.refresh(),
    modelSelector.refresh(),
  ]);

  await refreshUnsentSessions();

  const failures = updates.filter((update) => update.status === "rejected");
  if (failures.length) {
    setRequestStatus("项目已打开，但部分页面信息读取失败。");
    for (const failure of failures) {
      addMessage("error", `项目已打开，刷新失败：${failure.reason.message}`);
    }
  }

  // 只有成功打开后才通知外壳，窄窗口收起侧栏再聚焦输入框。
  document.dispatchEvent(new CustomEvent("project-opened"));
  input.focus();
}

async function openHistorySession(sessionId) {
  setBusy(true);

  try {
    sessionInfoPanel.invalidate();
    const history = await window.agent.openSession(sessionId);
    // 打开成功后，再保存旧输入并恢复目标会话的输入。
    await bindComposer(sessionId);

    // 主进程打开成功后，才更新侧栏选中状态。
    sessionList.setActive(sessionId);

    setRequestStatus("就绪");
    showHistory(history);
    document.dispatchEvent(new CustomEvent("session-opened"));
    await sessionInfoPanel.refresh();
    await restoreProposalPanel();
  } catch (error) {
    // 打开失败时保留原选中项和已有聊天内容。
    addMessage("error", error.message);
  } finally {
    // 操作结束后读取实际会话的模型，再恢复交互。
    await modelSelector.refresh();
    await refreshUnsentSessions();
    setBusy(false);
    input.focus();
  }
}

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  setRequestStatus("正在停止，请稍候……");

  try {
    await window.agent.stop();
  } catch (error) {
    addMessage("error", error.message);
  }
});
renameButton.addEventListener("click", async () => {
  const name = sessionName.value.trim();

  if (!name) {
    addMessage("error", "请输入对话名称。");
    return;
  }

  setBusy(true);

  try {
    // 写入名称后重新加载列表，并保持当前会话选中。
    await window.agent.renameSession(name);
    await refreshSessions();
    sessionName.value = "";
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    setBusy(false);
    input.focus();
  }
});
// 整理入口同时服务于按钮和 /compact 命令，说明为可选文本。
async function compactContext(instructions = "") {
  if (compactSessionButton.disabled) return;

  setBusy(true);
  cancelCompactionButton.hidden = false;
  cancelCompactionButton.disabled = false;
  setRequestStatus("正在整理上下文，请稍候……");

  try {
    const result = await window.agent.compactSession(instructions);

    // 只更新消息区，保留输入草稿和待保存的文件修改。
    // 不调用会清空草稿面板的 showHistory()。
    messages.replaceChildren();
    messageScroll.followLatest();

    for (const message of result.history) {
      addMessage(message.role, message.text);
    }

    setRequestStatus(
      result.stopped ? "上下文整理已停止。" : "上下文整理完成。",
    );
  } catch (error) {
    // 整理失败时保留原消息，只追加错误提示。
    setRequestStatus("上下文整理未完成，请查看错误信息。");
    addMessage("error", error.message);
  } finally {
    cancelCompactionButton.hidden = true;

    await sessionInfoPanel.refresh();

    setBusy(false);
    input.focus();
  }
}

compactSessionButton.addEventListener("click", () => compactContext());

cancelCompactionButton.addEventListener("click", async () => {
  if (cancelCompactionButton.hidden || cancelCompactionButton.disabled) {
    return;
  }

  cancelCompactionButton.disabled = true;
  setRequestStatus("正在取消整理，请稍候……");

  try {
    await window.agent.cancelCompaction();

    // 取消请求送达不代表整理已结束。
    // 等原整理请求结束，再由它的 finally 恢复按钮。
  } catch (error) {
    // 原整理已经结束时，不让迟到的错误覆盖后续状态。
    if (cancelCompactionButton.hidden) return;

    cancelCompactionButton.disabled = false;
    setRequestStatus("取消整理未确认，可以再次尝试。");
    addMessage("error", error.message);
  }
});
// 导出入口同时服务于按钮和 /export 命令。
async function exportCurrentConversation() {
  if (exportConversationButton.disabled) return;

  setBusy(true);
  setRequestStatus("请选择导出位置……");

  try {
    const result = await window.agent.exportConversation();

    setRequestStatus(result.canceled ? "已取消导出。" : "对话已导出。");
  } catch (error) {
    setRequestStatus("导出未完成，请查看错误信息。");
    addMessage("error", error.message);
  } finally {
    // 导出不改变消息、输入草稿或待保存的文件修改。
    setBusy(false);
    input.focus();
  }
}

exportConversationButton.addEventListener("click", () => exportCurrentConversation());
selectWorkspaceButton.addEventListener("click", async () => {
  if (selectWorkspaceButton.disabled) return;

  setBusy(true);
  document.getElementById("conversation-menu").open = false;
  setRequestStatus("请选择工作目录，确认后将新建对话……");
  let switched = false;

  try {
    sessionInfoPanel.invalidate();
    const result = await window.agent.selectWorkspace();

    if (result.canceled) {
      setRequestStatus("已取消选择工作目录。");
      return;
    }

    switched = true;
    // 主进程已切换成功，立即保存旧输入并绑定新会话编号。
    await bindComposer(result.sessionId);
    showHistory([]);
    sessionList.setActive("");
    sessionName.value = "";
    setRequestStatus(`已切换工作目录：${result.workspaceDir}。已新建对话。`);

    // 新对话使用默认模型；目录与模型信息重新从主进程读取。
    await sessionInfoPanel.refresh();
    await modelSelector.refresh();
    await refreshSessions();
  } catch (error) {
    // 切换成功后的刷新失败，不能误报为目录没有切换。
    setRequestStatus(
      switched
        ? "工作目录已切换，但页面刷新未完成。"
        : "工作目录未切换，请查看错误信息。",
    );
    addMessage(
      "error",
      `${switched ? "新对话已创建，刷新失败" : "选择工作目录失败"}：${error.message}`,
    );
  } finally {
    await refreshUnsentSessions();
    setBusy(false);
    input.focus();
  }
});
// 所有组件与事件均已建立后再报告就绪；初始化未结束时也会等待。
closeController = createWindowCloseController({
  api: window.agent,
  readState: () => ({
    busy: pageBusy || composing,
    generating: pageGenerating,
    compacting: !cancelCompactionButton.hidden,
  }),
  flushAll: () => composerPersistence.flushAll(),
  setClosing,
  onError: (error) => {
    setRequestStatus("关闭前保存未完成，窗口与输入已保留；处理后可再次关闭。");
    addMessage("error", `关闭前保存失败：${error.message}`);
  },
});
window.addEventListener("pagehide", () => closeController.dispose(), {
  once: true,
});

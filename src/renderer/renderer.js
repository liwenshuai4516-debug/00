import { createProposalPanel } from "./components/proposal-panel.js";
import { createProjectPanel } from "./components/project-panel.js";
import { mountHistoryPreview } from "./components/history-preview.js";
import { createSessionInfoPanel } from "./components/session-info-panel.js";
import { createMessageScroll } from "./components/message-scroll.js";
import { createSessionList } from "./components/session-list.js";
import {
  appendMessage,
  updateAssistantMessage,
  updateToolMessage,
} from "./components/message-view.js";

import { createModelSelector } from "./components/model-selector.js";

import { createComposerPersistence } from "./components/composer-persistence.js";

const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
// 页面忙碌与输入就绪分别管理，保存确认不能解除其他操作的忙碌状态。
let pageBusy = true;
let pageGenerating = false;
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
  const message = composerState.message || "正在读取输入……";
  if (composerStatus.textContent !== message)
    composerStatus.textContent = message;
  composerRetry.hidden = !composerState.retryable;
  composerRetry.disabled = pageBusy;
  sendButton.disabled = pageBusy || !composerState.canSend;

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
  const disabled = pageBusy || !composerState.canDismiss;
  dismissSendButton.disabled = disabled;
  dismissAccept.disabled = disabled;
  dismissCancel.disabled = pageBusy;
  dismissConfirm.hidden = !dismissTarget;
  dismissSendButton.setAttribute(
    "aria-expanded",
    String(Boolean(dismissTarget)),
  );
}

const composerPersistence = createComposerPersistence(input, window.agent, (state) => {
  composerState = state;
  renderComposerState();
});

// 主进程已切换成功时，输入读取失败只影响输入区，不误报为会话切换失败。
async function bindComposer(sessionId) {
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
window.addEventListener("pagehide", () => composerPersistence.dispose(), { once: true });

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
const sessionList = createSessionList(
  document.getElementById("session-list"),
  openHistorySession,
);
// 搜索只更新侧栏展示，不切换当前会话。
const sessionSearch = document.getElementById("session-search");

sessionSearch.addEventListener("input", () => {
  sessionList.setQuery(sessionSearch.value);
});
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

// 在页面初始化时创建，后续统一调用 refresh 更新。
const sessionInfoPanel = createSessionInfoPanel(
  document.getElementById("session-info"),
  () => window.agent.getSessionInfo(),
);

// 模型切换复用全页面忙碌状态，并刷新现有会话信息。
const modelSelector = createModelSelector(
  document.getElementById("model-selector"),
  window.agent,
  setBusy,
  () => sessionInfoPanel.refresh(),
);


const projectPanel = createProjectPanel(
  document.getElementById("project-panel"),
  window.agent,
  setBusy,
  openProject,
);

// 在页面初始化时创建面板，供所有函数和事件处理使用。
const proposalPanelElement = document.getElementById("proposal-panel");
const proposalReviewPanel = document.getElementById("proposal-review-panel");
const proposalSummary = document.getElementById("proposal-summary");

const proposalPanel = createProposalPanel(
  document.getElementById("proposal-list"),
  (id) => window.agent.getProposal(id),
  (id) => window.agent.applyProposal(id),
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
  // fieldset 会统一禁用其内部按钮。
  proposalPanelElement.disabled = busy;
  modelSelector.setBusy(busy);
  renderComposerState();
  newChatButton.disabled = busy;
  selectWorkspaceButton.disabled = busy;
  compactSessionButton.disabled = busy;
  exportConversationButton.disabled = busy;
  sessionList.setBusy(busy);
  projectPanel.setBusy(busy);
  stopButton.disabled = !generating;
  renameButton.disabled = busy;
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
  sessionList.render(sessions, currentId);
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
    setBusy(false);
    input.focus();
  }
}

// 先建立独立预览入口，再尝试恢复当前聊天。
mountHistoryPreview(document.getElementById("history-preview"), window.agent);

// 项目清单独立读取，不依赖当前模型会话初始化成功。
projectPanel.refresh();

loadHistory();

// Enter 发送；Shift+Enter 保留 textarea 的默认换行行为。
input.addEventListener("keydown", (event) => {
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
      setRequestStatus("请求结果尚未确认，发送原文已单独保留。可以查看后新建对话继续。");
      addMessage("error", result.error || "请求结果尚未确认。");
    } else {
      setRequestStatus(result.stopped ? "生成已停止。" : "本次回复已结束。");
      if (result.stopped) addMessage("status", "生成已停止");
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
        setRequestStatus("请求结果及输入状态尚未确认，请使用输入区的重试入口核对。");
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
    setBusy(false);
    input.focus();
  }
});

newChatButton.addEventListener("click", async () => {
  setBusy(true);

  try {
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
    setBusy(false);
    input.focus();
  }
});

// 项目面板负责忙碌状态；这里在主进程确认成功后更新聊天页面。
async function openProject(projectId) {
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
    const history = await window.agent.openSession(sessionId);
    // 打开成功后，再保存旧输入并恢复目标会话的输入。
    await bindComposer(sessionId);

    // 主进程打开成功后，才更新侧栏选中状态。
    sessionList.setActive(sessionId);

    setRequestStatus("就绪");
    showHistory(history);
    await sessionInfoPanel.refresh();
    await restoreProposalPanel();
  } catch (error) {
    // 打开失败时保留原选中项和已有聊天内容。
    addMessage("error", error.message);
  } finally {
    // 操作结束后读取实际会话的模型，再恢复交互。
    await modelSelector.refresh();
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
compactSessionButton.addEventListener("click", async () => {
  if (compactSessionButton.disabled) return;

  setBusy(true);
  cancelCompactionButton.hidden = false;
  cancelCompactionButton.disabled = false;
  setRequestStatus("正在整理上下文，请稍候……");

  try {
    const result = await window.agent.compactSession();

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
});

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
exportConversationButton.addEventListener("click", async () => {
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
});
selectWorkspaceButton.addEventListener("click", async () => {
  if (selectWorkspaceButton.disabled) return;

  setBusy(true);
  document.getElementById("conversation-menu").open = false;
  setRequestStatus("请选择工作目录，确认后将新建对话……");
  let switched = false;

  try {
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
    setBusy(false);
    input.focus();
  }
});

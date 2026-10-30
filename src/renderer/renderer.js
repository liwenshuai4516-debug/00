import { createProposalPanel } from "./components/proposal-panel.js";
import { mountHistoryPreview } from "./components/history-preview.js";
import { createSessionInfoPanel } from "./components/session-info-panel.js";
import { createMessageScroll } from "./components/message-scroll.js";
import { createSessionList } from "./components/session-list.js";
import { appendMessage, updateToolMessage } from "./components/message-view.js";

import { createComposerDrafts } from "./components/composer-drafts.js";

const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const composerDrafts = createComposerDrafts(input);
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
const newChatButton = document.getElementById("new-chat-button");
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

// 统一更新按钮和历史列表的可用状态。
function setBusy(busy, generating = false) {
  // fieldset 会统一禁用其内部按钮。
  proposalPanelElement.disabled = busy;
  sendButton.disabled = busy;
  newChatButton.disabled = busy;
  compactSessionButton.disabled = busy;
  exportConversationButton.disabled = busy;
  sessionList.setBusy(busy);
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
  composerDrafts.switchTo(currentId);

  // 会话数据和当前编号仍由主进程提供。
  sessionList.render(sessions, currentId);
}

// 启动时恢复最近会话并加载历史列表。
async function loadHistory() {
  setBusy(true);

  try {
    const history = await window.agent.loadHistory();
    showHistory(history);
    await sessionInfoPanel.refresh();

    await restoreProposalPanel();
    await refreshSessions();
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    setBusy(false);
    input.focus();
  }
}

// 先建立独立预览入口，再尝试恢复当前聊天。
mountHistoryPreview(document.getElementById("history-preview"), window.agent);

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

  // 请求使用去除首尾空白的内容，失败恢复使用完整原文。
  const originalInput = input.value;
  const text = originalInput.trim();
  if (!text || sendButton.disabled) return;

  // 主动发送消息时，恢复跟随，立即看到本轮内容。
  messageScroll.followLatest();

  addMessage("user", text);
  input.value = "";
  setBusy(true, true);
  setRequestStatus("正在准备请求并等待模型回复……");

  // 模型请求和随后刷新历史列表是两个不同阶段。
  let requestCompleted = false;
  let replyElement;
  let reply = "";

  // 每轮请求独立管理，使用调用编号关联，不能按工具名称匹配。
  const pendingTools = new Map();

  // 请求发起之前先监听，避免遗漏早期状态。
  const unsubscribeStatus = window.agent.onRequestStatus(setRequestStatus);

  const unsubscribe = window.agent.onTextDelta((delta) => {
    setRequestStatus("正在接收回复……");

    if (!replyElement) {
      replyElement = addMessage("assistant", "");
    }

    reply += delta;

    // 角色标签由组件展示，这里只更新正文。
    replyElement.textContent = reply;

    // 已有消息的正文增长时，也需要更新滚动位置。
    messageScroll.update();
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
    const result = await window.agent.sendMessage(text);

    // 正常回复和主动停止都算请求已结束，不需要恢复输入。
    requestCompleted = true;

    setRequestStatus(result.stopped ? "生成已停止。" : "本次回复已结束。");

    if (result.stopped) {
      addMessage("status", "生成已停止");
    }

    await refreshSessions();
  } catch (error) {
    if (requestCompleted) {
      // 回复或停止已完成，仅列表刷新失败，不恢复已处理的输入。
      setRequestStatus("请求已结束，但历史列表刷新失败。");
      addMessage("error", `历史列表刷新失败：${error.message}`);
    } else {
      const restored = composerDrafts.restoreAfterFailure(originalInput);

      setRequestStatus(
        restored
          ? "请求失败，原文已恢复，可编辑后重新发送。"
          : "请求失败，已保留你正在编辑的内容，原文可在聊天区查看。",
      );

      addMessage("error", error.message);
    }
  } finally {
    // 每轮请求都清理全部监听，避免下一轮重复接收事件。
    unsubscribe();
    unsubscribeTool();
    unsubscribeStatus();
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
    composerDrafts.switchTo(sessionId);
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
    setBusy(false);
    input.focus();
  }
});

async function openHistorySession(sessionId) {
  setBusy(true);

  try {
    const history = await window.agent.openSession(sessionId);
    // 打开成功后，再保存旧输入并恢复目标会话的输入。
    composerDrafts.switchTo(sessionId);

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

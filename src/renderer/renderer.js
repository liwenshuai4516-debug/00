import { createProposalPanel } from "./components/proposal-panel.js";
import { mountHistoryPreview } from "./components/history-preview.js";
import { createSessionInfoPanel } from "./components/session-info-panel.js";
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
const newChatButton = document.getElementById("new-chat-button");
const sessionSelect = document.getElementById("session-select");
const messages = document.getElementById("messages");
const sessionName = document.getElementById("session-name");
const renameButton = document.getElementById("rename-button");

// 在页面初始化时创建，后续统一调用 refresh 更新。
const sessionInfoPanel = createSessionInfoPanel(
  document.getElementById("session-info"),
  () => window.agent.getSessionInfo(),
);
// 在页面初始化时创建面板，供所有函数和事件处理使用。
const proposalPanelElement = document.getElementById("proposal-panel");

const proposalPanel = createProposalPanel(
  document.getElementById("proposal-list"),
  (id) => window.agent.getProposal(id),
  (id) => window.agent.applyProposal(id),
  setBusy,
  (error) => addMessage("错误", error.message),
);

function addMessage(role, text) {
  const message = document.createElement("p");
  message.style.whiteSpace = "pre-wrap";
  message.textContent = `${role}：${text}`;
  messages.appendChild(message);
  return message;
}

// 统一更新按钮和历史列表的可用状态。
function setBusy(busy, generating = false) {
  // fieldset 会统一禁用其内部按钮。
  proposalPanelElement.disabled = busy;
  sendButton.disabled = busy;
  newChatButton.disabled = busy;
  sessionSelect.disabled = busy;
  stopButton.disabled = !generating;
  renameButton.disabled = busy;
}

// 用历史消息替换当前页面内容。
function showHistory(history) {
  // 切换或恢复历史时，清理当前页面的草稿操作入口。
  proposalPanel.clear();
  messages.replaceChildren();

  const labels = {
    user: "我",
    assistant: "Agent",
    tool: "工具",
    status: "状态",
  };

  for (const message of history) {
    addMessage(labels[message.role], message.text);
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

  sessionSelect.replaceChildren(new Option("选择历史对话", ""));

  for (const session of sessions) {
    const title = session.title.slice(0, 40);
    sessionSelect.add(new Option(title, session.id));
  }

  // 新建但尚未发送消息的会话可能还没有出现在列表中。
  const currentExists = sessions.some((session) => session.id === currentId);
  sessionSelect.value = currentExists ? currentId : "";
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
    addMessage("错误", error.message);
  } finally {
    setBusy(false);
    input.focus();
  }
}

// 先建立独立预览入口，再尝试恢复当前聊天。
mountHistoryPreview(document.getElementById("history-preview"), window.agent);

loadHistory();
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text || sendButton.disabled) return;

  addMessage("我", text);
  input.value = "";
  setBusy(true, true);

  // 每段连续的 Agent 文本使用独立消息元素。
  let replyElement;
  let reply = "";

  const unsubscribe = window.agent.onTextDelta((delta) => {
    // 真正收到文本时再创建，避免留下空白 Agent 消息。
    if (!replyElement) {
      replyElement = addMessage("Agent", "");
    }

    reply += delta;
    replyElement.textContent = `Agent：${reply}`;
  });

  const unsubscribeTool = window.agent.onToolEvent((event) => {
    if (event.type === "start") {
      // 工具事件结束当前文本段；之后的回复在新位置显示。
      replyElement = undefined;
      reply = "";

      addMessage("工具", `正在调用 ${event.name}`);
    } else if (event.type === "end") {
      replyElement = undefined;
      reply = "";

      const text = event.proposal
        ? `${event.text}\n草稿编号：${event.proposal.id}`
        : event.text;

      addMessage("工具", text);
      if (event.proposal) {
        proposalPanel.add(event.proposal.id);
      }
    }
  });

  try {
    const result = await window.agent.sendMessage(text);

    if (result.stopped) {
      addMessage("状态", "生成已停止");
    }

    // 第一条消息写入后，新会话才会出现在列表中。
    await refreshSessions();
  } catch (error) {
    addMessage("错误", error.message);
  } finally {
    unsubscribe();
    unsubscribeTool();
    setBusy(false);
    input.focus();
  }
});

newChatButton.addEventListener("click", async () => {
  setBusy(true);

  try {
    await window.agent.newChat();
    await sessionInfoPanel.refresh();
    messages.replaceChildren();
    proposalPanel.clear();
    sessionSelect.value = "";
    input.value = "";
  } catch (error) {
    addMessage("错误", error.message);
  } finally {
    setBusy(false);
    input.focus();
  }
});

sessionSelect.addEventListener("change", async () => {
  const sessionId = sessionSelect.value;
  if (!sessionId) return;

  setBusy(true);

  try {
    // 打开成功后再替换页面，失败时保留当前消息。
    const history = await window.agent.openSession(sessionId);
    showHistory(history);
    await sessionInfoPanel.refresh();

    // 会话打开成功后，再恢复它自己的待保存草稿。
    await restoreProposalPanel();
  } catch (error) {
    addMessage("错误", error.message);

    // 切换失败时，恢复列表中显示的当前会话。
    sessionSelect.value = await window.agent.currentSession();
  } finally {
    setBusy(false);
    input.focus();
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;

  try {
    await window.agent.stop();
  } catch (error) {
    addMessage("错误", error.message);
  }
});
renameButton.addEventListener("click", async () => {
  const name = sessionName.value.trim();

  if (!name) {
    addMessage("错误", "请输入对话名称。");
    return;
  }

  setBusy(true);

  try {
    // 写入名称后重新加载列表，并保持当前会话选中。
    await window.agent.renameSession(name);
    await refreshSessions();
    sessionName.value = "";
  } catch (error) {
    addMessage("错误", error.message);
  } finally {
    setBusy(false);
    input.focus();
  }
});

const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
const newChatButton = document.getElementById("new-chat-button");
const sessionSelect = document.getElementById("session-select");
const messages = document.getElementById("messages");
const sessionName = document.getElementById("session-name");
const renameButton = document.getElementById("rename-button");

function addMessage(role, text) {
  const message = document.createElement("p");
  message.textContent = `${role}：${text}`;
  messages.appendChild(message);
  return message;
}

// 统一更新按钮和历史列表的可用状态。
function setBusy(busy, generating = false) {
  sendButton.disabled = busy;
  newChatButton.disabled = busy;
  sessionSelect.disabled = busy;
  stopButton.disabled = !generating;
  renameButton.disabled = busy;
}

// 用历史消息替换当前页面内容。
function showHistory(history) {
  messages.replaceChildren();

  for (const message of history) {
    const role = message.role === "user" ? "我" : "Agent";
    addMessage(role, message.text);
  }
}

// 获取历史列表，并标记当前正在使用的会话。
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
    await refreshSessions();
  } catch (error) {
    addMessage("错误", error.message);
  } finally {
    setBusy(false);
    input.focus();
  }
}

loadHistory();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text || sendButton.disabled) return;

  addMessage("我", text);
  input.value = "";
  setBusy(true, true);

  const replyElement = addMessage("Agent", "");
  let reply = "";

  const unsubscribe = window.agent.onTextDelta((delta) => {
    reply += delta;
    replyElement.textContent = `Agent：${reply}`;
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
    setBusy(false);
    input.focus();
  }
});

newChatButton.addEventListener("click", async () => {
  setBusy(true);

  try {
    await window.agent.newChat();
    messages.replaceChildren();
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
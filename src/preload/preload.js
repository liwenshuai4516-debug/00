const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  // 发起一轮对话。
  sendMessage: (message) => ipcRenderer.invoke("agent:send-message", message),
  // 清理当前会话。
  newChat: () => ipcRenderer.invoke("agent:new-chat"),
  // 从主进程读取最近一段对话的文本消息。
  loadHistory: () => ipcRenderer.invoke("agent:load-history"),
  // 请求主进程停止当前生成。
  stop: () => ipcRenderer.invoke("agent:stop"),
  // 接收流式文本，并返回一个用于移除监听器的函数。
  // 重命名当前对话。
  renameSession: (name) => ipcRenderer.invoke("agent:rename-session", name),
  // 获取历史对话列表。
  listSessions: () => ipcRenderer.invoke("agent:list-sessions"),
  // 页面只能传会话编号，不能指定主进程读取的文件路径。
  previewSession: (sessionId) =>
    ipcRenderer.invoke("agent:preview-session", sessionId),

  // 获取当前会话的 ID，用于在列表中标记当前对话。
  currentSession: () => ipcRenderer.invoke("agent:current-session"),

    // 读取实际会话的模型与真实工作目录。
  getSessionInfo: () => ipcRenderer.invoke("agent:session-info"),

  // 获取当前会话中已登记的草稿。
  getProposal: (id) => ipcRenderer.invoke("agent:get-proposal", id),

  // 读取当前会话的待保存草稿，不接受页面传入的会话编号。
  listProposals: () => ipcRenderer.invoke("agent:list-proposals"),

  // 只允许提交草稿编号，不接受页面传入的路径或替换内容。
  applyProposal: (id) => ipcRenderer.invoke("agent:apply-proposal", id),
  // 订阅工具状态，并返回取消订阅方法。
  onToolEvent: (callback) => {
    const listener = (_event, toolEvent) => callback(toolEvent);
    ipcRenderer.on("agent:tool-event", listener);

    return () => {
      ipcRenderer.removeListener("agent:tool-event", listener);
    };
  },
  // 打开指定历史对话。
  openSession: (sessionId) =>
    ipcRenderer.invoke("agent:open-session", sessionId),
  onTextDelta: (callback) => {
    const listener = (_event, delta) => callback(delta);

    ipcRenderer.on("agent:text-delta", listener);

    return () => {
      ipcRenderer.removeListener("agent:text-delta", listener);
    };
  },
});

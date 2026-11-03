const { randomUUID } = require("node:crypto");

// Electron 承载 Pi RPC 的对话能力；终端组件沿用 SDK 的非 TUI 行为。
function createExtensionUiBridge() {
  let contents;
  const pending = new Map();
  const states = new Map();
  const editorTexts = new Map();

  function send(event) {
    if (contents && !contents.isDestroyed()) contents.send("agent:extension-ui", event);
  }

  function cancelPending(sessionId) {
    for (const request of [...pending.values()]) {
      if (request.event.sessionId === sessionId) request.finish();
    }
  }

  function cancelSession(sessionId) {
    cancelPending(sessionId);
    states.delete(sessionId);
    editorTexts.delete(sessionId);
    send({ method: "clear", sessionId });
  }

  function request(sessionId, method, data, opts) {
    if (opts?.signal?.aborted) return Promise.resolve(undefined);
    const event = { id: randomUUID(), sessionId, method, ...data };
    return new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        if (!pending.delete(event.id)) return;
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", abort);
        send({ method: "dismiss", id: event.id, sessionId });
        resolve(value);
      };
      const abort = () => finish();
      pending.set(event.id, { event, finish });
      opts?.signal?.addEventListener("abort", abort, { once: true });
      if (opts?.timeout > 0) {
        event.expiresAt = Date.now() + opts.timeout;
        timer = setTimeout(abort, opts.timeout);
      }
      send(event);
    });
  }

  function createContext(session, base) {
    const sessionId = session.sessionId;
    const state = new Map();
    states.set(sessionId, state);
    const emit = (method, data, key = method) => {
      const event = { sessionId, method, ...data };
      if (method !== "notify") state.set(key, event);
      send(event);
    };
    return {
      ...base,
      select: (title, options, opts) => request(sessionId, "select", { title, options }, opts),
      confirm: async (title, message, opts) => (await request(sessionId, "confirm", { title, message }, opts)) === true,
      input: (title, placeholder, opts) => request(sessionId, "input", { title, placeholder }, opts),
      editor: (title, prefill) => request(sessionId, "editor", { title, prefill }),
      notify: (message, type = "info") => emit("notify", { message, notifyType: type }),
      setStatus: (key, text) => emit("setStatus", { statusKey: key, statusText: text }, `status:${key}`),
      setWidget(key, content, options) {
        if (content === undefined || Array.isArray(content)) {
          emit("setWidget", { widgetKey: key, widgetLines: content, widgetPlacement: options?.placement }, `widget:${key}`);
        }
      },
      setTitle: (title) => emit("setTitle", { title }),
      setEditorText(text) {
        editorTexts.set(sessionId, text);
        emit("setEditorText", { text, id: randomUUID() });
      },
      // 与 RPC 一样，粘贴退化为设置正文；宿主负责保存与输入法保护。
      pasteToEditor(text) { this.setEditorText(text); },
      getEditorText: () => editorTexts.get(sessionId) ?? "",
      getToolsExpanded: () => state.get("setToolsExpanded")?.expanded ?? false,
      setToolsExpanded: (expanded) => emit("setToolsExpanded", { expanded }),
    };
  }

  function register(ipcMain) {
    const registered = new WeakSet();
    function isPage(event) {
      return event.sender === contents && event.senderFrame === contents?.mainFrame;
    }
    ipcMain.handle("agent:extension-ui-ready", (event) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error("仅主页面可连接扩展交互。");
      if (contents && contents !== event.sender && !contents.isDestroyed()) throw new Error("扩展交互页面已连接。");
      if (!registered.has(event.sender)) {
        registered.add(event.sender);
        const disconnectPage = () => { if (contents === event.sender) disconnect(); };
        event.sender.once("destroyed", disconnectPage);
        event.sender.on("render-process-gone", disconnectPage);
        event.sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) disconnectPage();
        });
      }
      contents = event.sender;
      for (const state of states.values()) for (const item of state.values()) send(item);
      for (const item of pending.values()) send(item.event);
    });
    ipcMain.handle("agent:extension-ui-response", (event, response) => {
      if (!isPage(event)) throw new Error("扩展交互来源无效。");
      const item = pending.get(response?.id);
      if (!item) return;
      const { method, options } = item.event;
      const value = response.cancelled ? undefined : response.value;
      if (value !== undefined && (
        (method === "confirm" && typeof value !== "boolean") ||
        (method !== "confirm" && typeof value !== "string") ||
        (method === "select" && !options.includes(value))
      )) throw new Error("扩展交互结果无效。");
      item.finish(value);
    });
    ipcMain.on("agent:extension-editor-state", (event, sessionId, text) => {
      if (isPage(event) && states.has(sessionId) && typeof text === "string") editorTexts.set(sessionId, text);
    });
  }

  function cancelAll() {
    for (const item of [...pending.values()]) item.finish();
  }

  function disconnect() {
    for (const item of [...pending.values()]) item.finish();
    contents = undefined;
    editorTexts.clear();
  }

  return { createContext, register, cancelSession, cancelPending, cancelAll, disconnect };
}

module.exports = { createExtensionUiBridge };

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  // 固定关闭协议；不向页面暴露 Electron 事件或通用 send。
  closeReady: () => ipcRenderer.send("agent:close-ready"),
  onPrepareClose: (callback) => {
    const listener = (_event, requestId) => {
      if (typeof requestId === "string" && requestId) callback(requestId);
    };
    ipcRenderer.on("agent:prepare-close", listener);
    return () => ipcRenderer.removeListener("agent:prepare-close", listener);
  },
  reportCloseResult: (requestId, saved) => {
    if (
      typeof requestId !== "string" ||
      !requestId ||
      typeof saved !== "boolean"
    ) {
      throw new Error("关闭保存确认无效。");
    }
    ipcRenderer.send("agent:close-result", { requestId, saved });
  },
  readModelSettings: () => ipcRenderer.invoke("agent:read-model-settings"),
  listSettingsModels: (provider) =>
    ipcRenderer.invoke("agent:list-settings-models", provider),
  fetchModelCatalog: (input) => ipcRenderer.invoke("agent:fetch-model-catalog", {
    baseUrl: input?.baseUrl, apiKey: input?.apiKey, api: input?.api, profileId: input?.profileId, provider: input?.provider,
  }),
  testModelConnection: input => ipcRenderer.invoke("agent:test-model-connection", {
    baseUrl: input?.baseUrl, apiKey: input?.apiKey, api: input?.api, profileId: input?.profileId, provider: input?.provider,
  }),
  cloneModelProfile: (id, name) => ipcRenderer.invoke("agent:clone-model-profile", id, name),
  refreshProfileModels: id => ipcRenderer.invoke("agent:refresh-profile-models", id),
  refreshBuiltinModels: provider => ipcRenderer.invoke("agent:refresh-builtin-models", provider),
  appendBuiltinModel: (provider, input) => ipcRenderer.invoke("agent:append-builtin-model", provider, {
    modelId: input?.modelId, api: input?.api, contextWindow: input?.contextWindow, maxTokens: input?.maxTokens,
    reasoning: input?.reasoning, vision: input?.vision,
  }),
  providerAuth: provider => ipcRenderer.invoke("agent:provider-auth", provider),
  addProviderKey: (provider, name, key) => ipcRenderer.invoke("agent:add-provider-key", provider, name, key),
  activateProviderKey: (provider, id) => ipcRenderer.invoke("agent:activate-provider-key", provider, id),
  removeProviderKey: (provider, id) => ipcRenderer.invoke("agent:remove-provider-key", provider, id),
  startProviderOAuth: provider => ipcRenderer.invoke("agent:provider-oauth-start", provider),
  replyProviderOAuth: (flowId, promptId, value) => ipcRenderer.invoke("agent:provider-oauth-reply", flowId, promptId, value),
  cancelProviderOAuth: id => ipcRenderer.invoke("agent:provider-oauth-cancel", id),
  listProviderOAuthFlows: () => ipcRenderer.invoke("agent:list-provider-oauth-flows"),
  logoutProviderOAuth: provider => ipcRenderer.invoke("agent:provider-oauth-logout", provider),
  openProviderOAuthLink: id => ipcRenderer.invoke("agent:open-provider-oauth-link", id),
  enrichModels: (ids, hints) => ipcRenderer.invoke("agent:enrich-models", ids, hints),
  cancelModelEnrichment: id => ipcRenderer.invoke("agent:cancel-model-enrichment", id),
  listModelEnrichments: () => ipcRenderer.invoke("agent:list-model-enrichments"),
  setThinkingLevel: level => ipcRenderer.invoke("agent:set-thinking-level", level),
  onModelSettingsEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("agent:model-settings-event", listener);
    void ipcRenderer.invoke("agent:watch-model-settings").catch(() => callback({ type: "error", message: "设置状态监听失败，请关闭后重开设置。" }));
    return () => { ipcRenderer.removeListener("agent:model-settings-event", listener); void ipcRenderer.invoke("agent:unwatch-model-settings").catch(() => {}); };
  },
  saveModelSettings: (settings) =>
    ipcRenderer.invoke("agent:save-model-settings", {
      name: settings?.name,
      kind: settings?.kind,
      provider: settings?.provider,
      modelId: settings?.modelId,
      baseUrl: settings?.baseUrl,
      authMode: settings?.authMode,
      apiKey: settings?.apiKey,
      api: settings?.api,
      contextWindow: settings?.contextWindow,
      maxTokens: settings?.maxTokens,
      replaceId: settings?.replaceId,
      reasoning: settings?.reasoning,
      vision: settings?.vision,
    }),
  setDefaultModelProfile: (id) =>
    ipcRenderer.invoke("agent:set-default-model-profile", id),
  hideModelProfile: (id) => ipcRenderer.invoke("agent:hide-model-profile", id),
  clearDefaultModelProfile: () => ipcRenderer.invoke("agent:clear-default-model-profile"),
  listModelProfiles: () => ipcRenderer.invoke("agent:list-model-profiles"),
  switchModelProfile: (id) =>
    ipcRenderer.invoke("agent:switch-model-profile", id),
  // 可选输入版本用于消费已保存的原文；没有版本时沿用原调用。
  sendMessage: (message, draftRequest) => {
    if (draftRequest === undefined) {
      return ipcRenderer.invoke("agent:send-message", message);
    }
    return ipcRenderer.invoke("agent:send-message", message, {
      sessionId: draftRequest?.sessionId,
      revision: draftRequest?.revision,
    });
  },
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
  // 只提交历史编号和布尔状态；目录与时间由主进程决定。
  setSessionPinned: (sessionId, pinned) =>
    ipcRenderer.invoke("agent:set-session-pinned", sessionId, pinned),
  setSessionArchived: (sessionId, archived) =>
    ipcRenderer.invoke("agent:set-session-archived", sessionId, archived),

  // 当前目录由主进程决定；读取不接受页面路径，恢复只传原会话编号。
  listUnsentSessions: () => ipcRenderer.invoke("agent:list-unsent-sessions"),
  restoreUnsentSession: (sessionId) =>
    ipcRenderer.invoke("agent:restore-unsent-session", sessionId),
  // 页面只能传会话编号，不能指定主进程读取的文件路径。
  previewSession: (sessionId) =>
    ipcRenderer.invoke("agent:preview-session", sessionId),

  // 获取当前会话的 ID，用于在列表中标记当前对话。
  currentSession: () => ipcRenderer.invoke("agent:current-session"),

    // 读取主进程当前会话；保存只传编号、原文和版本，不传工作目录。
  loadComposerDraft: () => ipcRenderer.invoke("agent:load-composer-draft"),
  saveComposerDraft: (sessionId, text, expectedRevision) =>
    ipcRenderer.invoke(
      "agent:save-composer-draft", sessionId, text, expectedRevision,
    ),

  // 只核对已登记的会话，不接收目录或页面提供的草稿状态。
  inspectComposerSend: (sessionId) =>
    ipcRenderer.invoke("agent:inspect-composer-send", sessionId),

  // 读取实际会话的模型与真实工作目录。
  getSessionInfo: () => ipcRenderer.invoke("agent:session-info"),
  // 仅提交明确确认的会话和发送编号，不接受目录、原文或状态对象。
  dismissComposerSend: (sessionId, sendId) =>
    ipcRenderer.invoke("agent:dismiss-composer-send", sessionId, sendId),

  // 页面只读取模型编号和名称，实际目录由主进程提供。
  listModels: () => ipcRenderer.invoke("agent:list-models"),

  // 只提交模型编号，供应商、地址和实际模型由主进程决定。
  switchModel: (modelId) => ipcRenderer.invoke("agent:switch-model", modelId),
  // 整理当前会话，以及取消正在进行的整理。
  compactSession: () => ipcRenderer.invoke("agent:compact-session"),

  cancelCompaction: () => ipcRenderer.invoke("agent:cancel-compaction"),

  // 保存位置由系统窗口选择，页面不传路径或导出内容。
  exportConversation: () => ipcRenderer.invoke("agent:export-conversation"),

  // 目录由系统窗口选择，页面不传路径。
  selectWorkspace: () => ipcRenderer.invoke("agent:select-workspace"),

  // 添加时由系统窗口选择目录，不接收页面提供的路径。
  listProjects: () => ipcRenderer.invoke("agent:list-projects"),
  addProject: () => ipcRenderer.invoke("agent:add-project"),
  // 页面只提交编号，工作目录由主进程从项目记录读取。
  openProject: (projectId) => ipcRenderer.invoke("agent:open-project", projectId),
  // 获取当前会话中已登记的草稿。
  getProposal: (id) => ipcRenderer.invoke("agent:get-proposal", id),

  // 读取当前会话的待保存草稿，不接受页面传入的会话编号。
  listProposals: () => ipcRenderer.invoke("agent:list-proposals"),

  // 只允许提交草稿编号，不接受页面传入的路径或替换内容。
  applyProposal: (id) => ipcRenderer.invoke("agent:apply-proposal", id),

  // 放弃尚未保存的草稿，只提交编号。
  discardProposal: (id) => ipcRenderer.invoke("agent:discard-proposal", id),
  // 订阅工具状态，并返回取消订阅方法。
  onToolEvent: (callback) => {
    const listener = (_event, toolEvent) => callback(toolEvent);
    ipcRenderer.on("agent:tool-event", listener);

    return () => {
      ipcRenderer.removeListener("agent:tool-event", listener);
    };
  },
  // 接收主进程确认的消费版本，不将 Electron 事件对象交给页面。
  onDraftConsumed: (callback) => {
    const listener = (_event, draft) => callback(draft);
    ipcRenderer.on("agent:draft-consumed", listener);

    return () => {
      ipcRenderer.removeListener("agent:draft-consumed", listener);
    };
  },
  // 订阅请求状态，返回取消订阅函数。
  onRequestStatus: (callback) => {
    const listener = (_event, status) => callback(status);

    ipcRenderer.on("agent:request-status", listener);

    return () => {
      ipcRenderer.removeListener("agent:request-status", listener);
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

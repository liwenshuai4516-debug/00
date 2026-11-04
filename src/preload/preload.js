const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  extensionUiReady: () => ipcRenderer.invoke("agent:extension-ui-ready"),
  respondExtensionUi: (response) => ipcRenderer.invoke("agent:extension-ui-response", {
    id: response?.id, value: response?.value, cancelled: response?.cancelled === true,
  }),
  syncExtensionEditor: (sessionId, text) => ipcRenderer.send("agent:extension-editor-state", sessionId, text),
  onExtensionUi: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("agent:extension-ui", listener);
    return () => ipcRenderer.removeListener("agent:extension-ui", listener);
  },
  listPiResources: () => ipcRenderer.invoke("agent:list-pi-resources"),
  managePiPackage: (request) => ipcRenderer.invoke("agent:manage-pi-package", request),
  onPiPackageProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("agent:pi-package-progress", listener);
    return () => ipcRenderer.removeListener("agent:pi-package-progress", listener);
  },

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

  readPromptSettings: () => ipcRenderer.invoke("agent:read-prompt-settings"),
  savePromptSettings: (input, expectedRevision) =>
    ipcRenderer.invoke("agent:save-prompt-settings", {
      testAgentPrompt: input?.testAgentPrompt,
    }, expectedRevision),
  getSessionPromptInfo: () => ipcRenderer.invoke("agent:session-prompt-info"),

  readModelConfiguration: () => ipcRenderer.invoke("agent:read-model-configuration"),
  openModelsConfiguration: () => ipcRenderer.invoke("agent:open-models-configuration"),
  reloadModels: () => ipcRenderer.invoke("agent:reload-models"),
  // 结构化读取官方 models.json，用于编辑表单；不含密钥与请求头。
  readModelCatalog: () => ipcRenderer.invoke("agent:read-model-catalog"),
  // 表单只提交字段值，文件路径与校验都在主进程完成。
  saveModel: input => ipcRenderer.invoke("agent:save-model", {
    providerId: input?.providerId,
    provider: {
      name: input?.provider?.name,
      baseUrl: input?.provider?.baseUrl,
      api: input?.provider?.api,
    },
    original: input?.original === undefined
      ? undefined
      : { providerId: input.original?.providerId, modelId: input.original?.modelId },
    model: {
      id: input?.model?.id,
      name: input?.model?.name,
      api: input?.model?.api,
      baseUrl: input?.model?.baseUrl,
      reasoning: input?.model?.reasoning,
      contextWindow: input?.model?.contextWindow,
      maxTokens: input?.model?.maxTokens,
      input: input?.model?.input,
      cost: input?.model?.cost,
      thinkingLevels: input?.model?.thinkingLevels,
      thinkingFormat: input?.model?.thinkingFormat,
      extra: input?.model?.extra,
    },
  }),
  deleteModel: (providerId, modelId) => ipcRenderer.invoke("agent:delete-model", providerId, modelId),
  setDefaultModel: (provider, modelId) => ipcRenderer.invoke("agent:set-default-model", provider, modelId),
  setThinkingLevel: level => ipcRenderer.invoke("agent:set-thinking-level", level),
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
  inspectUnsentSend: (sessionId) => ipcRenderer.invoke("agent:inspect-unsent-send", sessionId),
  dismissUnsentSend: (sessionId, sendId) => ipcRenderer.invoke("agent:dismiss-unsent-send", sessionId, sendId),
  restoreUnsentSession: (sessionId) =>
    ipcRenderer.invoke("agent:restore-unsent-session", sessionId),

  // 页面只能传会话编号，不能指定主进程读取的文件路径。
  previewSession: (sessionId) =>
    ipcRenderer.invoke("agent:preview-session", sessionId),
  // 只提交相对或绝对路径；解析、边界与大小校验都在主进程完成。
  readPreviewFile: (filePath) => {
    if (typeof filePath !== "string" || !filePath || filePath.length > 1024) {
      throw new Error("文件路径无效。");
    }
    return ipcRenderer.invoke("agent:read-preview-file", filePath);
  },
  // 输入框 @ 文件引用：只提交搜索词，路径解析与边界在主进程完成。
  searchWorkspaceFiles: (query) => {
    if (query !== undefined && query !== null && typeof query !== "string") {
      throw new Error("搜索词无效。");
    }
    return ipcRenderer.invoke("agent:search-workspace-files", query ?? "");
  },
  // 侧栏浏览器的开发者工具窗口由主进程打开。
  openBrowserDevTools: () => ipcRenderer.invoke("agent:open-browser-devtools"),
  // 只允许 http(s)；实际打开动作与校验在主进程完成。
  openExternalUrl: (url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error("只支持 http(s) 地址。");
    }
    return ipcRenderer.invoke("agent:open-external-url", url);
  },
  // 目录路径为空表示工作目录根；解析与边界同样在主进程完成。
  listWorkspaceDirectory: (dirPath) => {
    if (dirPath !== undefined && dirPath !== null && typeof dirPath !== "string") {
      throw new Error("目录路径无效。");
    }
    return ipcRenderer.invoke("agent:list-workspace-directory", dirPath ?? "");
  },

  // 获取当前会话的 ID，用于在列表中标记当前对话。
  currentSession: () => ipcRenderer.invoke("agent:current-session"),

  // 读取主进程当前会话；保存只传编号、原文和版本，不传工作目录。
  loadComposerDraft: () => ipcRenderer.invoke("agent:load-composer-draft"),
  saveComposerDraft: (sessionId, text, expectedRevision) =>
    ipcRenderer.invoke(
      "agent:save-composer-draft",
      sessionId,
      text,
      expectedRevision,
    ),

  // 读取实际会话的模型与真实工作目录。
  getSessionInfo: () => ipcRenderer.invoke("agent:session-info"),

  // 只核对已登记的会话，不接收目录或页面提供的草稿状态。
  inspectComposerSend: (sessionId) =>
    ipcRenderer.invoke("agent:inspect-composer-send", sessionId),

  // 仅提交明确确认的会话和发送编号，不接受目录、原文或状态对象。
  dismissComposerSend: (sessionId, sendId) =>
    ipcRenderer.invoke("agent:dismiss-composer-send", sessionId, sendId),

  // 页面只读取模型编号和名称，实际目录由主进程提供。
  listModels: () => ipcRenderer.invoke("agent:list-models"),

  // 只提交供应商和模型编号，地址与实际模型由主进程解析。
  switchModel: (modelId, provider) => ipcRenderer.invoke("agent:switch-model", modelId, provider),
  // 整理当前会话，以及取消正在进行的整理。
  // 说明为可选文本，由主进程校验后交给 SDK。
  compactSession: (customInstructions) =>
    ipcRenderer.invoke("agent:compact-session", customInstructions),

  cancelCompaction: () => ipcRenderer.invoke("agent:cancel-compaction"),

  // 命令菜单只读取名称、说明和来源，不返回技能正文或扩展实现。
  listSlashCommands: () => ipcRenderer.invoke("agent:list-slash-commands"),

  // 重新加载扩展、技能、模板和上下文，不请求模型。
  reloadResources: () => ipcRenderer.invoke("agent:reload-resources"),

  // 保存位置由系统窗口选择，页面不传路径或导出内容。
  exportConversation: () => ipcRenderer.invoke("agent:export-conversation"),

  // 目录由系统窗口选择，页面不传路径。
  selectWorkspace: () => ipcRenderer.invoke("agent:select-workspace"),

  // 添加时由系统窗口选择目录，不接收页面提供的路径。
  listProjects: () => ipcRenderer.invoke("agent:list-projects"),
  renameProject: (projectId, name) =>
    ipcRenderer.invoke("agent:rename-project", projectId, name),
  addProject: () => ipcRenderer.invoke("agent:add-project"),

  // 环境列表不包含密码原文；保存时密码缺省表示保持原值，空串表示清除。
  listProjectEnvironments: () =>
    ipcRenderer.invoke("agent:list-project-environments"),
  saveProjectEnvironment: (projectId, input) => {
    const payload = {
      name: input?.name,
      address: input?.address,
      account: input?.account,
    };
    if (input !== null && typeof input === "object"
      && Object.hasOwn(input, "password")) {
      payload.password = input.password;
    }
    return ipcRenderer.invoke(
      "agent:save-project-environment",
      projectId,
      payload,
    );
  },
  deleteProjectEnvironment: (projectId) =>
    ipcRenderer.invoke("agent:delete-project-environment", projectId),

  // 测试数据只提交项目编号与 qa/data 下的相对路径。
  listTestData: (projectId) =>
    ipcRenderer.invoke("agent:list-test-data", projectId),
  deleteTestData: (projectId, relativePath) =>
    ipcRenderer.invoke("agent:delete-test-data", projectId, relativePath),

  // 页面只提交编号，工作目录由主进程从项目记录读取。
  openProject: (projectId) =>
    ipcRenderer.invoke("agent:open-project", projectId),

  // 获取当前会话中已登记的草稿。
  getProposal: (id) => ipcRenderer.invoke("agent:get-proposal", id),

  // 读取当前会话的待保存草稿，不接受页面传入的会话编号。
  listProposals: () => ipcRenderer.invoke("agent:list-proposals"),

  // 只允许提交草稿编号，不接受页面传入的路径或替换内容。
  applyProposal: (id) => ipcRenderer.invoke("agent:apply-proposal", id),

  // 放弃尚未保存的草稿，只提交编号。
  discardProposal: (id) => ipcRenderer.invoke("agent:discard-proposal", id),
  // 原生输出仅开放固定通道，取消订阅只移除本次监听。
  onOutputEvent: (callback) => {
    const listener = (_event, output) => callback(output);
    ipcRenderer.on("agent:output-event", listener);
    return () => ipcRenderer.removeListener("agent:output-event", listener);
  },

  // 兼容旧文本/工具订阅；新版页面以原生输出事件为准。
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

// IPC 负责通信和操作互斥，业务逻辑放在对应服务中。
function registerAgentIpc(
  ipcMain,
  sessionService,
  chatService,
  proposalReviewService,
  proposalApplyService,
  conversationExportService,
  workspaceSelectionService,
  projectService,
  composerDraftService,
  modelProviderService,
    promptSettingsStore,

) {
  let operationPending = false;

  // 在进入异步操作之前占用状态，防止切换、审阅和保存交叉执行。
  function runIdleOperation(operation) {
    if (chatService.isBusy() || operationPending) {
      throw new Error("请等待当前回复结束或其他操作完成后再继续。");
    }

    operationPending = true;

    return Promise.resolve()
      .then(operation)
      .finally(() => {
        operationPending = false;
      });
  }

  const { registerModelIpc } = require("./model-ipc.js");
  registerModelIpc(ipcMain, modelProviderService, sessionService, runIdleOperation);

  const { createPiPackageService } = require("../services/pi-package-service.js");
  const piPackages = createPiPackageService(sessionService);
  ipcMain.handle("agent:list-pi-resources", () => runIdleOperation(() => piPackages.list()));
  ipcMain.handle("agent:manage-pi-package", (event, input) => runIdleOperation(() =>
    piPackages.manage({ action: input?.action, source: input?.source, scope: input?.scope, filters: input?.filters }, progress => {
      if (!event.sender.isDestroyed()) event.sender.send("agent:pi-package-progress", progress);
    }),
  ));

  ipcMain.handle("agent:read-prompt-settings", async () => {
    const settings = await promptSettingsStore.read();
    const { AGENT_SYSTEM_PROMPT } = await import("../prompts/agent-system-prompt.mjs");
    return { ...settings, basePrompt: AGENT_SYSTEM_PROMPT };
  });

  ipcMain.handle("agent:save-prompt-settings", (_event, input, expectedRevision) =>
    // 保存默认配置也走现有互斥入口，防止与新建或恢复会话交叉。
    runIdleOperation(() => promptSettingsStore.save(input?.testAgentPrompt, expectedRevision)),
  );

  ipcMain.handle("agent:session-prompt-info", () => runIdleOperation(async () => {
    const session = await sessionService.getSession(true);
    const snapshot = session.desktopPromptSnapshot;
    if (!snapshot) return null;
    return {
      sessionId: session.sessionId,
      revision: snapshot.revision,
      origin: snapshot.origin,
      testAgentPrompt: snapshot.testAgentPrompt,
    };
  }));


  ipcMain.handle("agent:load-history", () => sessionService.loadHistory());
  ipcMain.handle("agent:current-session", () =>
    sessionService.currentSession(),
  );
  // 输入保存独立于生成与切换互斥；原会话归属和版本由服务校验。
  ipcMain.handle("agent:load-composer-draft", () =>
    composerDraftService.loadCurrentDraft(),
  );
  ipcMain.handle(
    "agent:save-composer-draft",
    (_event, sessionId, text, expectedRevision) =>
      composerDraftService.saveDraft(sessionId, text, expectedRevision),
  );

  // 当前会话由主进程决定，页面不需要传入会话编号。
  ipcMain.handle("agent:session-info", () => sessionService.getSessionInfo());

  // 页面预览只读工作目录内的文本文件；不占用空闲互斥，生成期间也可查看。
  const { createFilePreviewReader } = require("../services/file-preview-service.js");
  const readPreviewFile = createFilePreviewReader(
    async () => (await sessionService.getSessionInfo()).workspaceDir,
  );
  ipcMain.handle("agent:read-preview-file", (_event, filePath) => readPreviewFile(filePath));

  // 异常后的状态核对必须等生成结束，读取期间阻止新的发送与会话操作。
  ipcMain.handle("agent:inspect-composer-send", (_event, sessionId) => {
    return runIdleOperation(() => composerDraftService.inspectSend(sessionId));
  });

  // 只读当前会话的模型目录，不接受页面指定供应商或会话。
  // 用户明确核对后解除限制；生成和其他会话操作期间不可执行。
  ipcMain.handle("agent:dismiss-composer-send", (_event, sessionId, sendId) => {
    return runIdleOperation(() => composerDraftService.dismissSend(sessionId, sendId));
  });
  ipcMain.handle("agent:list-models", () => sessionService.listModels());
  // 切换模型与生成、整理、保存和会话切换共用互斥入口。

  ipcMain.handle("agent:switch-model", (_event, modelId, provider) => {
    return runIdleOperation(() => sessionService.switchModel(modelId, provider));
  });

  // 整理只针对主进程当前会话，不接收页面指定的会话编号。
  ipcMain.handle("agent:compact-session", (_event, customInstructions) => {
    return runIdleOperation(() => sessionService.compactSession(customInstructions));
  });

  // 命令菜单只读取资源命令，不占用会话操作互斥。
  ipcMain.handle("agent:list-slash-commands", () => {
    return sessionService.listSlashCommands();
  });

  // 与发送、整理共用互斥，避免重载期间同时改写会话。
  ipcMain.handle("agent:reload-resources", () => {
    return runIdleOperation(() => sessionService.reloadResources());
  });

  // 取消不能经过互斥入口，否则会被正在整理的操作阻止。
  ipcMain.handle("agent:cancel-compaction", () =>
    sessionService.cancelCompaction(),
  );

  // 导出与生成、整理、保存和切换会话共用互斥入口。
  ipcMain.handle("agent:export-conversation", (event) => {
    return runIdleOperation(() =>
      conversationExportService.exportConversation(event.sender),
    );
  });

  // 从打开选择窗口到完成切换，全程占用同一个互斥入口。
  ipcMain.handle("agent:select-workspace", (event) => {
    return runIdleOperation(() =>
      workspaceSelectionService.selectWorkspace(event.sender),
    );
  });

  // 项目列表只读；添加项目从选择窗口到落盘全程互斥。
  ipcMain.handle("agent:list-projects", () => projectService.listProjects());
  ipcMain.handle("agent:add-project", (event) => {
    return runIdleOperation(() => projectService.addProject(event.sender));
  });

  // 按登记编号打开，与生成、保存和其他切换共用互斥入口。
  ipcMain.handle("agent:open-project", (_event, projectId) => {
    return runIdleOperation(() => projectService.openProject(projectId));
  });

  ipcMain.handle("agent:rename-project", (_event, projectId, name) => {
    return runIdleOperation(() => projectService.renameProject(projectId, name));
  });

  // 环境列表只读；保存和删除与项目切走、生成共用互斥入口。
  ipcMain.handle("agent:list-project-environments", () =>
    projectService.listProjectEnvironments(),
  );
  ipcMain.handle("agent:save-project-environment", (_event, projectId, input) => {
    return runIdleOperation(() =>
      projectService.saveProjectEnvironment(projectId, input),
    );
  });
  ipcMain.handle("agent:delete-project-environment", (_event, projectId) => {
    return runIdleOperation(() =>
      projectService.deleteProjectEnvironment(projectId),
    );
  });

  // 测试数据读取只返回相对路径和元信息；删除只接受项目编号与相对路径。
  ipcMain.handle("agent:list-test-data", (_event, projectId) =>
    projectService.listTestData(projectId),
  );
  ipcMain.handle("agent:delete-test-data", (_event, projectId, relativePath) => {
    return runIdleOperation(() =>
      projectService.deleteTestData(projectId, relativePath),
    );
  });

  ipcMain.handle("agent:list-sessions", () => sessionService.listSessions());

  ipcMain.handle("agent:set-session-pinned", (_event, sessionId, pinned) =>
    runIdleOperation(() => sessionService.setSessionPinned(sessionId, pinned)),
  );

  ipcMain.handle("agent:set-session-archived", (_event, sessionId, archived) =>
    runIdleOperation(() => sessionService.setSessionArchived(sessionId, archived)),
  );

  // 列表依赖当前真实目录；与恢复共用互斥入口，避免读取时目录被切换。
  ipcMain.handle("agent:list-unsent-sessions", () =>
    runIdleOperation(() => sessionService.listUnsentSessions()),
  );

  ipcMain.handle("agent:inspect-unsent-send", (_event, sessionId) =>
    runIdleOperation(() => sessionService.inspectUnsentSend(sessionId)),
  );
  ipcMain.handle("agent:dismiss-unsent-send", (_event, sessionId, sendId) =>
    runIdleOperation(() => sessionService.dismissUnsentSend(sessionId, sendId)),
  );

  // 页面只提交编号，状态快照、目录和模型均由主进程读取。
  ipcMain.handle("agent:restore-unsent-session", (_event, sessionId) =>
    runIdleOperation(() => sessionService.restoreUnsentSession(sessionId)),
  );

  ipcMain.handle("agent:open-session", (_event, sessionId) => {
    return runIdleOperation(() => sessionService.openSession(sessionId));
  });

  // 预览只读文件，不切换会话，可以独立于当前聊天执行。
  ipcMain.handle("agent:preview-session", (_event, sessionId) =>
    sessionService.previewSession(sessionId),
  );

  ipcMain.handle("agent:new-chat", () => {
    return runIdleOperation(() => sessionService.newChat());
  });

  ipcMain.handle("agent:rename-session", (_event, name) => {
    return runIdleOperation(() => sessionService.renameSession(name));
  });

  ipcMain.handle("agent:list-proposals", () => {
    return runIdleOperation(() => chatService.listProposals());
  });

  ipcMain.handle("agent:get-proposal", (_event, id) => {
    return runIdleOperation(() => proposalReviewService.review(id));
  });

  // 与保存、切换会话共用互斥入口。
  ipcMain.handle("agent:discard-proposal", (_event, id) => {
    return runIdleOperation(() => chatService.discardProposal(id));
  });
  ipcMain.handle("agent:apply-proposal", (_event, id) => {
    return runIdleOperation(() => proposalApplyService.apply(id));
  });

  ipcMain.handle("agent:send-message", (event, message, draftRequest) => {
    // chatService 自己负责拒绝重复生成；这里阻止保存期间发送。
    if (operationPending) {
      throw new Error("请等待当前操作结束后再发送消息。");
    }

    // 只接受会话编号和输入版本，不转发页面提供的目录等字段。
    const draft =
      draftRequest === undefined
        ? undefined
        : {
            sessionId: draftRequest?.sessionId,
            revision: draftRequest?.revision,
          };

    return chatService.send(
      message,
      (delta) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("agent:text-delta", delta);
        }
      },
      (toolEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("agent:tool-event", toolEvent);
        }
      },
      (status) => {
        // 只通知发起请求的页面；页面销毁后停止发送。
        if (!event.sender.isDestroyed()) {
          event.sender.send("agent:request-status", status);
        }
      },
      draft,
      (ack) => {
        // 页面关闭不影响主进程继续发送和收尾；确认只发给请求来源。
        if (!event.sender.isDestroyed()) {
          event.sender.send("agent:draft-consumed", {
            sessionId: ack.sessionId,
            sendId: ack.sendId,
            text: ack.text,
            revision: ack.revision,
          });
        }
      },
      (output) => {
        if (!event.sender.isDestroyed()) event.sender.send("agent:output-event", output);
      },
    );
  });

  // 停止生成不经过上述互斥入口。
  ipcMain.handle("agent:stop", () => {
    sessionService.cancelExtensionUi?.();
    return chatService.stop();
  });
}

module.exports = { registerAgentIpc };

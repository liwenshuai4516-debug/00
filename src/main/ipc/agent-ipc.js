// IPC 负责通信和操作互斥，业务逻辑放在对应服务中。
function registerAgentIpc(
  ipcMain,
  sessionService,
  chatService,
  proposalReviewService,
  proposalApplyService,
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

  ipcMain.handle("agent:load-history", () => sessionService.loadHistory());
  ipcMain.handle("agent:current-session", () =>
    sessionService.currentSession(),
  );

    // 当前会话由主进程决定，页面不需要传入会话编号。
  ipcMain.handle("agent:session-info", () =>
    sessionService.getSessionInfo(),
  );
  
  ipcMain.handle("agent:list-sessions", () => sessionService.listSessions());

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

  ipcMain.handle("agent:apply-proposal", (_event, id) => {
    return runIdleOperation(() => proposalApplyService.apply(id));
  });

  ipcMain.handle("agent:send-message", (event, message) => {
    // chatService 自己负责拒绝重复生成；这里阻止保存期间发送。
    if (operationPending) {
      throw new Error("请等待当前操作结束后再发送消息。");
    }

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
    );
  });

  // 停止生成不经过上述互斥入口。
  ipcMain.handle("agent:stop", () => chatService.stop());
}

module.exports = { registerAgentIpc };

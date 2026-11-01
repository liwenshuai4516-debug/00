//应用启动与服务组装
const { createWorkspaceSettings } = require("./storage/workspace-settings.js");

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const { loadEnvFile } = require("node:process");
const { createSessionService } = require("./services/session-service.js");
const { createChatService } = require("./services/chat-service.js");
const {
  createConversationExportService,
} = require("./services/conversation-export-service.js");
const { registerAgentIpc } = require("./ipc/agent-ipc.js");
const { registerWindowLifecycle } = require("./lifecycle/window-lifecycle.js");
const { createProposalStore } = require("./services/proposal-store.js");

const { createProposalStorage } = require("./storage/proposal-storage.js");
const {
  createProposalReviewService,
} = require("./services/proposal-review-service.js");

const {
  createProposalApplyService,
} = require("./services/proposal-apply-service.js");

// 开发阶段使用项目根目录存放配置和会话。
const projectRoot = path.resolve(__dirname, "../..");
loadEnvFile(path.join(projectRoot, ".env"));

// 在应用入口组装服务，确保所有接口共享同一份状态。
// 已保存的目录优先；尚无记录时使用 .env 默认目录。
const workspaceSettings = createWorkspaceSettings(
  path.join(app.getPath("userData"), "workspace.json"),
  process.env.AGENT_WORKSPACE_DIR,
);

const sessionService = createSessionService(
  path.join(projectRoot, "sessions"),
  undefined,
  workspaceSettings.load,
  workspaceSettings.save,
); // 草稿与会话都保存在当前项目的 sessions 目录内。
const proposalStorage = createProposalStorage(
  path.join(projectRoot, "sessions", "proposals"),
);

const proposalStore = createProposalStore(proposalStorage);

// undefined 表示继续使用默认的 Pi 发送函数。
const chatService = createChatService(sessionService, undefined, proposalStore);

// 文件操作以实际会话为准，不固定使用启动时的环境变量。
async function getCurrentWorkspaceDir() {
  const session = await sessionService.getSession(true);
  return session.sessionManager.getCwd();
}

const proposalReviewService = createProposalReviewService(
  getCurrentWorkspaceDir,
  chatService,
);

const proposalApplyService = createProposalApplyService(
  getCurrentWorkspaceDir,
  chatService,
  sessionService,
);

// 系统保存窗口由入口组装，导出服务不直接依赖 Electron。
const conversationExportService = createConversationExportService(
  sessionService,
  (sender, options) => {
    // 发起导出的窗口已关闭时，不再弹出保存面板。
    if (sender.isDestroyed()) {
      return { canceled: true };
    }

    const parentWindow = BrowserWindow.fromWebContents(sender);
    if (!parentWindow) {
      return { canceled: true };
    }

    return dialog.showSaveDialog(parentWindow, {
      ...options,
      defaultPath: path.join(app.getPath("documents"), "对话.txt"),
    });
  },
);

registerAgentIpc(
  ipcMain,
  sessionService,
  chatService,
  proposalReviewService,
  proposalApplyService,
  conversationExportService,
);
function createWindow() {
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(projectRoot, "src/preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 每次创建窗口都绑定，包括 macOS 关闭后重新打开的窗口。
  registerWindowLifecycle(window, {
    async stop() {
      // 两项清理都要执行，避免其中一步失败后跳过另一项。
      try {
        sessionService.cancelCompaction();
      } finally {
        await chatService.stop();
      }
    },
  });
  window.loadFile(path.join(projectRoot, "src/renderer/index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
// 原进程没有窗口时，允许单实例入口重新创建窗口。
module.exports = { createWindow };

//应用启动与服务组装

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { loadEnvFile } = require("node:process");
const { createSessionService } = require("./services/session-service.js");
const { createChatService } = require("./services/chat-service.js");
const { registerAgentIpc } = require("./ipc/agent-ipc.js");

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
const sessionService = createSessionService(path.join(projectRoot, "sessions"));
// 草稿与会话都保存在当前项目的 sessions 目录内。
const proposalStorage = createProposalStorage(
  path.join(projectRoot, "sessions", "proposals"),
);

const proposalStore = createProposalStore(proposalStorage);

// undefined 表示继续使用默认的 Pi 发送函数。
const chatService = createChatService(sessionService, undefined, proposalStore);

// 审阅使用与 Pi 工具一致的工作目录。
const proposalReviewService = createProposalReviewService(
  process.env.AGENT_WORKSPACE_DIR,
  chatService,
);

// 保存和审阅使用相同工作目录、相同聊天服务。
const proposalApplyService = createProposalApplyService(
  process.env.AGENT_WORKSPACE_DIR,
  chatService,
  sessionService,
);

// 整个应用生命周期只注册一次，不随窗口重新创建。
registerAgentIpc(
  ipcMain,
  sessionService,
  chatService,
  proposalReviewService,
  proposalApplyService,
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

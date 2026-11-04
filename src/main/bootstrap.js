//应用启动与服务组装
const {
  resolveUiTestingRuntime,
} = require("./capabilities/ui-testing/runtime-paths.js");
const { createWorkspaceSettings } = require("./storage/workspace-settings.js");
const { createProjectStore } = require("./storage/project-store.js");
const { createProjectService } = require("./services/project-service.js");
const { createSessionStateStore } = require("./storage/session-state-store.js");
const {
  createPromptSettingsStore,
} = require("./storage/prompt-settings-store.js");

const {
  createComposerDraftService,
} = require("./services/composer-draft-service.js");
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
} = require("electron");
const { createModelProviderService } = require("./services/model-provider-service.js");
const path = require("node:path");
const { loadEnvFile } = require("node:process");
const { createSessionService } = require("./services/session-service.js");
const { createChatService } = require("./services/chat-service.js");
const {
  createConversationExportService,
} = require("./services/conversation-export-service.js");
const {
  createWorkspaceSelectionService,
} = require("./services/workspace-selection-service.js");
const { registerAgentIpc } = require("./ipc/agent-ipc.js");
const { registerWindowLifecycle } = require("./lifecycle/window-lifecycle.js");

const {
  registerWindowCloseGuard,
} = require("./lifecycle/window-close-guard.js");
const { registerAppQuitGuard } = require("./lifecycle/app-quit-guard.js");
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
try {
  loadEnvFile(path.join(projectRoot, ".env"));
} catch (error) {
  // 未创建 .env 时仍允许打开配置页面；其他读取错误不能忽略。
  if (error.code !== "ENOENT") throw error;
}

const modelProviderService = createModelProviderService(file => shell.openPath(file));

const { createExtensionUiBridge } = require("./resources/extension-ui-bridge.js");
const extensionUi = createExtensionUiBridge();
extensionUi.register(ipcMain);

// 每次创建会话按自身记录解析配置；新会话才读取默认选择。
async function createConfiguredAgent(
  sessionDir,
  resume,
  sessionPath,
  workspaceDir,
  recovery,
  resumeOptions,
) {
  await app.whenReady();

  const { createPiAgent } = await import("./pi-agent.mjs");
  const { createDesktopPiOptions } = require("./resources/desktop-pi-options.js");
  return createPiAgent(
    sessionDir, resume, sessionPath, workspaceDir,
    undefined, recovery, resumeOptions,
    { promptSettingsStore, sessionStateStore },
    {
      ...createDesktopPiOptions(dialog, () => app.quit()),
      createUiContext: extensionUi.createContext,
      cancelUi: extensionUi.cancelSession,
      cancelPendingUi: extensionUi.cancelPending,
      uiTestingRuntime: resolveUiTestingRuntime(app, projectRoot),
    },
  );
}

// 在应用入口组装服务，确保所有接口共享同一份状态。
// 已保存的目录优先；尚无记录时使用 .env 默认目录。
const workspaceSettings = createWorkspaceSettings(
  path.join(app.getPath("userData"), "workspace.json"),
  process.env.AGENT_WORKSPACE_DIR,
);

// 输入与组织状态共用一个存储实例，独立于 Pi 历史文件。
const sessionStateStore = createSessionStateStore(
  path.join(app.getPath("userData"), "session-state"),
);

const promptSettingsStore = createPromptSettingsStore(
  path.join(app.getPath("userData"), "prompt-settings.json"),
  // 主进程是 CommonJS，按需加载已有的 ES Module 默认提示词。
  async () =>
    (await import("./prompts/test-agent-prompt.mjs")).TEST_AGENT_PROMPT,
);

const sessionService = createSessionService(
  path.join(projectRoot, "sessions"),
  createConfiguredAgent,
  workspaceSettings.load,
  workspaceSettings.save,
  sessionStateStore,
);
sessionService.cancelExtensionUi = extensionUi.cancelAll;
// 文件草稿与 Pi 会话保存在当前项目的 sessions 目录内。

const composerDraftService = createComposerDraftService(
  sessionService,
  sessionStateStore,
);

// 草稿与会话都保存在当前项目的 sessions 目录内。
const proposalStorage = createProposalStorage(
  path.join(projectRoot, "sessions", "proposals"),
);

const proposalStore = createProposalStore(proposalStorage);

// undefined 表示继续使用默认的 Pi 发送函数。
const chatService = createChatService(
  sessionService,
  undefined,
  proposalStore,
  sessionStateStore,
);
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

// 两种目录选择共用窗口绑定与关闭检查。
async function chooseWorkspaceDirectory(sender, options) {
  if (sender.isDestroyed()) return { canceled: true };

  const parentWindow = BrowserWindow.fromWebContents(sender);
  if (!parentWindow || parentWindow.isDestroyed()) {
    return { canceled: true };
  }

  const selection = await dialog.showOpenDialog(parentWindow, options);

  // 选择期间关闭窗口时，不继续切换会话或登记项目。
  if (sender.isDestroyed() || parentWindow.isDestroyed()) {
    return { canceled: true };
  }

  return selection;
}

const workspaceSelectionService = createWorkspaceSelectionService(
  sessionService,
  chooseWorkspaceDirectory,
);
const projectStore = createProjectStore(
  path.join(projectRoot, "config", "projects.local.json"),
  path.join(app.getPath("userData"), "projects.json"),
);
const projectService = createProjectService(
  projectStore,
  chooseWorkspaceDirectory,
  sessionService,
);

registerAgentIpc(
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
);

const quitGuard = registerAppQuitGuard(app, BrowserWindow);

function createWindow() {
  // 退出进行中不再创建新窗口；失败取消退出后仍可正常重新打开。
  if (quitGuard.isQuitting()) return;
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(projectRoot, "src/preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerWindowCloseGuard(window, ipcMain, quitGuard.cancelQuit, () =>
    sessionService.closeSession(),
  );

  // 每次创建窗口都绑定，包括 macOS 关闭后重新打开的窗口。
  registerWindowLifecycle(window, {
    async stop() {
      extensionUi.disconnect();
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

// 原进程没有窗口时，允许单实例入口重新创建窗口。
module.exports = { createWindow };

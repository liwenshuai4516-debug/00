const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { loadEnvFile } = require("node:process");
const { existsSync } = require("node:fs");

// 导入 path 后，再计算项目根目录。
const projectRoot = path.resolve(__dirname, "../..");

// 从项目根目录读取模型配置。
loadEnvFile(path.join(projectRoot, ".env"));

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
  // 使用绝对路径，避免受启动命令所在目录影响。
  window.loadFile(path.join(projectRoot, "src/renderer/index.html"));
}

// 保存当前会话，避免每条消息都重新创建。
let sessionPromise;
// 记录当前请求，供停止按钮中断。
let activeRequest;

// 获取当前会话；首次打开页面时可以恢复最近的会话。
async function getSession(resume = false) {
  if (!sessionPromise) {
    const { createPiAgent } = await import("./pi-agent.mjs");
    // 会话继续保存在项目根目录。
    const sessionDir = path.join(projectRoot, "sessions");
    // 创建 Promise 前再次检查，避免异步加载期间重复创建。
    if (!sessionPromise) {
      sessionPromise = createPiAgent(sessionDir, resume).catch((error) => {
        sessionPromise = undefined;
        throw error;
      });
    }
  }

  return sessionPromise;
}

// 将 Pi 会话中的文本消息转换为页面需要的数据。
function getHistory(session) {
  return session.messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("");

      return { role: message.role, text };
    })
    .filter((message) => message.text);
}

ipcMain.handle("agent:load-history", async () => {
  const session = await getSession(true);
  return getHistory(session);
});

ipcMain.handle("agent:send-message", async (event, message) => {
  // 页面当前只允许一次发送一条消息。
  if (activeRequest) {
    throw new Error("已有消息正在生成。");
  }

  const request = { stopped: false, started: false, session: null };
  activeRequest = request;

  try {
    const { sendMessage } = await import("./pi-agent.mjs");
    const session = await getSession();
    request.session = session;

    // 如果初始化期间已经点击停止，就不再发起模型请求。
    if (request.stopped) {
      return { stopped: true };
    }

    request.started = true;

    try {
      await sendMessage(session, message, (delta) => {
        if (!request.stopped && !event.sender.isDestroyed()) {
          event.sender.send("agent:text-delta", delta);
        }
      });
    } catch (error) {
      // 主动停止可能使模型请求报中断错误。
      if (!request.stopped) {
        throw error;
      }
    }

    return { stopped: request.stopped };
  } finally {
    activeRequest = undefined;
  }
});

ipcMain.handle("agent:stop", async () => {
  const request = activeRequest;

  if (!request) return;

  // 先记录停止状态，避免继续向页面发送文本。
  request.stopped = true;

  if (request.started) {
    // Pi 的 abort 会中断当前生成并等待 Agent 空闲。
    await request.session.abort();
  }
});

// 返回当前会话的 ID，供页面标记当前对话。
ipcMain.handle("agent:current-session", async () => {
  const session = await getSession(true);
  return session.sessionId;
});
// 将名称写入当前 Pi 会话。
ipcMain.handle("agent:rename-session", async (_event, name) => {
  if (activeRequest) {
    throw new Error("请等待当前回复结束后再重命名。");
  }

  if (typeof name !== "string" || !name.trim()) {
    throw new Error("请输入对话名称。");
  }

  const session = await getSession();

  // 空对话尚未保存，先发送一条消息再设置名称。
  if (!session.sessionFile || !existsSync(session.sessionFile)) {
    throw new Error("请先发送一条消息，再重命名对话。");
  }

  session.setSessionName(name.trim());
});
// 列出项目目录中保存的会话。
ipcMain.handle("agent:list-sessions", async () => {
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");
  const sessionDir = path.join(projectRoot, "sessions");
  const sessions = await SessionManager.list(process.cwd(), sessionDir);

  // 只把页面展示和选择所需的信息传给渲染进程。
  return sessions.map((session) => ({
    id: session.id,
    title: session.name || session.firstMessage || "未命名对话",
  }));
});

// 按会话 ID 打开历史对话。
ipcMain.handle("agent:open-session", async (_event, sessionId) => {
  if (activeRequest) {
    throw new Error("请等待当前回复结束后再切换对话。");
  }

  const { SessionManager } = await import("@mariozechner/pi-coding-agent");
  const { createPiAgent } = await import("./pi-agent.mjs");
  const sessionDir = path.join(projectRoot, "sessions");
  const sessions = await SessionManager.list(process.cwd(), sessionDir);

  // 从已登记的会话中查找路径，不直接接受页面传入的文件路径。
  const selected = sessions.find((session) => session.id === sessionId);

  if (!selected) {
    throw new Error("未找到该历史对话，请刷新列表后重试。");
  }

  // 新会话成功打开后，再释放旧会话。
  const nextSession = await createPiAgent(sessionDir, false, selected.path);
  const previousSession = sessionPromise ? await sessionPromise : undefined;

  sessionPromise = Promise.resolve(nextSession);
  previousSession?.dispose();

  return getHistory(nextSession);
});
ipcMain.handle("agent:new-chat", async () => {
  if (sessionPromise) {
    const session = await sessionPromise;
    session.dispose();
    sessionPromise = undefined;
  }

  // 明确创建新会话，不恢复旧消息。
  await getSession(false);
});

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

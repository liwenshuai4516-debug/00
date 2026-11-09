const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-watchdog-ui-"));
  app.setPath("userData", temporary);
  await app.whenReady();
  const id = "watchdog-fixture";
  const store = createSessionStateStore(path.join(temporary, "state"));
  let watchdog, finish, sends = 0;
  const session = {
    sessionId: id, sessionManager: { getCwd: () => temporary },
    abort: async () => finish.resolve(),
  };
  const sessions = {
    getSession: async () => session,
    currentSession: async () => id,
    loadHistory: async () => [],
    getSessionInfo: async () => ({ sessionId: id, workspaceDir: temporary, contextUsage: null }),
    listSessions: async () => [{ id, title: "看门狗离线验证", workspaceDir: temporary, updatedAt: 1 }],
    listUnsentSessions: async () => [],
    listModels: async () => ({ provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "离线模型" }] }),
    listSlashCommands: async () => [],
  };
  const chat = createChatService(sessions, async () => async (_session, _text, onText) => {
    sends++;
    onText("已保留本轮完成的内容。");
    finish = Promise.withResolvers();
    await finish.promise;
  }, undefined, store, undefined, undefined, callbacks => {
    watchdog = callbacks;
    return { touch() {}, dispose() {} };
  });
  registerAgentIpc(ipcMain, sessions, chat, {}, {}, {}, {}, { listProjects: async () => [] },
    createComposerDraftService(sessions, store), {});
  const win = new BrowserWindow({ width: 1100, height: 800, show: false,
    webPreferences: { preload: path.resolve(__dirname, "../../src/preload/preload.js"), contextIsolation: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
  const js = source => win.webContents.executeJavaScript(source);
  async function until(expression) {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`页面状态未满足：${expression}`);
  }
  try {
    await win.loadFile(path.resolve(__dirname, "../../src/renderer/index.html"));
    await until("!document.getElementById('new-chat-button').disabled");
    await js("document.getElementById('message-input').value='继续处理我的任务';document.getElementById('message-input').dispatchEvent(new Event('input'));");
    await until("!document.getElementById('send-button').disabled");
    await js("document.getElementById('message-form').requestSubmit()");
    await until("document.getElementById('messages').textContent.includes('已保留本轮完成的内容')");
    assert.equal(chat.isBusy(), true);
    // 仅注入十分钟到期信号；真实计时阈值由单元测试推进时钟验证。
    watchdog.onTimeout();
    await until("!document.getElementById('new-chat-button').disabled");
    assert.equal(chat.isBusy(), false);
    assert.equal(sends, 1);
    assert.match(await js("document.getElementById('messages').textContent"), /已保留本轮完成的内容.*看门狗已停止/s);
    assert.match(await js("document.getElementById('request-status').textContent"), /未确认/);
    assert.equal((await store.load(id)).pendingSend.text, "继续处理我的任务");
    assert.equal(await js("document.getElementById('message-input').value"), "");
    if (process.env.WATCHDOG_SCREENSHOT_PATH) {
      await fs.writeFile(process.env.WATCHDOG_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    console.log("通过：看门狗停止后恢复页面交互，保留已有内容和发送快照，不自动重发。");
  } finally {
    win.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

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
  const originalId = "watchdog-fixture";
  let id = originalId;
  const store = createSessionStateStore(path.join(temporary, "state"));
  let watchdog, finish, sends = 0;
  const prompts = [];
  let session = {
    sessionId: id, sessionManager: { getCwd: () => temporary },
    model: { provider: "mock", id: "offline" },
    abort: async () => finish.resolve(),
  };
  const sessions = {
    getSession: async () => session,
    currentSession: async () => id,
    loadHistory: async () => id === originalId ? [] : [{ role: "assistant", text: "已在新对话继续并完成任务。" }],
    getSessionInfo: async () => ({ sessionId: id, workspaceDir: temporary, contextUsage: null }),
    listSessions: async () => [{ id, title: "看门狗离线验证", workspaceDir: temporary, updatedAt: 1 }],
    listUnsentSessions: async () => [],
    listModels: async () => ({ provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "离线模型" }] }),
    listSlashCommands: async () => [],
    continueInNewSession: async () => {
      id = "watchdog-next";
      session = { ...session, sessionId: id };
      return session;
    },
  };
  const chat = createChatService(sessions, async () => async (_session, text, onText) => {
    sends++;
    prompts.push(text);
    if (sends === 3) throw new Error("maximum context length exceeded");
    if (sends > 1) {
      onText("看门狗已自动继续并完成任务。");
      return;
    }
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
  async function submit(text) {
    await js(`document.getElementById('message-input').value=${JSON.stringify(text)};document.getElementById('message-input').dispatchEvent(new Event('input'));`);
    await until("!document.getElementById('send-button').disabled || !document.getElementById('stop-button').disabled");
    await js("document.getElementById('message-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
  }
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
    await submit("启动看门狗");
    await until("document.getElementById('request-status').textContent.includes('看门狗已启动') && !document.getElementById('new-chat-button').disabled");
    assert.equal(sends, 0);
    assert.equal((await store.load(id)).watchdogEnabled, true);
    await submit("继续处理我的任务");
    await until("document.getElementById('messages').textContent.includes('已保留本轮完成的内容')");
    assert.equal(chat.isBusy(), true);
    await submit("关闭看门狗");
    await until("document.getElementById('request-status').textContent.includes('自动恢复已关闭')");
    assert.equal((await store.load(id)).watchdogEnabled, false);
    await submit("启动看门狗");
    await until("document.getElementById('request-status').textContent.includes('将自动恢复当前任务')");
    assert.equal((await store.load(id)).watchdogEnabled, true);
    // 仅注入十分钟到期信号；真实计时阈值由单元测试推进时钟验证。
    watchdog.onTimeout();
    await until("!document.getElementById('new-chat-button').disabled");
    assert.equal(chat.isBusy(), false);
    assert.equal(sends, 2);
    assert.match(prompts[1], /继续当前尚未完成的任务/);
    assert.match(await js("document.getElementById('messages').textContent"), /已保留本轮完成的内容.*自动继续并完成任务/s);
    assert.match(await js("document.getElementById('request-status').textContent"), /自动恢复 1 次/);
    assert.equal((await store.load(id)).pendingSend, null);
    assert.equal(await js("document.getElementById('message-input').value"), "");
    await submit("执行下一批任务");
    await until("document.getElementById('messages').textContent.includes('已在新对话继续并完成任务') && !document.getElementById('new-chat-button').disabled");
    assert.equal(sends, 4);
    assert.equal(id, "watchdog-next");
    assert.match(prompts[3], /自动交接.*执行下一批任务/s);
    assert.equal((await store.load(originalId)).pendingSend, null);
    assert.equal((await store.load(id)).watchdogEnabled, true);
    if (process.env.WATCHDOG_SCREENSHOT_PATH) {
      await fs.writeFile(process.env.WATCHDOG_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    console.log("通过：用户指令开关看门狗；运行中立即控制；无进展自动继续；上下文超限后切换新对话继续，输入和快照正确收尾。");
  } finally {
    win.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

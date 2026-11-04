const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);

const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-session-readiness-"));
app.setPath("userData", temporary);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");
let current = "first", reads = new Map(), draftGate, newGate, failInfo = false;
const drafts = new Map();
function read(name, value) {
  const gate = Promise.withResolvers();
  reads.set(name, gate);
  return gate.promise.then(() => value);
}
const session = {
  loadHistory: async () => [],
  currentSession: async () => current,
  listModels: () => read("models", { provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "离线模型" }] }),
  getSessionInfo: async () => {
    await read("info");
    if (failInfo) throw new Error("隔离检查：信息读取失败");
    return { sessionId: current, workspaceDir: "/fixture", provider: "mock", modelId: "offline", contextUsage: null };
  },
  listSessions: () => read("sessions", []),
  listUnsentSessions: () => read("unsent", []),
  newChat: async () => { await newGate.promise; current = "second"; return current; },
  listSlashCommands: async () => [],
};
registerAgentIpc(ipcMain, session, { isBusy: () => false, listProposals: () => read("proposals", []) }, {}, {}, {}, {},
  { listProjects: async () => [] }, {
    loadCurrentDraft: async () => {
      await draftGate?.promise;
      return drafts.get(current) ?? { sessionId: current, text: "", revision: 0 };
    },
    saveDraft: async (sessionId, text, revision) => {
      const saved = { sessionId, text, revision: revision + 1 };
      drafts.set(sessionId, saved);
      return saved;
    },
    inspectSend: async () => ({ ...(drafts.get(current) ?? { sessionId: current, text: "", revision: 0 }), pendingSend: null }),
  }, {});

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1100, height: 800, show: false,
    webPreferences: { preload: path.join(root, "src/preload/preload.js"), contextIsolation: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
  const js = source => win.webContents.executeJavaScript(source);
  async function until(check, label) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await js("new Promise(resolve => setTimeout(resolve, 10))");
    }
    throw new Error(`等待失败：${label}，已开始读取 ${[...reads.keys()].join("、")}`);
  }
  const disabled = () => js("document.getElementById('send-button').disabled");
  const idle = () => until(() => js("!document.getElementById('new-chat-button').disabled"), "页面就绪");
  const release = name => { assert.ok(reads.has(name), name); reads.get(name).resolve(); };
  try {
    await win.loadFile(path.join(root, "src/renderer/index.html"));
    // 不依赖具体机器耗时：每个读取保持阻塞，确认其他独立读取已经发出。
    await until(() => ["models", "info", "sessions", "proposals"].every(name => reads.has(name)), "启动读取应并行");
    assert.equal(await disabled(), true);
    assert.equal(reads.has("unsent"), false, "草稿列表须等待文件草稿读取释放互斥入口");
    release("proposals");
    await until(() => reads.has("unsent"), "读取空会话列表");
    for (const name of ["models", "info", "sessions", "unsent"]) release(name);
    await idle();

    await js("document.getElementById('message-input').value='原会话输入';document.getElementById('message-input').dispatchEvent(new Event('input'));");
    await until(() => drafts.get("first")?.text === "原会话输入", "原输入已保存");
    reads = new Map();
    newGate = Promise.withResolvers();
    draftGate = Promise.withResolvers();
    await js("document.getElementById('new-chat-button').click()");
    assert.equal(await disabled(), true);
    assert.equal(reads.size, 0, "新会话完成前不读取新状态");
    newGate.resolve();
    await until(() => current === "second", "主进程已切换");
    assert.equal(reads.size, 0, "输入归属确认前不读取展示信息");
    draftGate.resolve();
    await until(() => ["models", "info", "unsent"].every(name => reads.has(name)), "新建后的读取应并行");
    // 新对话在输入绑定后即可使用；辅助读取仍在后台进行。
    assert.equal(await disabled(), false, "辅助读取不阻塞新对话");
    assert.equal(await js("document.getElementById('request-status').textContent"), "就绪");
    failInfo = true;
    for (const name of ["models", "info", "unsent"]) release(name);
    await until(() => js("document.body.textContent.includes('信息读取失败')"), "信息失败展示");
    await idle();
    assert.equal(await js("document.getElementById('message-input').value"), "");
    assert.equal(drafts.get("first").text, "原会话输入");
    assert.match(await js("document.body.textContent"), /信息读取失败/);
    await js("document.getElementById('message-input').value='新会话输入';document.getElementById('message-input').dispatchEvent(new Event('input'));");
    await until(() => drafts.get("second")?.text === "新会话输入", "新输入保存到新会话");
    assert.equal(await disabled(), false, "独立信息读取失败不锁住发送");
    assert.equal(drafts.get("first").text, "原会话输入");
    console.log("通过：启动与新建读取并行；互斥读取顺序正确；准备期间禁止发送；输入按会话隔离；信息失败后恢复交互。");
  } finally {
    win.destroy();
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

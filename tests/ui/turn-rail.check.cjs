const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const { toHistory } = require("../../src/main/adapters/message-adapter.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);

const temporary = mkdtempSync(path.join(os.tmpdir(), "turn-rail-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");

function makeHistory(tag) {
  const messages = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    messages.push({ role: "user", content: [{ type: "text", text: `${tag} 第 ${turn} 轮` }] });
    messages.push({
      role: "assistant", provider: "mock", model: "offline", stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2 }, durationMs: 5,
      content: [{ type: "text", text: `回复 ${tag} ${turn}\n\n${"内容行\n".repeat(120)}` }],
    });
  }
  return toHistory(messages);
}

const sessions = [
  { id: "a", title: "会话 A", workspaceDir: "/demo", updatedAt: 2 },
  { id: "b", title: "会话 B", workspaceDir: "/demo", updatedAt: 1 },
];
const histories = { a: makeHistory("A"), b: makeHistory("B") };
let current = "a";
const drafts = new Map();
const draft = (id) => drafts.get(id) ?? { sessionId: id, text: "", revision: 0 };

const session = {
  loadHistory: async () => histories[current],
  currentSession: async () => current,
  getSessionInfo: async () => ({ sessionId: current, workspaceDir: "/demo", provider: "mock", modelId: "offline", contextUsage: null }),
  listSessions: async () => sessions,
  listUnsentSessions: async () => [],
  listModels: async () => ({ provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "offline" }] }),
  newChat: async () => { current = "a"; return current; },
  previewSession: async () => ({ title: "会话 A", history: histories.a }),
  listSlashCommands: async () => [],
  openSession: async (id) => { current = id; return histories[id]; },
};
const composer = {
  loadCurrentDraft: async (id) => ({ ...(draft(id ?? current)) }),
  saveDraft: async (id, text, revision) => {
    const value = { sessionId: id, text, revision: revision + 1 };
    drafts.set(id, value);
    return value;
  },
  inspectSend: async (id) => ({ ...(draft(id ?? current)), pendingSend: null }),
};
const chat = { isBusy: () => false, listProposals: async () => [], send: async () => ({ outcome: "completed" }), stop: async () => {} };
registerAgentIpc(ipcMain, session, chat, {}, {}, {}, {}, { listProjects: async () => [] }, composer, {});

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1200, height: 860, show: false,
    webPreferences: {
      preload: path.join(root, "src/preload/preload.js"),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  const js = (source) => win.webContents.executeJavaScript(source);
  const until = (expression) => js(`(async()=>{for(let i=0;i<500;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
  const idle = () => until("!document.getElementById('new-chat-button').disabled");

  try {
    await win.loadFile(path.join(root, "src/renderer/index.html"));
    await idle();
    await until("document.querySelectorAll('.session-open').length>=2");
    await until("!document.getElementById('turn-rail').hidden && document.querySelectorAll('.turn-rail__mark').length===3");
    assert.equal(await js("document.querySelector('.turn-rail__mark').getAttribute('aria-label')"), "第 1 轮：A 第 1 轮");
    console.log("通过：历史渲染后按用户消息生成轮次标记");

    // 滚到底部时高亮最后一轮，点击第一条回到首轮。
    await js("document.getElementById('messages').scrollTop=document.getElementById('messages').scrollHeight");
    await js("new Promise(r=>setTimeout(r,120))");
    assert.equal(await js("document.querySelector('.turn-rail__mark[aria-current=\"true\"]').dataset.index"), "2");
    await js("document.querySelector('.turn-rail__mark').click()");
    await until("document.getElementById('messages').scrollTop<40");
    await js("new Promise(r=>setTimeout(r,150))");
    assert.equal(await js("document.querySelector('.turn-rail__mark[aria-current=\"true\"]').dataset.index"), "0");
    console.log("通过：滚动高亮当前轮，点击标记跳转到对应轮次");

    // 阅读位置：滚到中部，切到另一会话再切回，位置恢复。
    await js("document.getElementById('messages').scrollTop=600");
    await js("new Promise(r=>setTimeout(r,120))");
    const saved = Number(await js("document.getElementById('messages').scrollTop"));
    await js("[...document.querySelectorAll('.session-open')].find(button=>button.textContent.includes('会话 B')).click()");
    await until("document.getElementById('messages').textContent.includes('B 第 1 轮')");
    await idle();
    await js("[...document.querySelectorAll('.session-open')].find(button=>button.textContent.includes('会话 A')).click()");
    await until("document.getElementById('messages').textContent.includes('A 第 1 轮')");
    await idle();
    await js("new Promise(r=>setTimeout(r,250))");
    const restored = Number(await js("document.getElementById('messages').scrollTop"));
    assert.ok(Math.abs(restored - saved) <= 2, `阅读位置未恢复：保存 ${saved}，恢复 ${restored}`);
    console.log("通过：切换会话后恢复阅读位置");

    if (process.env.TURN_RAIL_SCREENSHOT_PATH) {
      await js("new Promise(r=>setTimeout(r,200))");
      require("node:fs").writeFileSync(process.env.TURN_RAIL_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    assert.deepEqual(errors, []);
  } finally {
    win.destroy();
  }
}

const timeout = setTimeout(() => { console.error("轮次导航检查超时"); app.exit(1); }, 90000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch((error) => { clearTimeout(timeout); console.error(error); app.exit(1); });

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);

const temporary = mkdtempSync(path.join(os.tmpdir(), "turn-changes-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");

const summaryCalls = [];
const diffCalls = [];
const changes = {
  summary(requestId) {
    summaryCalls.push(requestId);
    return {
      requestId,
      files: [
        { index: 0, display: "src/a.js", added: 2, deleted: 1, binary: false, oversized: false },
        { index: 1, display: "assets/logo.png", added: 0, deleted: 0, binary: true, oversized: false },
      ],
      total: 2,
      truncated: false,
    };
  },
  async diff(requestId, index) {
    diffCalls.push([requestId, index]);
    if (index === 1) {
      return { display: "assets/logo.png", kind: "binary", binary: true, added: 0, deleted: 0, oversized: false };
    }
    return {
      display: "src/a.js",
      kind: "text",
      added: 2,
      deleted: 1,
      hunks: [{
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        rows: [
          { kind: "equal", oldLine: 1, newLine: 1, text: "one" },
          { kind: "remove", oldLine: 2, newLine: null, text: "two" },
          { kind: "add", oldLine: null, newLine: 2, text: "TWO" },
          { kind: "equal", oldLine: 3, newLine: 3, text: "three" },
          { kind: "add", oldLine: null, newLine: 4, text: "four" },
        ],
      }],
      coarse: false,
      truncated: false,
    };
  },
};

let current = "a";
let serial = 0;
const drafts = new Map();
const draft = (id) => drafts.get(id) ?? { sessionId: id, text: "", revision: 0 };
const sessions = [{ id: "a", title: "改动验收", workspaceDir: "/demo", updatedAt: 1 }];

const session = {
  loadHistory: async () => [],
  currentSession: async () => current,
  getSessionInfo: async () => ({ sessionId: current, workspaceDir: "/demo", provider: "mock", modelId: "offline", contextUsage: null }),
  listSessions: async () => sessions,
  listUnsentSessions: async () => [],
  listModels: async () => ({ provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "offline" }] }),
  newChat: async () => current,
  previewSession: async () => ({ title: "改动验收", history: [] }),
  listSlashCommands: async () => [],
  openSession: async () => [],
};
const composer = {
  loadCurrentDraft: async () => ({ ...draft(current) }),
  saveDraft: async (id, text, revision) => {
    const value = { sessionId: id, text, revision: revision + 1 };
    drafts.set(id, value);
    return value;
  },
  inspectSend: async () => ({ ...draft(current), pendingSend: null }),
};
const chat = {
  isBusy: () => false,
  listProposals: async () => [],
  async send(_text, _onText, _onTool, _status, request, ack) {
    serial += 1;
    const consumed = { sessionId: current, text: "", revision: request.revision + 1, sendId: "send" };
    drafts.set(current, consumed);
    ack(consumed);
    return { outcome: "completed", draft: consumed, changesRequestId: `wc-ui-${serial}` };
  },
  stop: async () => {},
};
const projectService = {
  listProjects: async () => [],
  listProjectEnvironments: async () => [],
  listTestData: async () => [],
  listTestReports: async () => [],
};
const permissionOptions = [
  { id: "ask", label: "每次确认" },
  { id: "read-only", label: "只读" },
  { id: "full-access", label: "完全权限" },
];
const permissionService = {
  settings: async () => ({ mode: "ask", scope: "session", defaultMode: "ask", options: permissionOptions }),
  save: async () => ({ mode: "ask", scope: "session", defaultMode: "ask", options: permissionOptions }),
};
registerAgentIpc(ipcMain, session, chat, {}, {}, {}, {}, projectService, composer, {}, {}, permissionService, changes);

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(root, "src/preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  const js = (source) => win.webContents.executeJavaScript(source);
  const until = (expression) => js(`(async()=>{for(let i=0;i<500;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
  const idle = () => until("!document.getElementById('new-chat-button').disabled");

  async function send(text) {
    await js(`document.getElementById('message-input').value=${JSON.stringify(text)};document.getElementById('message-input').dispatchEvent(new Event('input'))`);
    await until("!document.getElementById('send-button').disabled");
    await js("document.getElementById('message-form').requestSubmit()");
    await idle();
  }

  try {
    await win.loadFile(path.join(root, "src/renderer/index.html"));
    await idle();

    // 默认开启：发送结束后显示本轮改动。
    await send("改一下 a.js");
    await until("document.querySelector('.turn-changes')");
    assert.equal(await js("document.querySelectorAll('.turn-changes').length"), 1);
    assert.match(await js("document.querySelector('.turn-changes').textContent"), /本轮改动/);
    assert.match(await js("document.querySelector('.turn-changes').textContent"), /2 个文件/);
    assert.match(await js("document.querySelector('.turn-changes').textContent"), /\+2 −1/);
    assert.equal(await js("document.querySelectorAll('.turn-changes__file').length"), 2);
    assert.match(await js("document.querySelector('.turn-changes__file .turn-changes__path').textContent"), /^src\/a\.js$/);
    assert.match(await js("document.querySelector('.turn-changes__file .turn-changes__stat').textContent"), /^\+2 −1$/);
    console.log("通过：轮末显示改动文件、统计与二进制标记");
    if (process.env.TURN_CHANGES_SCREENSHOT_PATH) {
      await js("document.querySelector('.turn-changes').scrollIntoView({block:'center'})");
      await js("new Promise(r=>setTimeout(r,250))");
      await fs.writeFile(process.env.TURN_CHANGES_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    // 点击文件进入右侧栏差异审阅。
    await js("document.querySelector('.turn-changes__file').click()");
    await until("document.getElementById('app-right-sidebar').hasAttribute('data-open') && document.querySelector('.change-diff')");
    assert.match(await js("document.querySelector('.right-panel__nav-title').textContent"), /^src\/a\.js$/);
    assert.deepEqual(diffCalls, [["wc-ui-1", 0]]);
    assert.equal(await js("document.querySelectorAll('.change-row[data-kind=\"add\"]').length"), 2);
    assert.equal(await js("document.querySelectorAll('.change-row[data-kind=\"remove\"]').length"), 1);
    assert.match(await js("document.querySelector('.change-row[data-kind=\"remove\"] .change-row__text').textContent"), /^two$/);
    console.log("通过：右侧栏按文件展示逐行差异");
    if (process.env.TURN_CHANGES_DIFF_SCREENSHOT_PATH) {
      await js("new Promise(r=>setTimeout(r,250))");
      await fs.writeFile(process.env.TURN_CHANGES_DIFF_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    // 返回文件列表并查看二进制提示。
    await js("document.querySelector('.right-panel__nav button').click()");
    await until("document.querySelector('.change-list')");
    assert.equal(await js("document.querySelectorAll('.change-file').length"), 2);
    await js("document.querySelectorAll('.change-file')[1].click()");
    await until("document.querySelector('.change-note')");
    assert.match(await js("document.querySelector('.change-note').textContent"), /二进制文件/);

    // 关闭偏好：已有卡片立即隐藏，新请求不再读取摘要。
    await js("(()=>{const box=document.querySelector('[data-code-work-view]');box.checked=false;box.dispatchEvent(new Event('change'));})()");
    await until("document.querySelector('.turn-changes').hidden === true");
    const summaryBefore = summaryCalls.length;
    await send("再改一次");
    await js("new Promise(r=>setTimeout(r,120))");
    assert.equal(await js("document.querySelectorAll('.turn-changes').length"), 1);
    assert.equal(summaryCalls.length, summaryBefore);
    assert.equal(await js("localStorage.getItem('agent-client:code-work-view')"), "off");
    console.log("通过：关闭后隐藏已有卡片且不再请求摘要");

    // 重新开启后只影响新请求。
    await js("(()=>{const box=document.querySelector('[data-code-work-view]');box.checked=true;box.dispatchEvent(new Event('change'));})()");
    await send("继续改");
    await until("document.querySelectorAll('.turn-changes').length === 2");
    assert.match(await js("[...document.querySelectorAll('.turn-changes')].at(-1).textContent"), /本轮改动/);
    console.log("通过：重新开启后新请求恢复改动卡片");

    // 设置行文案与开关位置。
    assert.match(await js("document.querySelector('[data-code-work-view]').closest('.settings-row').textContent"), /代码工作视图/);
    assert.match(await js("document.querySelector('[data-code-work-view]').closest('.settings-row').textContent"), /每轮回复后显示本轮改动/);
    await js("document.getElementById('model-settings-button').click()");
    await js("document.getElementById('settings-general-tab').click()");
    await js("new Promise(r=>setTimeout(r,250))");
    assert.equal(await js("document.querySelector('[data-code-work-view]').checked"), true);
    if (process.env.TURN_CHANGES_SETTINGS_SCREENSHOT_PATH) {
      await fs.writeFile(process.env.TURN_CHANGES_SETTINGS_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await js("document.getElementById('model-settings-dialog').close()");

    assert.deepEqual(errors, []);
    console.log("通过：代码工作视图开关、轮末卡片与右侧栏差异");
  } finally {
    win.destroy();
  }
}

const timeout = setTimeout(() => { console.error("改动视图检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});

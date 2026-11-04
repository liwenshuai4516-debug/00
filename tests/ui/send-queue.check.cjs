const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);

const temporary = mkdtempSync(path.join(os.tmpdir(), "send-queue-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");
const sessionId = "q1";
const drafts = new Map();
const sent = [];
let busy = false;
let gate;
let stopCalls = 0;
const draft = () => drafts.get(sessionId) ?? { sessionId, text: "", revision: 0 };
const assistant = (content) => ({
  role: "assistant", content, provider: "mock", model: "offline", stopReason: "stop",
  usage: { input: 1, output: 1, totalTokens: 2 }, durationMs: 5,
});

const session = {
  loadHistory: async () => [],
  currentSession: async () => sessionId,
  getSessionInfo: async () => ({ sessionId, workspaceDir: "/demo", provider: "mock", modelId: "offline", contextUsage: null }),
  listSessions: async () => [{ id: sessionId, title: "待发送队列", workspaceDir: "/demo", updatedAt: 1 }],
  listUnsentSessions: async () => [],
  listModels: async () => ({ provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "offline" }] }),
  newChat: async () => sessionId,
  previewSession: async () => ({ title: "待发送队列", history: [] }),
  listSlashCommands: async () => [],
};
const composer = {
  loadCurrentDraft: async () => ({ ...draft() }),
  saveDraft: async (id, text, revision) => {
    const value = { sessionId: id, text, revision: revision + 1 };
    drafts.set(id, value);
    return value;
  },
  inspectSend: async () => ({ ...draft(), pendingSend: null }),
};
const chat = {
  isBusy: () => busy,
  listProposals: async () => [],
  async send(text, onText, onTool, _status, request, ack, onOutput) {
    sent.push(text);
    busy = true;
    const consumed = { sessionId, text: "", revision: request.revision + 1, sendId: `send-${sent.length}` };
    drafts.set(sessionId, consumed);
    ack(consumed);
    const emit = (event) => onOutput({ requestSessionId: sessionId, sessionId, ...event });
    const message = assistant([{ type: "text", text: `回复 ${sent.length}` }]);
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({ type: "message_start", message: assistant([]) });
    if (sent.length === 1 || sent.length === 3) {
      gate = Promise.withResolvers();
      await gate.promise;
    } else {
      // 模拟真实流式延迟：事件先于 invoke 回复到达页面。
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    emit({ type: "message_end", message });
    emit({ type: "turn_end", message });
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled", aborted: false });
    busy = false;
    return { outcome: "completed", draft: consumed };
  },
  stop: async () => {
    stopCalls += 1;
    gate?.resolve();
  },
};
registerAgentIpc(ipcMain, session, chat, {}, {}, {}, {}, { listProjects: async () => [] }, composer, {});

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1024, height: 800, show: false,
    webPreferences: {
      preload: path.join(root, "src/preload/preload.js"),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  const js = (source) => win.webContents.executeJavaScript(source);
  const until = (expression) => js(`(async()=>{for(let i=0;i<400;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
  const idle = () => until("!document.getElementById('new-chat-button').disabled");
  const type = (text) => js(`document.getElementById('message-input').value=${JSON.stringify(text)};document.getElementById('message-input').dispatchEvent(new Event('input'));`);
  const submit = () => js(`document.getElementById('message-form').requestSubmit()`);

  try {
    await win.loadFile(path.join(root, "src/renderer/index.html"));
    await idle();

    await type("第一条");
    await until("!document.getElementById('send-button').disabled");
    await submit();
    await until("!document.getElementById('stop-button').disabled");

    // 生成中提交第二条与第三条：进入待发送队列，输入框清空，不打断当前请求。
    await type("第二条");
    await submit();
    await type("第三条");
    await submit();
    await until("document.querySelectorAll('.send-queue__item').length===2");
    assert.equal(await js("document.querySelectorAll('.send-queue__text')[0].textContent"), "第二条");
    assert.equal(await js("document.getElementById('message-input').value"), "");
    assert.equal(sent.length, 1);
    console.log("通过：生成中提交进入待发送队列，输入框清空且不打断当前请求");

    // 移除第二条之外的一项，再把剩余项编辑回输入框并重新排队。
    await js("document.querySelectorAll('.send-queue__action')[3].click()");
    await until("document.querySelectorAll('.send-queue__item').length===1");
    assert.equal(await js("document.querySelector('.send-queue__text').textContent"), "第二条");
    await js("document.querySelector('.send-queue__action').click()");
    await until("document.getElementById('send-queue').hidden");
    assert.equal(await js("document.getElementById('message-input').value"), "第二条");
    await submit();
    await until("!document.getElementById('send-queue').hidden");
    console.log("通过：待发送项可移除，编辑后回到输入框并重新排队");

    // 第一条结束后自动发送队列中的第二条。
    gate.resolve();
    for (let i = 0; i < 400 && sent.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent, ["第一条", "第二条"]);
    await until("document.getElementById('send-queue').hidden");
    await idle();
    // 两条消息各自一个处理过程。
    assert.equal(await js("document.querySelectorAll('.output-run').length"), 2);
    assert.match(await js("document.getElementById('messages').textContent"), /回复 2/);
    console.log("通过：本轮结束后按顺序自动发送队列内容");

    // 连按两次 Esc 停止生成；单次 Esc 和组词中的 Esc 不计入。
    await type("停止测试");
    await until("!document.getElementById('send-button').disabled");
    await submit();
    await until("!document.getElementById('stop-button').disabled");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(stopCalls, 0, "单次 Esc 不应停止");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true}))");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    for (let i = 0; i < 200 && stopCalls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopCalls, 1, "连续两次 Esc 应调用一次停止");
    await idle();
    console.log("通过：连按两次 Esc 停止生成，单次与组词中的 Esc 不触发");

    assert.deepEqual(errors, []);
  } finally {
    win.destroy();
  }
}

const timeout = setTimeout(() => { console.error("待发送队列检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch((error) => { clearTimeout(timeout); console.error(error); app.exit(1); });

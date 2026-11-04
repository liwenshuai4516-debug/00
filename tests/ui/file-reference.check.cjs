const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);

const temporary = mkdtempSync(path.join(os.tmpdir(), "file-reference-ui-"));
const workspace = path.join(temporary, "workspace");
mkdirSync(path.join(temporary, "user-data"));
mkdirSync(path.join(workspace, "docs", "cases"), { recursive: true });
mkdirSync(path.join(workspace, "src"), { recursive: true });
mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
writeFileSync(path.join(workspace, "docs", "需求评审.md"), "# 需求评审\n");
writeFileSync(path.join(workspace, "docs", "cases", "a.spec.cjs"), "module.exports = {};\n");
writeFileSync(path.join(workspace, "src", "app.js"), "export const app = 1;\n");
writeFileSync(path.join(workspace, ".env"), "SECRET=1\n");
writeFileSync(path.join(workspace, "node_modules", "x.js"), "x\n");

app.setPath("userData", path.join(temporary, "user-data"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");
const sessionId = "f1";
const drafts = new Map();
const draft = () => drafts.get(sessionId) ?? { sessionId, text: "", revision: 0 };

const session = {
  loadHistory: async () => [],
  currentSession: async () => sessionId,
  getSessionInfo: async () => ({ sessionId, workspaceDir: workspace, provider: "mock", modelId: "offline", contextUsage: null }),
  listSessions: async () => [{ id: sessionId, title: "文件引用", workspaceDir: workspace, updatedAt: 1 }],
  listUnsentSessions: async () => [],
  listModels: async () => ({ provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "offline" }] }),
  newChat: async () => sessionId,
  previewSession: async () => ({ title: "文件引用", history: [] }),
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
const chat = { isBusy: () => false, listProposals: async () => [], send: async () => ({ outcome: "completed" }), stop: async () => {} };
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
  const type = (text) => js(`(() => { const input=document.getElementById('message-input'); input.value=${JSON.stringify(text)}; input.setSelectionRange(input.value.length,input.value.length); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const key = (name) => js(`document.getElementById('message-input').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true,cancelable:true}))`);

  try {
    await win.loadFile(path.join(root, "src/renderer/index.html"));
    await idle();

    await type("@");
    await until("!document.getElementById('file-reference-menu').hidden");
    const paths = await js("[...document.querySelectorAll('.file-reference-path')].map(node=>node.textContent)");
    assert.ok(paths.includes("docs/需求评审.md"), "应列出 Markdown 文档");
    assert.ok(paths.includes("src/app.js"), "应列出源码文件");
    assert.ok(paths.includes("docs/"), "应列出目录并带斜杠");
    assert.ok(!paths.some((item) => item.includes(".env") || item.includes("node_modules")), "不应列出凭据与工程目录");
    console.log("通过：输入 @ 列出工作目录文件，跳过凭据与工程目录");

    await type("@app");
    await until("document.querySelectorAll('.file-reference-item').length===1");
    assert.equal(await js("document.querySelector('.file-reference-path').textContent"), "src/app.js");
    await key("Enter");
    await until("document.getElementById('file-reference-menu').hidden");
    assert.equal(await js("document.getElementById('message-input').value"), "@src/app.js ");
    console.log("通过：按名称过滤后回车插入相对路径并关闭菜单");

    await type("@docs");
    await until("document.querySelector('.file-reference-item[data-type=\"dir\"]')!==null");
    assert.equal(await js("document.querySelector('.file-reference-item[data-type=\"dir\"] .file-reference-path').textContent"), "docs/");
    await key("Enter");
    await until("document.getElementById('file-reference-menu').hidden");
    assert.equal(await js("document.getElementById('message-input').value"), "@docs/ ");
    console.log("通过：目录带徽标展示并以斜杠结尾插入");

    await type("@");
    await until("!document.getElementById('file-reference-menu').hidden");
    await key("ArrowDown");
    assert.match(await js("document.getElementById('file-reference-menu').querySelector('.is-active').id"), /^file-reference-option-/);
    await key("Escape");
    await until("document.getElementById('file-reference-menu').hidden");
    assert.equal(await js("document.getElementById('message-input').value"), "@");
    console.log("通过：方向键切换高亮，Esc 关闭菜单且不改写输入");

    assert.deepEqual(errors, []);
  } finally {
    win.destroy();
  }
}

const timeout = setTimeout(() => { console.error("文件引用检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch((error) => { clearTimeout(timeout); console.error(error); app.exit(1); });

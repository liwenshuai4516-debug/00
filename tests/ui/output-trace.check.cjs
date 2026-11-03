const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const { toHistory } = require("../../src/main/adapters/message-adapter.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);

const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-output-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");
const skill = { name: "demo", path: "/demo/.pi/skills/demo/SKILL.md", source: "read" };
const drafts = new Map();
let current = "a", busy = false, history = [], gate, phase = "", mode = "normal";
const draft = () => drafts.get(current) ?? { sessionId: current, text: "", revision: 0 };
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, provider: "mock", model: "offline", stopReason,
  usage: { input: 20, output: 10, totalTokens: 30 }, durationMs: 42 });
const call = (id, file) => ({ type: "toolCall", id, name: "read", arguments: { path: file } });
const first = assistant([{ type: "thinking", thinking: "先核对 <img src=x onerror=alert(1)> 技能指令。" },
  { type: "text", text: "先读取技能与参考资料。" }, call("c1", skill.path), call("c2", "missing.txt")], "toolUse");
const final = assistant([{ type: "text", text: "**检查完成**\n\n```js\nconst ok = true;\n```" }]);
const toolResult = (id, isError, text) => ({ role: "toolResult", toolCallId: id, toolName: "read", isError,
  content: [{ type: "text", text }], durationMs: 5 });
const session = {
  loadHistory: async () => history, currentSession: async () => current,
  getSessionInfo: async () => ({ sessionId: current, workspaceDir: "/demo", provider: "mock", modelId: "offline", contextUsage: null }),
  listSessions: async () => [{ id: current, title: "输出过程离线验收", workspaceDir: "/demo", updatedAt: 1 }],
  listUnsentSessions: async () => [], listModels: async () => ({ provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "offline" }] }),
  newChat: async () => { current = current === "a" ? "b" : "a"; history = []; return current; },
  previewSession: async () => ({ title: "输出过程离线验收", history }),
  listSlashCommands: async () => [],
};
const composer = {
  loadCurrentDraft: async () => ({ ...draft() }),
  saveDraft: async (id, text, revision) => { const value = { sessionId: id, text, revision: revision + 1 }; drafts.set(id, value); return value; },
  inspectSend: async () => ({ ...draft(), pendingSend: null }),
};
const chat = {
  isBusy: () => busy, listProposals: async () => [],
  async send(text, onText, onTool, _status, request, ack, onOutput) {
    busy = true;
    const consumed = { sessionId: current, text: "", revision: request.revision + 1, sendId: "send" };
    drafts.set(current, consumed); ack(consumed);
    const emit = event => onOutput({ requestSessionId: current, sessionId: current, ...event });
    // 混入其他请求事件，检查页面按请求归属过滤。
    onOutput({ requestSessionId: "other", sessionId: "other", type: "turn_start" });
    emit({ type: "agent_start" }); emit({ type: "turn_start" });
    emit({ type: "message_start", message: assistant([]) });
    emit({ type: "message_end", message: { role: "user", skill: { ...skill, source: "explicit" } } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "临时思考" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: first.content[0].thinking } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "临时正文" } });
    onText("临时正文");
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "结束块正文" } });
    for (const [index, block] of first.content.entries()) {
      if (block.type !== "toolCall") continue;
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: index, id: block.id, toolName: block.name } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments) } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall: block } });
    }
    emit({ type: "message_end", message: first });
    for (const block of first.content.filter(block => block.type === "toolCall")) {
      emit({ type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments, skill: block.id === "c1" ? skill : undefined });
      onTool({ type: "start", toolCallId: block.id, name: block.name });
    }
    emit({ type: "tool_execution_start", toolCallId: "child", parentToolCallId: "c1", toolName: "bash", args: { command: "echo demo" } });
    emit({ type: "tool_execution_update", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "读取进度 50%" }] } });
    phase = "streaming"; gate = Promise.withResolvers(); await gate.promise;
    if (mode === "missing") { busy = false; return { outcome: "completed", draft: consumed }; }
    emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", isError: true, durationMs: 3, result: { content: [{ type: "text", text: "文件不存在" }] } });
    emit({ type: "tool_execution_end", toolCallId: "child", parentToolCallId: "c1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "demo" }] } });
    emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false, durationMs: 5, result: { content: [{ type: "text", text: "技能指令 <img src=x>" }] } });
    onTool({ type: "end", toolCallId: "c1", name: "read", text: "旧通道重复结果" });
    emit({ type: "turn_end", message: first });
    if (mode === "stop") {
      emit({ type: "agent_end", willRetry: false }); emit({ type: "agent_settled", aborted: true });
      busy = false; return { outcome: "completed", stopped: true, draft: consumed };
    }
    emit({ type: "agent_end", willRetry: true });
    phase = "retry"; gate = Promise.withResolvers(); await gate.promise;
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
    emit({ type: "turn_start" }); emit({ type: "message_start", message: assistant([]) });
    emit({ type: "message_end", message: final }); emit({ type: "turn_end", message: final });
    emit({ type: "auto_retry_end", success: true }); emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled", aborted: false });
    history = toHistory([{ role: "user", content: text }, first, toolResult("c2", true, "文件不存在"), toolResult("c1", false, "技能指令"), final],
      { includeTrace: true, skills: [{ name: "demo", filePath: skill.path }], cwd: "/demo" });
    history[3].output.nestedCalls = { complete: false, calls: [{ id: "child", name: "bash", status: "unfinished" }] };
    busy = false; return { outcome: "completed", draft: consumed };
  },
  stop: async () => gate.resolve(),
};
registerAgentIpc(ipcMain, session, chat, {}, {}, {}, {}, { listProjects: async () => [] }, composer, {});

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1120, height: 860, show: false,
    webPreferences: { preload: path.join(root, "src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
  const js = source => win.webContents.executeJavaScript(source);
  const until = expression => js(`(async()=>{for(let i=0;i<400;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败:'+${JSON.stringify(expression)});})()`);
  const idle = () => until(`!document.getElementById('new-chat-button').disabled`);
  const bodyText = () => js(`document.getElementById('messages').textContent`);
  async function send() {
    phase = "";
    await js(`document.getElementById('message-input').value='检查输出';document.getElementById('message-input').dispatchEvent(new Event('input'));`);
    await until(`!document.getElementById('send-button').disabled`);
    await js(`document.getElementById('message-form').requestSubmit()`);
    for (let i = 0; i < 100 && phase !== "streaming"; i++) await js(`new Promise(r=>setTimeout(r,10))`);
    assert.equal(phase, "streaming");
    await until(`document.querySelector('.trace-result')?.textContent.includes('50%')`);
  }
  try {
    await win.loadFile(path.join(root, "src/renderer/index.html")); await idle(); await send();
    assert.equal(await js(`document.querySelectorAll('.output-trace').length`), 1);
    assert.equal(await js(`document.querySelectorAll('.trace-tool').length`), 3);
    assert.equal(await js(`document.querySelectorAll('.trace-tool[data-tool-call-id="c1"] .trace-tool[data-tool-call-id="child"]').length`), 1);
    assert.doesNotMatch(await bodyText(), /临时正文|结束块正文|临时思考/);
    assert.match(await bodyText(), /读取技能文件|显式展开/);
    assert.equal(await js(`document.querySelectorAll('.output-run img').length`), 0);
    gate.resolve();
    for (let i = 0; i < 100 && phase !== "retry"; i++) await js(`new Promise(r=>setTimeout(r,10))`);
    assert.equal(phase, "retry");
    await until(`document.querySelector('.trace-tool[data-tool-call-id="c2"] summary').textContent.includes('执行失败')`);
    assert.doesNotMatch(await js(`document.querySelector('.output-trace>summary').textContent`), /已收尾/);
    gate.resolve(); await idle();
    assert.match(await js(`document.querySelector('.output-trace>summary').textContent`), /2 turn · 已收尾 · agent_settled/);
    assert.equal(await js(`document.querySelectorAll('.output-run [data-role="assistant"]').length`), 2);
    assert.doesNotMatch(await bodyText(), /旧通道重复结果/);
    assert.match(await bodyText(), /auto_retry_start/);
    await js(`window.copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.copied=value},configurable:true});document.querySelectorAll('.output-run .message-actions button')[1].click()`);
    await until(`window.copied.includes('**检查完成**')`);
    await js(`document.querySelectorAll('.output-trace details,.output-trace').forEach(node=>node.open=true);document.querySelector('.output-trace').scrollIntoView({block:'start'})`);
    await fs.writeFile(path.join(temporary, "trace-wide.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(680, 780); await js(`new Promise(r=>requestAnimationFrame(r))`);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`), true);
    await fs.writeFile(path.join(temporary, "trace-narrow.png"), (await win.webContents.capturePage()).toPNG());
    console.log("通过：完整页面原生流、最终快照、并行/嵌套工具、重试、Markdown复制、安全文本与窄窗");
    win.reload(); await until(`document.querySelector('.output-trace>summary')?.textContent.includes('历史恢复')`); await idle();
    assert.match(await bodyText(), /2 条响应记录 · 历史恢复/);
    assert.match(await bodyText(), /历史仅保存嵌套调用摘要/);
    assert.match(await bodyText(), /嵌套调用记录不完整/);
    assert.doesNotMatch(await bodyText(), /agent_settled/);
    console.log("通过：历史恢复保留thinking、参数、结果和嵌套摘要，不伪造实时事件");
    for (const nextMode of ["stop", "missing"]) {
      await js(`document.getElementById('new-chat-button').click()`); await idle(); mode = nextMode; await send();
      if (mode === "stop") await js(`document.getElementById('stop-button').click()`);
      else gate.resolve();
      await idle();
      assert.match(await js(`document.querySelector('.output-trace>summary').textContent`), mode === "stop" ? /已停止 · agent_settled/ : /未收到 agent_settled/);
      assert.doesNotMatch(await js(`Array.from(document.querySelectorAll('.trace-tool>summary'),node=>node.textContent).join('')`), /执行中/);
      assert.equal(await js(`document.querySelectorAll('.output-trace').length`), 1);
    }
    console.log("通过：重复发送无重复监听，停止接收收尾，缺失结束事件标记结果未确认");
    assert.deepEqual(errors, []);
    console.log(`截图：${temporary}`);
  } finally { win.destroy(); }
}
const timeout = setTimeout(() => { console.error("输出检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch(error => { clearTimeout(timeout); console.error(error); app.exit(1); });

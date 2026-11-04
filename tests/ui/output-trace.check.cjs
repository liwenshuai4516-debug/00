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
const first = assistant([{ type: "thinking", thinking: "先核对 **技能指令** 与 <img src=x onerror=alert(1)> 的安全性。\n\n第二段：确认加载结果。" },
  { type: "text", text: "先读取技能与参考资料。" }, call("c1", skill.path), call("c2", "missing.txt")], "toolUse");
const final = assistant([{ type: "text", text: "**检查完成**\n\n```js\nconst ok = true;\n```" }]);
const todoResult = { role: "toolResult", toolCallId: "todo1", toolName: "todo_write", isError: false, durationMs: 2,
  content: [{ type: "text", text: "已更新任务清单：1 待处理，1 进行中，1 已完成。" }],
  details: { todos: [{ content: "检查输出", status: "completed" }, { content: "核对技能", status: "in_progress" },
    { content: "整理结论", status: "pending" }] } };
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
    history = toHistory([{ role: "user", content: text }, first, toolResult("c2", true, "文件不存在"), toolResult("c1", false, "技能指令"), todoResult, final],
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
    assert.equal(await js(`document.querySelector('.output-trace').open`), true);
    assert.equal(await js(`document.querySelector('.output-trace').open&&document.querySelector('.trace-thinking').open`), true);
    assert.equal(await js(`document.querySelectorAll('.trace-turn').length`), 0);
    assert.doesNotMatch(await js(`document.querySelector('.trace-process').textContent`), /Turn \d|turn_end/);
    assert.match(await js(`document.querySelector('.output-trace>summary').textContent`), /正在调用 read、bash · 用时/);
    assert.equal(await js(`document.querySelectorAll('.trace-tool').length`), 3);
    // 运行事件默认折叠，内容仍保留在页面里。
    assert.equal(await js(`document.querySelector('.trace-events').open`), false);
    assert.match(await js(`document.querySelector('.trace-events>summary').textContent`), /^运行事件（\d+）$/);
    assert.equal(await js(`document.querySelectorAll('.trace-tool[data-tool-call-id="c1"] .trace-tool[data-tool-call-id="child"]').length`), 1);
    assert.doesNotMatch(await bodyText(), /临时正文|结束块正文|临时思考/);
    assert.match(await bodyText(), /读取技能文件|显式展开/);
    assert.equal(await js(`document.querySelectorAll('.output-run img').length`), 0);
    // 思考行折叠为一行预览，展开后沿用 Markdown 清理链路。
    const thinkingSummary = await js(`document.querySelector('.trace-thinking>summary').textContent`);
    assert.match(thinkingSummary, /^思考 · 先核对 技能指令/);
    assert.doesNotMatch(thinkingSummary, /\*\*/);
    assert.equal(await js(`document.querySelector('.trace-thinking strong')?.textContent`), "技能指令");
    assert.match(await js(`document.querySelector('.trace-thinking-body').textContent`), /第二段：确认加载结果/);
    await fs.writeFile(path.join(temporary, "process-live.png"), (await win.webContents.capturePage()).toPNG());
    gate.resolve();
    for (let i = 0; i < 100 && phase !== "retry"; i++) await js(`new Promise(r=>setTimeout(r,10))`);
    assert.equal(phase, "retry");
    await until(`document.querySelector('.trace-tool[data-tool-call-id="c2"] summary').textContent.includes('执行失败')`);
    assert.doesNotMatch(await js(`document.querySelector('.output-trace>summary').textContent`), /处理已结束/);
    assert.equal(await js(`document.querySelector('.output-trace').open`), true);
    gate.resolve(); await idle();
    assert.match(await js(`document.querySelector('.output-trace>summary').textContent`), /处理已结束 · 用时 .* · 3 次工具调用/);
    assert.equal(await js(`document.querySelector('.output-trace').open`), false);
    assert.equal(await js(`document.querySelectorAll('.output-trace details[open]').length`), 0);
    assert.match(await js(`document.querySelector('.trace-events-body').textContent`), /auto_retry_start/);
    assert.equal(await js(`document.querySelectorAll('.output-run>[data-role="assistant"]').length`), 1);
    assert.match(await js(`document.querySelector('.output-run>[data-role="assistant"]').textContent`), /检查完成/);
    // 最终回复下方展示 SDK 的耗时与 token，未知字段不显示为零。
    assert.match(await js(`document.querySelector('.output-run>[data-role="assistant"] .message-usage').textContent`), /^42 ms（SDK） · 30 tokens（输入 20 \/ 输出 10）$/);
    // 过程内的助手消息已有元信息行，不再重复用量页脚。
    assert.equal(await js(`document.querySelectorAll('.output-trace .message-usage:not([hidden])').length`), 0);
    assert.match(await js(`document.querySelector('.output-trace').textContent`), /先读取技能与参考资料/);
    assert.equal(await js(`document.querySelectorAll('.chat-message[data-streaming="true"]').length`), 0);
    // 工具行展示目标路径，代码块带语言标签与复制入口。
    assert.match(await js(`document.querySelector('.trace-tool[data-tool-call-id="c1"] summary').textContent`), /read · \/demo\/\.pi\/skills\/demo\/SKILL\.md · 执行完成/);
    assert.equal(await js(`document.querySelector('.trace-tool[data-tool-call-id="c1"] .trace-card')?.dataset.kind`), "read");
    assert.match(await js(`document.querySelector('.trace-tool[data-tool-call-id="c1"] .trace-card-path').textContent`), /SKILL\.md$/);
    assert.equal(await js(`document.querySelector('.trace-tool[data-tool-call-id="c1"] .trace-raw').open`), false);
    assert.equal(await js(`document.querySelectorAll('.output-run .code-block').length`), 1);
    assert.equal(await js(`document.querySelector('.code-block-language').textContent`), "js");
    assert.equal(await js(`document.querySelectorAll('.output-run [data-role="assistant"]').length`), 2);

    // 长代码块滚动时头栏吸附在消息区顶部。
    await js(`(() => {
      const host = document.createElement('div');
      host.className = 'markdown-body';
      host.id = 'sticky-code-fixture';
      const figure = document.createElement('figure');
      figure.className = 'code-block';
      const header = document.createElement('header');
      header.className = 'code-block-header';
      const language = document.createElement('span');
      language.className = 'code-block-language';
      language.textContent = 'text';
      header.append(language);
      const pre = document.createElement('pre');
      pre.textContent = Array.from({ length: 120 }, (_, index) => 'line ' + index).join(String.fromCharCode(10));
      figure.append(header, pre);
      host.append(figure);
      document.getElementById('messages').append(host);
    })()`);
    const sticky = await js(`(() => {
      const messages = document.getElementById('messages');
      const fixture = document.getElementById('sticky-code-fixture');
      const header = fixture.querySelector('.code-block-header');
      const top = fixture.getBoundingClientRect().top - messages.getBoundingClientRect().top + messages.scrollTop;
      messages.scrollTop = top + 240;
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const gap = header.getBoundingClientRect().top - messages.getBoundingClientRect().top;
        resolve(JSON.stringify({
          position: getComputedStyle(header).position,
          gap: Math.round(gap),
          opaque: getComputedStyle(header).backgroundColor !== 'rgba(0, 0, 0, 0)',
        }));
      })));
    })()`);
    const stickyState = JSON.parse(sticky);
    assert.equal(stickyState.position, "sticky");
    assert.ok(Math.abs(stickyState.gap) <= 2, `头栏未吸顶：${stickyState.gap}`);
    assert.equal(stickyState.opaque, true);
    if (process.env.STICKY_SCREENSHOT_PATH) {
      await js("new Promise(r=>setTimeout(r,200))");
      await fs.writeFile(process.env.STICKY_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await js(`document.getElementById('sticky-code-fixture').remove()`);
    // 实时流程没有 todo_write，任务栏保持隐藏。
    assert.equal(await js(`document.getElementById('todo-dock').hidden`), true);
    assert.doesNotMatch(await bodyText(), /旧通道重复结果/);
    assert.match(await bodyText(), /auto_retry_start/);
    await js(`document.querySelector('.output-run').scrollIntoView({block:'start'})`);
    await fs.writeFile(path.join(temporary, "result-collapsed.png"), (await win.webContents.capturePage()).toPNG());
    await js(`window.copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.copied=value},configurable:true});document.querySelector('.code-block-copy').click()`);
    await until(`window.copied.includes('const ok = true;')`);
    await js(`document.querySelectorAll('.output-run .message-actions button')[1].click()`);
    await until(`window.copied.includes('**检查完成**')`);
    await js(`document.querySelectorAll('.output-trace details,.output-trace').forEach(node=>node.open=true);document.querySelector('.output-trace').scrollIntoView({block:'start'})`);
    assert.equal(await js(`document.querySelector('.output-trace').open`), true);
    // 展开后等一帧再截图，避免捕获到展开前的旧帧。
    await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await fs.writeFile(path.join(temporary, "trace-wide.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(680, 780); await js(`new Promise(r=>requestAnimationFrame(r))`);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`), true);
    await fs.writeFile(path.join(temporary, "trace-narrow.png"), (await win.webContents.capturePage()).toPNG());
    console.log("通过：完整页面实时展开、收尾折叠仅保留最终正文，原生流、并行/嵌套工具、重试、复制与窄窗");
    win.reload(); await until(`document.querySelector('.output-trace>summary')?.textContent.includes('历史恢复')`); await idle();
    assert.match(await js(`document.querySelector('.output-trace>summary').textContent`), /^处理过程 · 历史恢复 · \d+ 次工具调用$/);
    assert.equal(await js(`document.querySelectorAll('.trace-turn').length`), 0);
    assert.match(await js(`document.querySelector('.trace-responses>summary').textContent`), /^响应明细（2 次）$/);
    assert.equal(await js(`document.querySelector('.trace-responses').hidden`), false);
    assert.doesNotMatch(await js(`document.querySelector('.trace-process').textContent`), /Turn \d|turn_end/);
    assert.equal(await js(`document.querySelectorAll('.output-run .message-usage:not([hidden])').length`), 0);
    // 历史里的 todo_write 结果重建任务栏，默认折叠。
    assert.equal(await js(`document.getElementById('todo-dock').hidden`), false);
    assert.equal(await js(`document.querySelector('.todo-dock-progress').textContent`), "1 已完成 · 1 进行中 · 1 待处理");
    assert.equal(await js(`document.querySelectorAll('.todo-dock-item').length`), 3);
    assert.equal(await js(`document.querySelector('.todo-dock-list').hidden`), true);
    await js(`document.querySelector('.todo-dock-header').click()`);
    assert.equal(await js(`document.querySelector('.todo-dock-list').hidden`), false);
    assert.equal(await js(`document.querySelector('.todo-dock-header').getAttribute('aria-expanded')`), "true");
    assert.match(await bodyText(), /历史仅保存嵌套调用摘要/);
    assert.match(await bodyText(), /嵌套调用记录不完整/);
    assert.doesNotMatch(await bodyText(), /agent_settled/);
    console.log("通过：历史恢复保留thinking、参数、结果和嵌套摘要，不伪造实时事件");
    for (const nextMode of ["stop", "missing"]) {
      await js(`document.getElementById('new-chat-button').click()`); await idle(); mode = nextMode; await send();
      if (mode === "stop") await js(`document.getElementById('stop-button').click()`);
      else gate.resolve();
      await idle();
      assert.match(await js(`document.querySelector('.output-trace>summary').textContent`), mode === "stop" ? /已停止/ : /未收到收尾事件/);
      assert.equal(await js(`document.querySelector('.output-trace').open`), false);
      assert.doesNotMatch(await js(`Array.from(document.querySelectorAll('.trace-tool>summary'),node=>node.textContent).join('')`), /执行中/);
      assert.equal(await js(`document.querySelectorAll('.output-trace').length`), 1);
    }
    console.log("通过：重复发送无重复监听，停止接收收尾，缺失结束事件标记结果未确认");
    const timingResult = await js(`(async () => { window.verifyOutputTiming = async () => {
      const { createOutputTrace } = await import(new URL('./components/output-trace.js', location.href).href);
      const host = document.createElement('div');
      document.body.append(host);
      let now = 100;
      const intervals = new Map();
      const originalInterval = window.setInterval, originalClear = window.clearInterval;
      const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
      window.setInterval = callback => { const id = intervals.size + 1; intervals.set(id, callback); return id; };
      window.clearInterval = id => intervals.delete(id);
      const check = (condition, label) => { if (!condition) throw Error(label); };
      const paint = () => new Promise(resolve => requestAnimationFrame(resolve));
      const msg = (content, durationMs) => ({ role: 'assistant', content, durationMs, stopReason: 'stop' });
      const trace = createOutputTrace(host);
      const feed = trace.accept;
      const dockHost = document.createElement('div');
      document.body.append(dockHost);
      const { createTodoDock } = await import(new URL('./components/todo-dock.js', location.href).href);
      const dock = createTodoDock(dockHost);
      dock.accept({type:'tool_execution_update',toolName:'todo_write',result:{todos:[{content:'未完成',status:'pending'}]}});
      check(dockHost.hidden, '非结束事件不更新任务栏');
      dock.accept({type:'tool_execution_end',toolName:'read',result:{todos:[{content:'伪造任务',status:'pending'}]}});
      check(dockHost.hidden, '非 todo_write 结果不更新任务栏');
      dock.accept({type:'tool_execution_end',toolName:'todo_write',result:{todos:[{content:'进行中',status:'in_progress'}]}});
      check(!dockHost.hidden, '工具结束显示任务栏');
      check(dockHost.querySelector('.todo-dock-progress').textContent==='1 进行中', '任务进度按状态汇总');
      dock.accept({type:'tool_execution_end',toolName:'read',result:{todos:[{content:'覆盖任务',status:'completed'}]}});
      check(dockHost.querySelector('.todo-dock-progress').textContent==='1 进行中', '其他工具不能覆盖任务栏');
      dock.showHistory([{role:'user'},{output:{toolName:'todo_write',todos:[{content:'完成',status:'completed'},{content:'待办',status:'pending'}]}}]);
      check(dockHost.querySelectorAll('.todo-dock-item').length===2, '历史重建任务项');
      dock.showHistory([{output:{toolName:'todo_write',todos:[{content:'旧轮任务',status:'pending'}]}},{role:'user'},{role:'assistant'}]);
      check(dockHost.hidden, '新请求的历史不恢复上一轮清单');
      dock.accept({type:'agent_start'});
      check(dockHost.hidden, '新请求开始清空任务栏');
      dock.clear();
      check(dockHost.hidden, '清空隐藏任务栏');
      // 展开状态按会话记忆：切走再回来保持展开，新会话保持折叠。
      dock.setSession("s1");
      dock.accept({type:'tool_execution_end',toolName:'todo_write',result:{todos:[{content:'记忆任务',status:'in_progress'}]}});
      check(dockHost.querySelector('.todo-dock-list').hidden===true, '新会话默认折叠');
      dockHost.querySelector('.todo-dock-header').click();
      check(dockHost.querySelector('.todo-dock-list').hidden===false, '点击展开任务栏');
      dock.setSession("s2");
      check(dockHost.querySelector('.todo-dock-list').hidden===true, '切换会话恢复折叠');
      dock.setSession("s1");
      check(dockHost.querySelector('.todo-dock-list').hidden===false, '回到原会话恢复展开');
      check(dockHost.querySelectorAll('.todo-dock-item').length===0, '切换会话不保留上一会话清单');
      dockHost.remove();
      const linkTrace = createOutputTrace(host);
      linkTrace.accept({type:'message_start',message:msg([])});
      linkTrace.accept({type:'message_end',message:msg([{type:'text',text:'[本地文档](docs/a.md) 与 [外部](https://example.com) 以及 [锚点](#x)'}])});
      await paint();
      check(host.querySelector('a[data-file-path="docs/a.md"]')!==null, '本地路径生成预览入口');
      check(host.querySelector('a[data-file-path="docs/a.md"]').getAttribute('href')==='#', '预览入口不跳转页面');
      check(linkTrace.root.textContent.includes('外部（https://example.com）'), '外部链接仍按文字展示');
      linkTrace.dispose();
      try {
        await paint();
        check(host.querySelector('.output-trace>summary').textContent.includes('正在准备请求'), '首个模型事件前展示等待状态');
        feed({type:'agent_start'}); feed({type:'turn_start'}); feed({type:'message_start',message:msg([])});
        now = 1000; feed({type:'message_update',assistantMessageEvent:{type:'thinking_start',contentIndex:0}});
        now = 3000; feed({type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'公开思考'}});
        await paint();
        check(host.querySelector('.trace-thinking summary').textContent.includes('2.0 s（界面计时）'), '思考阶段计时');
        check(host.querySelector('.output-trace>summary').textContent.includes('模型正在思考'), '思考状态');
        now = 4000; feed({type:'message_update',assistantMessageEvent:{type:'thinking_end',contentIndex:0,content:'公开思考'}});
        feed({type:'message_end',message:msg([{type:'thinking',thinking:'公开思考'},{type:'toolCall',id:'t',name:'read',arguments:{path:'a'}}],42)});
        now = 4100; feed({type:'tool_execution_start',toolCallId:'t',toolName:'read'});
        now = 5500; for (const tick of intervals.values()) tick(); await paint();
        check(host.querySelector('.trace-tool summary').textContent.includes('1.4 s（界面计时）'), '执行中的工具计时');
        check(host.querySelector('.trace-responses .trace-meta').textContent.includes('响应耗时 42 ms（SDK）'), '响应采用官方耗时');
        check(host.querySelector('.trace-thinking summary').textContent.includes('3.0 s（界面计时）'), '思考结束后停止计时');
        now = 5700; feed({type:'tool_execution_end',toolCallId:'t',toolName:'read',isError:false,durationMs:88,result:{content:[]}});
        feed({type:'agent_end',willRetry:true}); await paint();
        check(host.querySelector('.output-trace').open, 'agent_end 不提前折叠');
        check(host.querySelector('.trace-tool summary').textContent.includes('88 ms（SDK）'), '最终工具耗时采用官方值');
        feed({type:'turn_start'}); feed({type:'message_start',message:msg([])});
        feed({type:'message_end',message:msg([{type:'text',text:'最终正文'}],1200)});
        host.querySelector('.trace-thinking .trace-thinking-body').focus();
        now = 8000; feed({type:'agent_settled',aborted:false}); await paint();
        check(intervals.size===0, 'settled 清理计时器');
        check(!host.querySelector('.output-trace').open, 'settled 自动收起');
        check(document.activeElement===host.querySelector('.output-trace>summary'), '收起时保护键盘焦点');
        check(host.querySelector('.output-trace>summary').textContent.includes('用时 7.9 s'), '总用时按界面观察');
        const settled = host.querySelector('.output-trace>summary').textContent;
        now = 15000; await paint(); check(host.querySelector('.output-trace>summary').textContent===settled, '结束后用时冻结');
        trace.finish();
        const uncertain = createOutputTrace(host);
        uncertain.accept({type:'agent_settled',aborted:false}); uncertain.finish({outcome:'unconfirmed'});
        check(uncertain.root.textContent.includes('请求结果未确认'), '业务未确认结果不能被 settled 覆盖');
        const missing = createOutputTrace(host);
        missing.accept({type:'message_start',message:msg([])});
        missing.accept({type:'message_end',message:msg([{type:'text',text:'没有思考和SDK耗时的正文'}])});
        missing.finish();
        check(!missing.root.querySelector('.trace-thinking'), '不伪造 thinking');
        check(!missing.root.textContent.includes('（SDK）'), '不伪造 SDK 耗时');
        const streaming = createOutputTrace(host);
        streaming.accept({type:'message_start',message:msg([])});
        streaming.accept({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'流式正文'}});
        await paint();
        check(host.querySelector('.chat-message[data-streaming="true"]')!==null, '流式正文保留光标标记');
        streaming.accept({type:'message_end',message:msg([{type:'text',text:'流式正文'}])});
        await paint();
        check(host.querySelector('.chat-message[data-streaming="true"]')===null, '完成后移除光标标记');
        streaming.dispose();
        const bashTrace = createOutputTrace(host);
        bashTrace.accept({type:'message_start',message:msg([])});
        bashTrace.accept({type:'message_end',message:msg([{type:'toolCall',id:'b',name:'bash',arguments:{command:'echo hi'}}])});
        bashTrace.accept({type:'tool_execution_start',toolCallId:'b',toolName:'bash',args:{command:'echo hi'}});
        bashTrace.accept({type:'tool_execution_update',toolCallId:'b',toolName:'bash',result:{content:[{type:'text',text:'hi'}]}});
        await paint();
        check(host.querySelector('.trace-tool[data-tool-call-id="b"] .trace-terminal')?.textContent.includes('hi'), 'bash 卡片展示实时输出');
        bashTrace.accept({type:'tool_execution_end',toolCallId:'b',toolName:'bash',isError:true,durationMs:5,result:{content:[{type:'text',text:'hi' + String.fromCharCode(10,10) + 'Command exited with code 7'}],exitCode:7}});
        await paint();
        check(host.querySelector('.trace-tool[data-tool-call-id="b"] .trace-exit-bad')?.textContent==='exit 7', 'bash 卡片展示非零退出码');
        bashTrace.dispose();
        const writeTrace = createOutputTrace(host);
        writeTrace.accept({type:'message_start',message:msg([])});
        const nl = String.fromCharCode(10);
        writeTrace.accept({type:'message_end',message:msg([{type:'toolCall',id:'w',name:'write',arguments:{path:'/a.txt',content:['a','b','c'].join(nl)}}])});
        writeTrace.accept({type:'tool_execution_start',toolCallId:'w',toolName:'write',args:{path:'/a.txt',content:['a','b','c'].join(nl)}});
        await paint();
        check(host.querySelector('.trace-tool[data-tool-call-id="w"] .trace-diff-added')?.textContent==='+3', 'write 展示新增行数');
        check(host.querySelector('.trace-tool[data-tool-call-id="w"] .trace-card[data-kind="write"]')!==null, 'write 生成文件卡片');
        check(host.querySelector('.trace-tool[data-tool-call-id="w"] .trace-card-meta')?.textContent==='+3', 'write 卡片显示行数');
        check(host.querySelector('.trace-tool[data-tool-call-id="w"] .trace-raw').open===false, '原始参数默认折叠');
        writeTrace.dispose();
        const editTrace = createOutputTrace(host);
        editTrace.accept({type:'message_start',message:msg([])});
        editTrace.accept({type:'message_end',message:msg([{type:'toolCall',id:'e',name:'edit',arguments:{path:'/b.txt',edits:[{oldText:['a','b'].join(nl),newText:['a','c','d'].join(nl)}]}}])});
        editTrace.accept({type:'tool_execution_start',toolCallId:'e',toolName:'edit',args:{path:'/b.txt',edits:[{oldText:['a','b'].join(nl),newText:['a','c','d'].join(nl)}]}});
        await paint();
        check(host.querySelector('.trace-tool[data-tool-call-id="e"] .trace-diff-added')?.textContent==='+2', 'edit 统计新增行');
        check(host.querySelector('.trace-tool[data-tool-call-id="e"] .trace-diff-removed')?.textContent==='-1', 'edit 统计删除行');
        editTrace.accept({type:'tool_execution_end',toolCallId:'e',toolName:'edit',isError:false,durationMs:4,result:{content:[{type:'text',text:'ok'}],diff:' 1 a' + String.fromCharCode(10) + '-2 b' + String.fromCharCode(10) + '+2 c'}});
        await paint();
        check(host.querySelector('.trace-tool[data-tool-call-id="e"] .trace-line-del')?.textContent==='-2 b', '差异卡片展示删除行');
        check(host.querySelector('.trace-tool[data-tool-call-id="e"] .trace-line-add')?.textContent==='+2 c', '差异卡片展示新增行');
        editTrace.dispose();
        const historical = createOutputTrace(host,{historical:true});
        historical.restore(msg([{type:'text',text:'历史正文'}])); historical.finish();
        check(intervals.size===0, '历史不启动计时');
        check(!historical.root.textContent.includes('用时 0'), '历史不伪造零耗时');
        const abandoned = createOutputTrace(host); abandoned.dispose();
        check(intervals.size===0, '销毁清理计时器');
        const before = abandoned.root.textContent; abandoned.accept({type:'turn_start'}); await paint();
        check(abandoned.root.textContent===before, '销毁后忽略迟到事件');
      } finally {
        trace.dispose();
        window.setInterval=originalInterval; window.clearInterval=originalClear;
        if (originalNow) Object.defineProperty(performance,'now',originalNow); else delete performance.now;
        host.remove();
      }
    }; return await window.verifyOutputTiming().then(()=>null,error=>error.stack); })()`);
    assert.equal(timingResult, null);
    console.log("通过：确定性时钟验证思考/响应/工具计时、官方耗时优先、结束冻结和销毁释放");
    assert.deepEqual(errors, []);
    console.log(`截图：${temporary}`);
  } finally { win.destroy(); }
}
const timeout = setTimeout(() => { console.error("输出检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch(error => { clearTimeout(timeout); console.error(error); app.exit(1); });

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const { toHistory } = require("../../src/main/adapters/message-adapter.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);

const temporary = mkdtempSync(path.join(os.tmpdir(), "trajectory-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");

const base = Date.now() - 10 * 60 * 1000;
const iso = (offset) => new Date(base + offset).toISOString();
const workspace = mkdtempSync(path.join(temporary, "workspace-"));
const runDir = path.join(workspace, "qa", "ui", "runs", "run-1");
mkdirSync(runDir, { recursive: true });
const summaryFile = path.join(runDir, "summary.json");
writeFileSync(summaryFile, JSON.stringify({
  status: "failed",
  durationMs: 1200,
  testCount: 2,
  counts: { total: 2, passed: 1, failed: 1 },
  problems: ["截图缺失"],
  tests: [
    { title: "创建合同", status: "passed", durationMs: 400 },
    { title: "审批合同", status: "failed", durationMs: 800, errors: [{ message: "断言失败：状态错误" }] },
  ],
}));
const raw = [
  { role: "user", timestamp: iso(0), content: "改一下 a.js" },
  {
    role: "assistant", timestamp: iso(10), durationMs: 1200, provider: "mock", model: "offline",
    stopReason: "toolUse", usage: { input: 100, output: 20, totalTokens: 120 },
    content: [
      { type: "thinking", thinking: "先看文件" },
      { type: "text", text: "我先读取文件。" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.js" } },
    ],
  },
  {
    role: "toolResult", timestamp: iso(1215), durationMs: 30, toolCallId: "call-1", toolName: "read",
    content: [{ type: "text", text: "one\ntwo" }], isError: false,
  },
  {
    role: "assistant", timestamp: iso(1250), durationMs: 800, provider: "mock", model: "offline",
    stopReason: "stop", usage: { input: 200, output: 30, totalTokens: 230 },
    content: [{ type: "text", text: "已修改并通过 `npm test`。" }],
  },
  {
    role: "assistant", timestamp: iso(1300), durationMs: 700, provider: "mock", model: "offline",
    stopReason: "toolUse", usage: { input: 120, output: 10, totalTokens: 130 },
    content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "resources/testing/ui/bin/node resources/testing/ui/execute.cjs --project demo --all" } }],
  },
  {
    role: "toolResult", timestamp: iso(2100), durationMs: 1200, toolCallId: "call-2", toolName: "bash",
    content: [{ type: "text", text: `回放完成\n${"日志行\n".repeat(1200)}${JSON.stringify({ status: "failed", summaryFile, testCount: 2, counts: { total: 2, passed: 1, failed: 1 } })}` }],
    isError: false,
  },
  { role: "user", timestamp: iso(3000), content: "再跑一次测试" },
  {
    role: "assistant", timestamp: iso(3010), durationMs: 600, provider: "mock", model: "offline",
    stopReason: "stop", usage: { input: 300, output: 10, totalTokens: 310 },
    content: [{ type: "text", text: "测试通过。" }],
  },
];
const history = toHistory(raw, { includeTrace: true, cwd: "/demo" });

let current = "a";
let serial = 0;
const drafts = new Map();
const draft = (id) => drafts.get(id) ?? { sessionId: id, text: "", revision: 0 };
const session = {
  loadHistory: async () => history,
  currentSession: async () => current,
  getSessionInfo: async () => ({ sessionId: current, workspaceDir: workspace, provider: "mock", modelId: "offline", contextUsage: null }),
  listSessions: async () => [{ id: "a", title: "轨迹验收", workspaceDir: workspace, updatedAt: 1 }],
  listUnsentSessions: async () => [],
  listModels: async () => ({ provider: "mock", modelId: "offline", models: [{ provider: "mock", id: "offline", name: "offline" }] }),
  newChat: async () => current,
  previewSession: async () => ({ title: "轨迹验收", history }),
  listSlashCommands: async () => [],
  openSession: async () => history,
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
  async send(_text, _onText, _onTool, _status, request, ack, onOutput) {
    serial += 1;
    const at = Date.now();
    const consumed = { sessionId: current, text: "", revision: request.revision + 1, sendId: `send-${serial}` };
    drafts.set(current, consumed);
    ack(consumed);
    const emit = (value) => onOutput({ requestSessionId: current, sessionId: current, ...value });
    emit({ type: "agent_start", ts: at });
    emit({
      type: "message_end",
      message: {
        role: "assistant", timestamp: new Date(at + 20).toISOString(), durationMs: 300, provider: "mock", model: "offline",
        stopReason: "stop", usage: { input: 10, output: 5, totalTokens: 15 },
        content: [{ type: "text", text: "新的实时回复。" }],
      },
    });
    emit({ type: "agent_settled", aborted: false, ts: at + 330 });
    return { outcome: "completed", draft: consumed };
  },
  stop: async () => {},
};
const projectService = {
  listProjects: async () => [],
  listProjectEnvironments: async () => [],
  listTestData: async () => [],
  listTestReports: async () => [],
};
const permissionOptions = [{ id: "ask", label: "每次确认" }];
const permissionService = {
  settings: async () => ({ mode: "ask", scope: "session", defaultMode: "ask", options: permissionOptions }),
  save: async () => ({ mode: "ask", scope: "session", defaultMode: "ask", options: permissionOptions }),
};
registerAgentIpc(ipcMain, session, chat, {}, {}, {}, {}, projectService, composer, {}, {}, permissionService);

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
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
    await until("document.querySelectorAll('.session-open').length >= 1");

    assert.equal(await js("document.querySelectorAll('.conversation-tabs [role=tab]').length"), 2);
    await js("document.getElementById('trajectory-view-tab').click()");
    await until("!document.getElementById('trajectory-view').hidden && document.querySelector('.traj-overview')");
    assert.equal(await js("document.getElementById('messages').hidden"), true);
    assert.equal(await js("getComputedStyle(document.querySelector('.composer-area')).display"), "none");
    assert.equal(await js("document.querySelectorAll('.traj-overview__row').length"), 3);
    assert.ok(await js("document.querySelectorAll('.traj-bar').length") >= 4);
    assert.match(await js("document.querySelector('.traj-summary').textContent"), /2 轮/);
    assert.match(await js("document.querySelector('.traj-summary').textContent"), /790 tokens/);
    assert.match(await js("document.querySelector('.traj-records').textContent"), /我先读取文件/);
    assert.match(await js("document.querySelector('.traj-records').textContent"), /read · a\.js/);
    assert.match(await js("document.querySelector('.traj-records').textContent"), /1\.2 秒/);
    console.log("通过：轨迹标签、时长概览、轮次与记录");
    if (process.env.TRAJECTORY_SCREENSHOT_PATH) {
      await js("new Promise(r=>setTimeout(r,500))");
      await fs.writeFile(process.env.TRAJECTORY_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    // 回放记录展开后读取逐测试统计。
    const replayId = await js("document.querySelector('.traj-record__replay-tag')?.closest('details')?.dataset.recordId");
    assert.ok(replayId, "未识别回放记录");
    await js(`document.querySelector('[data-record-id="' + ${JSON.stringify(replayId)} + '"] summary').click()`);
    await until("document.querySelector('.traj-replay__table')");
    assert.match(await js("document.querySelector('.traj-replay__summary').textContent"), /2 用例 · 1 通过 · 1 失败/);
    assert.equal(await js("document.querySelectorAll('.traj-replay__table tbody tr').length"), 2);
    assert.match(await js("document.querySelector('.traj-replay__table').textContent"), /创建合同/);
    assert.match(await js("document.querySelector('.traj-replay__table').textContent"), /审批合同/);
    assert.match(await js("document.querySelector('.traj-replay__table').textContent"), /400 ms/);
    assert.match(await js("document.querySelector('.traj-replay__table').textContent"), /断言失败：状态错误/);
    console.log("通过：回放逐测试耗时与错误");
    if (process.env.TRAJECTORY_REPLAY_SCREENSHOT_PATH) {
      await js("document.querySelector('.traj-replay').scrollIntoView({block:'center'})");
      await js("new Promise(r=>setTimeout(r,300))");
      await fs.writeFile(process.env.TRAJECTORY_REPLAY_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    // 点击时长条定位到对应记录并高亮。
    const targetId = await js("document.querySelector('.traj-bar--model').dataset.recordId");
    await js(`document.querySelector('.traj-bar--model').click()`);
    await until(`document.querySelector('[data-record-id="' + ${JSON.stringify(targetId)} + '"]')?.open`);
    assert.equal(await js(`document.querySelector('[data-record-id="' + ${JSON.stringify(targetId)} + '"]').classList.contains('traj-record--focus')`), true);
    console.log("通过：点击时长条定位到记录");

    // 上翻后出现回到最新，点击后回到底部并隐藏。
    await js("const view=document.getElementById('trajectory-view');view.scrollTop=0;view.dispatchEvent(new Event('scroll'))");
    await js("new Promise(r=>setTimeout(r,120))");
    assert.equal(await js("document.getElementById('trajectory-latest').hidden"), false);
    await js("document.getElementById('trajectory-latest').click()");
    await js("new Promise(r=>setTimeout(r,900))");
    assert.equal(await js("document.getElementById('trajectory-latest').hidden"), true);
    console.log("通过：轨迹跟随最新与回到最新");

    // 轮次模式按请求分组。
    await js("[...document.querySelectorAll('.traj-mode')].find(button=>button.textContent==='轮次').click()");
    assert.equal(await js("document.querySelectorAll('.traj-turn').length"), 2);
    assert.equal(await js("document.querySelectorAll('.traj-turn[open]').length"), 1);
    assert.match(await js("document.querySelector('.traj-turn').textContent"), /改一下 a\.js/);
    if (process.env.TRAJECTORY_TURN_SCREENSHOT_PATH) {
      await js("[...document.querySelectorAll('.traj-record[open]')].forEach(node=>{node.open=false})");
      await js("new Promise(r=>setTimeout(r,400))");
      await fs.writeFile(process.env.TRAJECTORY_TURN_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    // 调用模式只列工具。
    await js("[...document.querySelectorAll('.traj-mode')].find(button=>button.textContent==='调用').click()");
    assert.equal(await js("document.querySelectorAll('.traj-record[data-kind=\"tool\"]').length"), 2);
    assert.equal(await js("document.querySelectorAll('.traj-record[data-kind=\"assistant\"]').length"), 0);
    if (process.env.TRAJECTORY_CALL_SCREENSHOT_PATH) {
      await js("[...document.querySelectorAll('.traj-record[open]')].forEach(node=>{node.open=false})");
      await js("new Promise(r=>setTimeout(r,400))");
      await fs.writeFile(process.env.TRAJECTORY_CALL_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    // 回到时长模式，搜索并展开工具详情。
    await js("[...document.querySelectorAll('.traj-mode')].find(button=>button.textContent==='时长').click()");
    await js("(()=>{const input=document.querySelector('.traj-search input');input.value='one';input.dispatchEvent(new Event('input'));})()");
    await js("new Promise(r=>requestAnimationFrame(r))");
    assert.equal(await js("document.querySelectorAll('.traj-record').length"), 1);
    assert.match(await js("document.querySelector('.traj-record__title').textContent"), /a\.js/);
    await js("document.querySelector('.traj-record summary').click()");
    assert.match(await js("document.querySelector('.traj-record__body').textContent"), /参数/);
    assert.match(await js("document.querySelector('.traj-record__body').textContent"), /one/);
    console.log("通过：轮次/调用切换、搜索与工具详情");

    await js("(()=>{const input=document.querySelector('.traj-search input');input.value='';input.dispatchEvent(new Event('input'));})()");
    await js("new Promise(r=>requestAnimationFrame(r))");

    // 切回对话并发送一条实时请求。
    await js("document.getElementById('conversation-view-tab').click()");
    await until("!document.getElementById('messages').hidden");
    assert.notEqual(await js("getComputedStyle(document.querySelector('.composer-area')).display"), "none");
    await send("新的请求");
    await js("document.getElementById('trajectory-view-tab').click()");
    await until("document.querySelectorAll('.traj-request').length === 3");
    assert.match(await js("document.querySelector('.traj-records').textContent"), /新的实时回复/);
    assert.match(await js("document.querySelector('.traj-records').textContent"), /新的请求/);
    assert.equal(await js("document.getElementById('trajectory-latest').hidden"), true);
    console.log("通过：实时请求进入轨迹");

    // 窄窗不出现页面级横向溢出，轨迹仍可切换与滚动。
    for (const [width, height] of [[680, 780], [375, 700]]) {
      win.setSize(width, height);
      // 左侧栏收起有 300ms 宽度过渡；等过渡结束再测布局。
      await js("new Promise(r=>setTimeout(r,450))");
      assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true, `窄窗 ${width} 横向溢出`);
      assert.equal(await js("document.querySelectorAll('.conversation-tabs [role=tab]').length"), 2);
      assert.equal(await js("document.getElementById('trajectory-view').hidden"), false);
    }
    win.setSize(1280, 900);
    await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    console.log("通过：680/375 窄窗无页面级横向溢出");

    await fs.writeFile(path.join(temporary, "trajectory.png"), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log("通过：对话/轨迹视图与运行轨迹功能");
    console.log(`截图：${path.join(temporary, "trajectory.png")}`);
  } finally {
    win.destroy();
  }
}

const timeout = setTimeout(() => { console.error("轨迹检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});

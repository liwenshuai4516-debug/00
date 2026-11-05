const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);
const temporary = mkdtempSync(path.join(os.tmpdir(), "context-usage-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");
const flags = {}, calls = [], drafts = new Map(), usage = new Map(), models = new Map(), archived = new Map();
const draft = id => { if (!drafts.has(id)) drafts.set(id, { sessionId: id, text: "", revision: 0 }); return drafts.get(id); };
let current = "a", generating = false, sendGate, compactGate, serial = 0;
const estimate = percent => ({ tokens: percent * 100, contextWindow: 10000, percent });
usage.set("a", estimate(32));
const history = () => [{ role: "user", text: `消息 ${current}` }];
async function pause(name) { const gate = flags[name]; if (gate) { delete flags[name]; await gate.promise; } }
const session = {
  loadHistory: async () => history(), currentSession: async () => current,
  async getSessionInfo() {
    const snapshot = { sessionId: current, modelId: models.get(current) ?? "flash", provider: "mock", workspaceDir: "/demo/<img>", contextUsage: usage.get(current) ?? null };
    calls.push(["info", snapshot.sessionId, snapshot.modelId]);
    await pause("infoGate");
    if (flags.infoFail) throw Error("模拟读取失败 <img src=x>");
    return snapshot;
  },
  getContextBreakdown: async () => {
    calls.push(["breakdown", current]);
    const snapshot = usage.get(current) ?? estimate(0);
    const total = Number.isFinite(snapshot?.tokens) ? snapshot.tokens : 0;
    const systemTokens = Math.round(total * 0.3);
    const toolsTokens = Math.round(total * 0.15);
    return {
      source: "heuristic",
      systemTokens,
      toolsTokens,
      messageTokens: Math.max(0, total - systemTokens - toolsTokens),
      totalTokens: total,
      contextWindow: snapshot?.contextWindow ?? 10000,
      percent: snapshot?.percent ?? 0,
    };
  },
  listModels: async () => ({ provider: "mock", modelId: models.get(current) ?? "flash", models: ["flash", "pro"].map(id => ({ id, name: id, provider: "mock" })) }),
  async switchModel(id) {
    calls.push(["model", current, id]); await pause("modelGate");
    models.set(current, id); usage.set(current, estimate(id === "pro" ? 12 : 32));
    if (flags.modelFail) throw Error("模拟部分切换后失败");
  },
  listSessions: async () => ["a", "b"].map((id, i) => ({ id, title: `对话 ${id}`, workspaceDir: "/demo/project", updatedAt: 10 - i, archivedAt: archived.get(id) ?? null })),
  listUnsentSessions: async () => [{ id: "u", title: "未发送", workspaceDir: "/demo/project", blockedReason: "" }],
  async openSession(id) { calls.push(["open", id]); await pause("openGate"); if (flags.openFail) throw Error("模拟打开失败"); current = id; return history(); },
  newChat: async () => { current = `new-${++serial}`; return current; },
  restoreUnsentSession: async id => { current = id; return { sessionId: current, history: history() }; },
  async setSessionArchived(id, value) {
    archived.set(id, value ? 100 : null);
    if (id === current && value) { current = `archive-${++serial}`; return { id, archivedAt: 100, changed: true, sessionId: current, history: [] }; }
    return { id, archivedAt: archived.get(id), changed: false };
  },
  async compactSession() {
    calls.push(["compact"]); compactGate = Promise.withResolvers(); await compactGate.promise;
    if (flags.compactFail) throw Error("模拟整理失败");
    if (flags.compactSkip) return { history: history(), stopped: false, skipped: true, skipReason: "too-small" };
    usage.set(current, { tokens: null, percent: null, contextWindow: 10000 });
    return { history: history(), stopped: Boolean(flags.cancelled) };
  },
  cancelCompaction: async () => { calls.push(["cancel"]); flags.cancelled = true; compactGate.resolve(); },
};
const composer = {
  loadCurrentDraft: async () => ({ ...draft(current) }),
  inspectSend: async id => ({ ...draft(id), pendingSend: null }),
  saveDraft: async (id, text, revision) => {
    assert.equal(revision, draft(id).revision); Object.assign(draft(id), { text, revision: revision + 1 }); return { ...draft(id) };
  },
};
const chat = {
  isBusy: () => generating,
  listProposals: async () => [{ id: `file-${current}` }],
  async send(text, onText, _tool, _status, request, ack) {
    generating = true; sendGate = Promise.withResolvers();
    const consumed = { sessionId: current, text: "", revision: request.revision + 1, sendId: "send" };
    Object.assign(draft(current), consumed); ack(consumed); onText("模拟回复"); await sendGate.promise;
    generating = false; usage.set(current, estimate(40));
    if (flags.sendFail) throw Error("模拟请求失败");
    return { outcome: "completed", stopped: true, draft: consumed };
  },
  stop: async () => sendGate.resolve(),
};
registerAgentIpc(ipcMain, session, chat, {
  review: async () => ({ kind: "create-proposal", path: "mock.txt", content: "仅模拟，不写文件" }),
}, {
  apply: async () => { calls.push(["save-file"]); usage.set(current, estimate(51)); return { path: "mock.txt" }; },
}, {}, {
  selectWorkspace: async () => { current = "workspace"; return { sessionId: current, workspaceDir: "/demo/other" }; },
}, {
  listProjects: async () => [{ id: "p", name: "项目", workspaceDir: "/demo/project" }],
  openProject: async () => { current = "project"; usage.set(current, estimate(15)); return { sessionId: current, history: history() }; },
}, composer, {});

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1120, height: 820, show: false,
    webPreferences: { preload: path.join(root, "src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_d, done) => done({ cancel: true }));
  const errors = [], passed = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const js = source => win.webContents.executeJavaScript(source);
  const until = expression => js(`(async()=>{for(let i=0;i<500;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败:'+${JSON.stringify(expression)});})()`);
  const idle = () => until(`!document.getElementById('new-chat-button').disabled&&!document.getElementById('model-select').disabled`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const label = () => js(`document.getElementById('context-usage-toggle').textContent`);
  const edit = text => js(`document.getElementById('message-input').value=${JSON.stringify(text)};document.getElementById('message-input').dispatchEvent(new Event('input'))`);
  const openDetails = async () => { if (await js(`document.getElementById('context-usage-details').hidden`)) await click('#context-usage-toggle'); };
  const refresh = async () => { await openDetails(); await click('#context-usage [data-refresh]'); await until(`document.getElementById('context-usage-toggle').textContent!=='上下文读取中…'`); };
  const check = async (name, fn) => { await fn(); passed.push(name); console.log("通过", name); };
  try {
    await win.loadFile(path.join(root, "src/renderer/index.html")); await idle();
    await check("启动只读一次信息，菜单与常驻入口同源，展示原文安全", async () => {
      assert.equal(calls.filter(c => c[0] === "info").length, 1);
      assert.equal(await label(), "上下文约 32.0%");
      await openDetails(); assert.match(await js(`document.querySelector('#context-usage [data-usage]').textContent`), /3,200 \/ 10,000/);
      await until(`!document.querySelector('#context-usage [data-breakdown]').hidden`);
      assert.equal(await js(`document.querySelectorAll('#context-usage [data-breakdown-row]').length`), 3);
      assert.equal(await js(`document.querySelector('[data-breakdown-row="system"] [data-breakdown-tokens]').textContent`), "960");
      assert.equal(calls.filter(c => c[0] === "breakdown").length, 1);
      assert.match(await js(`document.getElementById('session-info').textContent`), /32.0%/);
      assert.equal(await js(`document.querySelectorAll('#session-info img,#context-usage img').length`), 0);
      assert.equal(calls.filter(c => c[0] === "compact").length, 0);
      assert.equal(await js(`document.querySelectorAll('#session-info[role=status],#context-usage [role=status]').length`), 1);
    });
    await check("有效零、无估算和整理后未知均准确，保留模型窗口", async () => {
      usage.set(current, estimate(0)); await refresh(); assert.equal(await label(), "上下文约 0.0%");
      usage.set(current, null); await refresh(); assert.equal(await label(), "上下文待估算");
      usage.set(current, { tokens: null, percent: null, contextWindow: 10000 }); await refresh();
      assert.equal(await label(), "上下文待估算"); assert.match(await js(`document.querySelector('[data-usage]').textContent`), /等待模型回复后更新（窗口 10,000 tokens）/);
    });
    await check("75与90阈值有文字提示，较高估算不阻止发送", async () => {
      for (const percent of [74.9, 75, 89.9, 90, 105]) {
        usage.set(current, estimate(percent)); await refresh();
        assert.equal((await label()).includes(percent >= 90 ? "接近上限" : "用量较高"), percent >= 75);
        assert.equal(await js(`document.getElementById('send-button').disabled`), false);
      }
      assert.equal(calls.filter(c => c[0] === "compact").length, 0);
    });
    await check("读取失败清除旧数字，重试只读取一次且纯文本展示", async () => {
      flags.infoFail = true; await refresh(); assert.equal(await label(), "上下文读取失败");
      assert.match(await js(`document.querySelector('[data-usage]').textContent`), /<img src=x>/);
      assert.equal(await js(`document.querySelectorAll('#context-usage img').length`), 0);
      const count = calls.filter(c => c[0] === "info").length; flags.infoFail = false;
      usage.set(current, estimate(33)); await refresh();
      assert.equal(calls.filter(c => c[0] === "info").length, count + 1); assert.equal(await label(), "上下文约 33.0%");
    });
    await check("旧会话读取迟到不能覆盖打开的新会话，切换期间立即清旧数", async () => {
      const gate = flags.infoGate = Promise.withResolvers();
      await openDetails(); await click('#context-usage [data-refresh]');
      const openGate = flags.openGate = Promise.withResolvers();
      usage.set("b", estimate(65)); await click('.session-open[data-session-id="b"]');
      await until(`document.getElementById('new-chat-button').disabled`); assert.equal(await label(), "上下文读取中…");
      openGate.resolve(); await idle(); assert.equal(await label(), "上下文约 65.0%");
      gate.resolve(); await js(`new Promise(r=>setTimeout(r,50))`); assert.equal(await label(), "上下文约 65.0%");
    });
    await check("同会话模型切换清旧值，部分切换后报错仍显示实际模型用量", async () => {
      const old = flags.infoGate = Promise.withResolvers(); await openDetails(); await click('#context-usage [data-refresh]');
      const gate = flags.modelGate = Promise.withResolvers(); flags.modelFail = true;
      await js(`document.getElementById('model-select').value=JSON.stringify(['mock','pro']);document.getElementById('model-select').dispatchEvent(new Event('change'))`);
      await until(`document.getElementById('model-select').disabled`); assert.equal(await label(), "上下文读取中…");
      gate.resolve(); await idle(); flags.modelFail = false; assert.equal(await label(), "上下文约 12.0%");
      old.resolve(); await js(`new Promise(r=>setTimeout(r,50))`); assert.equal(await label(), "上下文约 12.0%");
      assert.match(await js(`document.getElementById('session-info').textContent`), /mock\/pro/);
    });
    await check("打开失败恢复原会话信息，不保留切换加载态", async () => {
      flags.openFail = true; await click('.session-open[data-session-id="a"]'); await idle(); flags.openFail = false;
      await until(`document.getElementById('context-usage-toggle').textContent!=='上下文读取中…'`);
      assert.equal(current, "b"); assert.equal(await label(), "上下文约 12.0%");
    });
    await check("新建、项目、目录、未发送恢复均刷新目标信息", async () => {
      await click('#new-chat-button'); await idle(); assert.equal(await label(), "上下文待估算");
      await click('.session-project-open'); await idle(); assert.equal(await label(), "上下文约 15.0%");
      await click('#select-workspace-button'); await idle(); assert.equal(await label(), "上下文待估算");
      usage.set("u", estimate(17)); await click('button[data-session-id="u"]'); await idle(); assert.equal(await label(), "上下文约 17.0%");
    });
    await check("保存文件事实后刷新用量，保留输入与草稿状态", async () => {
      await edit("保存文件时保留输入"); await js(`document.getElementById('proposal-review-panel').open=true`);
      await click('#proposal-list article button'); await idle();
      await click('#proposal-list article button:nth-of-type(2)'); await idle();
      assert.equal(await label(), "上下文约 51.0%"); assert.equal(calls.filter(c => c[0] === "save-file").length, 1);
      assert.equal(await js(`document.getElementById('message-input').value`), "保存文件时保留输入");
      assert.match(await js(`document.getElementById('proposal-list').textContent`), /已保存/);
      await js(`document.getElementById('proposal-review-panel').open=false`);
    });
    await check("生成中显示上次估算、禁用整理和重读，停止后自动更新", async () => {
      await click('#send-button'); await until(`!document.getElementById('stop-button').disabled`);
      await openDetails(); assert.match(await label(), /51.0% · 生成中/);
      assert.equal(await js(`document.querySelector('[data-compact]').disabled&&document.querySelector('#context-usage [data-refresh]').disabled`), true);
      await edit("生成中新的输入"); await click('#stop-button'); await idle();
      assert.equal(await label(), "上下文约 40.0%");
      assert.equal(await js(`document.getElementById('message-input').value`), "生成中新的输入");
    });
    await check("整理仅主动点击触发，取消后保留输入和文件草稿并刷新未知", async () => {
      const count = await js(`document.querySelectorAll('#proposal-list article').length`);
      await openDetails(); await click('#context-usage [data-compact]');
      await until(`!document.getElementById('cancel-compaction-button').hidden`);
      assert.equal(calls.filter(c => c[0] === "compact").length, 1);
      assert.equal(await js(`document.getElementById('context-usage-details').hidden`), true);
      await click('#cancel-compaction-button'); await idle();
      assert.equal(await label(), "上下文待估算");
      assert.equal(await js(`document.getElementById('message-input').value`), "生成中新的输入");
      assert.equal(await js(`document.querySelectorAll('#proposal-list article').length`), count);
    });
    await check("整理成功、失败或空操作均重新读取，失败保留原消息及输入", async () => {
      for (const fails of [false, true]) {
        usage.set(current, estimate(22)); await refresh();
        const messages = await js(`document.getElementById('messages').textContent`);
        const count = calls.filter(c => c[0] === "info").length;
        flags.cancelled = false; flags.compactFail = fails;
        await openDetails(); await click('#context-usage [data-compact]');
        await until(`!document.getElementById('cancel-compaction-button').hidden`);
        compactGate.resolve(); await idle();
        assert.equal(calls.filter(c => c[0] === "info").length, count + 1);
        assert.equal(await label(), fails ? "上下文约 22.0%" : "上下文待估算");
        assert.equal(await js(`document.getElementById('message-input').value`), "生成中新的输入");
        if (fails) assert.ok((await js(`document.getElementById('messages').textContent`)).includes(messages));
      }
      flags.compactFail = false;

      // 没有可整理内容时不重建消息区，也不追加错误提示。
      flags.compactSkip = true;
      const beforeSkip = await js(`document.getElementById('messages').textContent`);
      await openDetails(); await click('#context-usage [data-compact]');
      await until(`!document.getElementById('cancel-compaction-button').hidden`);
      compactGate.resolve(); await idle();
      assert.equal(await js(`document.getElementById('messages').textContent`), beforeSkip);
      assert.match(await js(`document.getElementById('request-status').textContent`), /内容较少，无需整理/);
      flags.compactSkip = false;
    });
    await check("请求失败收尾仍刷新用量并保留后来输入", async () => {
      flags.sendFail = true; await click('#send-button');
      await until(`!document.getElementById('stop-button').disabled`); await edit("失败时后来输入");
      await click('#stop-button'); await idle(); flags.sendFail = false;
      assert.equal(await label(), "上下文约 40.0%");
      assert.equal(await js(`document.getElementById('message-input').value`), "失败时后来输入");
    });
    await check("归档当前会话后信息绑定替代会话，撤销不回填原用量", async () => {
      await click('.session-open[data-session-id="a"]'); await idle();
      await click('.session-row[data-session-id="a"] .session-actions-toggle'); await click('.session-row[data-session-id="a"] .session-archive-action'); await idle();
      assert.match(current, /archive-/); assert.equal(await label(), "上下文待估算");
      await click('.archive-notice button'); await idle(); assert.equal(await label(), "上下文待估算");
    });
    await win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const key = async (key, code, value) => {
      await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: value });
      if (key === "Enter") await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "char", key, text: "\r", windowsVirtualKeyCode: value });
      await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: value });
    };
    await check("真实键盘打开、Tab可达、组词Escape保护及关闭恢复焦点", async () => {
      win.show(); win.focus();
      await js(`document.getElementById('context-usage-toggle').focus()`); await key("Enter", "Enter", 13);
      assert.equal(await js(`document.getElementById('context-usage-details').hidden`), false);
      await key("Tab", "Tab", 9); assert.equal(await js(`document.activeElement.hasAttribute('data-refresh')`), true, await js(`document.activeElement.outerHTML`));
      await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))`);
      assert.equal(await js(`document.getElementById('context-usage-details').hidden`), false);
      await key("Escape", "Escape", 27); assert.equal(await js(`document.activeElement.id`), "context-usage-toggle");
      assert.equal(await js(`document.getElementById('context-usage-details').hidden`), true);
      await key("Enter", "Enter", 13); await js(`document.getElementById('message-input').focus()`);
      assert.equal(await js(`document.getElementById('context-usage-details').hidden`), true);
    });
    for (const width of [1120, 760, 375]) {
      await check(`${width}宽度入口和详情可见、无横向溢出`, async () => {
        win.setSize(width, 820); await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        if (await js(`document.getElementById('app-sidebar').dataset.collapsed==='false'`) && width <= 760) await click('#sidebar-toggle');
        usage.set(current, estimate(78)); await refresh();
        await js(`document.getElementById('context-usage-toggle').focus()`);
        await openDetails();
        await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        assert.equal(await js(`document.getElementById('context-usage-details').hidden`), false);
        assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&[document.getElementById('context-usage-toggle'),document.getElementById('context-usage-details')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&e.scrollWidth<=e.clientWidth+1})`), true);
        await fs.writeFile(path.join(temporary, `context-${width}.png`), (await win.webContents.capturePage()).toPNG());
        if (width === 1120 && process.env.CONTEXT_USAGE_SCREENSHOT_PATH) {
          await fs.writeFile(process.env.CONTEXT_USAGE_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
        }
        await click('#context-usage-toggle');
      });
    }
    await check("页面离开后迟到读取不再改写用量", async () => {
      const gate = flags.infoGate = Promise.withResolvers(); await openDetails(); await click('#context-usage [data-refresh]');
      const previous = await label(); await js(`window.dispatchEvent(new Event('pagehide'))`); gate.resolve();
      await js(`new Promise(r=>setTimeout(r,50))`); assert.equal(await label(), previous);
    });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(temporary, "report.json"), JSON.stringify({ count: passed.length, passed }, null, 2));
    console.log(`上下文页面 ${passed.length} 项通过，报告：${temporary}`);
  } finally { win.destroy(); }
}
const timeout = setTimeout(() => { console.error("上下文检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch(error => { clearTimeout(timeout); console.error(error); app.exit(1); });

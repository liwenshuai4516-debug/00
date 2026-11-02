const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const temporary = mkdtempSync(path.join(os.tmpdir(), "session-pin-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.commandLine.appendSwitch("disable-http-cache");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");

async function main() {
  const sessionDir = path.join(temporary, "sessions");
  await fs.mkdir(sessionDir);
  const workspace = path.join(temporary, "team-a", "demo");
  const other = path.join(temporary, "team-b", "demo");
  const store = createSessionStateStore(path.join(temporary, "state"));
  const histories = [];
  for (const [id, cwd, time, title] of [
    ["a", workspace, 3000, "当前对话"], ["b", workspace, 1000, "待置顶的长标题 <img src=x onerror=alert(1)>"],
    ["c", other, 2000, "其他目录对话"],
  ]) {
    const timestamp = new Date(time).toISOString();
    const content = [
      { type: "session", version: 3, id, cwd, timestamp },
      { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: title, timestamp: time } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    const filename = path.join(sessionDir, `${id}.jsonl`);
    await fs.writeFile(filename, content);
    histories.push([filename, content]);
  }
  await store.registerSession("a", workspace, "history", { provider: "test", modelId: "mock" });
  await store.saveDraft("a", workspace, "保留的中文输入\n第二行", 0);
  const service = createSessionService(sessionDir, () => assert.fail("不能创建Agent"),
    () => assert.fail("不能读取真实配置"), undefined, store);
  let current = "a", generating = false, sendGate;
  const flags = {}, calls = [];
  const draft = async id => {
    const state = await store.load(id);
    return { sessionId: id, text: state?.draft.text ?? "", revision: state?.draft.revision ?? 0 };
  };
  const session = {
    loadHistory: async () => [{ role: "user", text: "原聊天内容" }],
    currentSession: async () => current,
    getSessionInfo: async () => ({ sessionId: current, workspaceDir: workspace, provider: "test", modelId: "mock", contextUsage: null }),
    listModelProfiles: async () => ({ currentProfileId: "mock", profiles: [{ id: "mock", name: "测试模型", provider: "test", modelId: "mock" }] }),
    listUnsentSessions: async () => [],
    listSessions: async () => {
      if (flags.listFail) throw Error("模拟列表失败");
      return service.listSessions();
    },
    setSessionPinned: async (id, pinned) => {
      calls.push(["pin", id, pinned]);
      if (flags.pinGate) await flags.pinGate.promise;
      if (flags.pinFail) throw Error("模拟置顶失败");
      const result = await service.setSessionPinned(id, pinned);
      if (flags.resultLost) throw Error("模拟返回丢失");
      return result;
    },
    openSession: async id => { if (flags.openFail) throw Error("模拟打开失败"); calls.push(["open", id]); current = id; return []; },
  };
  const composer = {
    loadCurrentDraft: () => draft(current),
    inspectSend: async id => ({ ...await draft(id), pendingSend: null }),
    saveDraft: async (id, text, revision) => {
      const cwd = id === "c" ? other : workspace;
      const saved = await store.saveDraft(id, cwd, text, revision);
      return { sessionId: id, ...saved.draft };
    },
  };
  const chat = {
    isBusy: () => generating, listProposals: async () => [],
    send: async (text, _onText, _onTool, _onStatus, request, ack) => {
      generating = true;
      const state = await store.consumeDraft(current, workspace, text, request.revision);
      const consumed = { sessionId: current, ...state.draft, sendId: state.pendingSend.id };
      ack(consumed); sendGate = Promise.withResolvers(); await sendGate.promise;
      await store.completeSend(current, workspace, consumed.sendId);
      generating = false;
      return { stopped: true, outcome: "stopped", draft: consumed };
    },
    stop: async () => sendGate.resolve(),
  };
  registerAgentIpc(ipcMain, session, chat, {}, {}, {}, {}, {
    listProjects: async () => [{ id: "project", name: "演示项目", workspaceDir: workspace }],
  }, composer, {});
  await app.whenReady();
  const win = new BrowserWindow({ width: 1120, height: 820, show: false,
    webPreferences: { preload: path.join(root, "src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
  const errors = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const js = source => win.webContents.executeJavaScript(source);
  const until = expression => js(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败:'+${JSON.stringify(expression)});})()`);
  const idle = () => until(`!document.getElementById('new-chat-button').disabled&&!document.getElementById('model-select').disabled`);
  const row = id => `.session-row[data-session-id="${id}"]`;
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pin = async id => { await click(`${row(id)} .session-actions-toggle`); await click(`${row(id)} .session-pin-action`); };
  const order = () => js(`[...document.querySelectorAll('.session-group')].map(g=>[...g.querySelectorAll('.session-open')].map(b=>b.dataset.sessionId))`);
  const edit = text => js(`document.getElementById('message-input').value=${JSON.stringify(text)};document.getElementById('message-input').dispatchEvent(new Event('input'))`);
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log("通过", name); };
  try {
    await win.loadFile(path.join(root, "src/renderer/index.html")); await idle();
    await check("初始分组按消息活动，同名目录不合并", async () => assert.deepEqual(await order(), [["a", "b"], ["c"]]));
    await js(`document.getElementById('proposal-list').textContent='保留文件草稿'`);
    await check("菜单独立于打开按钮，标题纯文本展示", async () => {
      assert.equal(await js(`document.querySelectorAll('.session-open button').length`), 0);
      assert.equal(await js(`document.querySelectorAll('#session-list img').length`), 0);
      await click(`${row("b")} .session-actions-toggle`);
      assert.equal(await js(`document.querySelector('${row("b")} .session-actions-toggle').getAttribute('aria-expanded')`), "true");
      assert.equal(current, "a");
      await js(`document.body.click()`);
    });
    await check("置顶其他会话保留当前聊天、输入与文件草稿，焦点回操作按钮", async () => {
      await pin("b"); await idle();
      assert.deepEqual(await order(), [["b", "a"], ["c"]]);
      assert.equal(current, "a");
      assert.equal(await js(`document.getElementById('message-input').value`), "保留的中文输入\n第二行");
      assert.equal(await js(`document.getElementById('proposal-list').textContent`), "保留文件草稿");
      assert.equal(await js(`document.getElementById('conversation-title').textContent`), "当前对话");
      assert.equal(await js(`document.activeElement.className`), "session-actions-toggle");
      assert.equal(typeof (await store.load("b")).pinnedAt, "number");
    });
    await check("当前会话置顶不污染标题和当前标记", async () => {
      await pin("a"); await idle();
      assert.equal(current, "a");
      assert.equal(await js(`document.getElementById('conversation-title').textContent`), "当前对话");
      assert.equal(await js(`document.querySelector('.session-open[aria-current=true]').dataset.sessionId`), "a");
      await pin("a"); await idle();
    });
    await check("取消置顶恢复活动顺序", async () => { await pin("b"); await idle(); assert.deepEqual(await order(), [["a", "b"], ["c"]]); });
    await check("等待保存时防重复并禁用切换，仍允许输入继续编辑", async () => {
      flags.pinGate = Promise.withResolvers(); const count = calls.length;
      await pin("b"); await until(`document.getElementById('new-chat-button').disabled`);
      await click(`${row("a")} .session-actions-toggle`);
      assert.equal(calls.length, count + 1);
      assert.equal(await js(`[...document.querySelectorAll('#session-list button')].every(b=>b.disabled)`), true);
      await edit("等待中后来输入");
      flags.pinGate.resolve(); flags.pinGate = null; await idle();
      assert.equal(await js(`document.getElementById('message-input').value`), "等待中后来输入");
    });
    await check("写入失败保留原排序及输入，可再次取消", async () => {
      const before = (await store.load("b")).pinnedAt;
      flags.pinFail = true; await pin("b"); await idle(); flags.pinFail = false;
      assert.equal((await store.load("b")).pinnedAt, before);
      assert.equal(await js(`document.querySelector('.session-list-retry').hidden`), false);
      await pin("b"); await idle(); assert.equal((await store.load("b")).pinnedAt, null);
    });
    await check("保存成功后刷新失败明确提示，重试只读取列表", async () => {
      flags.listFail = true; await pin("b"); await idle();
      assert.match(await js(`document.querySelector('.session-list-status').textContent`), /已保存.*刷新失败/);
      assert.equal(await js(`document.querySelector('${row("b")} .session-pin-badge').textContent`), "置顶");
      const count = calls.length; flags.listFail = false;
      await click(".session-list-retry"); await idle(); assert.equal(calls.length, count);
      assert.deepEqual(await order(), [["b", "a"], ["c"]]);
    });
    await check("返回丢失后显式核对实际结果，不重复提交", async () => {
      flags.resultLost = true; await pin("b"); await idle(); flags.resultLost = false;
      assert.match(await js(`document.querySelector('.session-list-status').textContent`), /未确认/);
      const count = calls.length; await click(".session-list-retry"); await idle();
      assert.equal(calls.length, count); assert.deepEqual(await order(), [["a", "b"], ["c"]]);
    });
    await check("搜索保留置顶操作，Escape先收起操作区，组词时不关闭", async () => {
      await click("#session-search-toggle");
      await js(`const search=document.getElementById('session-search');search.value='待置顶';search.dispatchEvent(new Event('input'))`);
      await click(`${row("b")} .session-actions-toggle`);
      await js(`document.querySelector('.session-pin-action').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))`);
      assert.equal(await js(`document.querySelector('.session-actions-panel').hidden`), false);
      await js(`document.querySelector('.session-pin-action').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      assert.equal(await js(`document.querySelector('.session-actions-panel').hidden`), true);
      assert.equal(await js(`document.getElementById('session-search-field').hidden`), false);
      await pin("b"); await idle();
      assert.equal(await js(`document.querySelectorAll('.session-open').length`), 1);
      await click("#session-search-toggle");
    });
    await check("重载页面从真实临时存储恢复置顶，不改历史字节", async () => {
      await win.reload(); await idle();
      assert.deepEqual(await order(), [["b", "a"], ["c"]]);
      for (const [filename, content] of histories) assert.equal(await fs.readFile(filename, "utf8"), content);
    });
    await check("多置顶按时间、并列按编号，分组仍按消息活动", async () => {
      await store.update("a", workspace, state => ({ ...state, pinnedAt: 20 }));
      await store.update("b", workspace, state => ({ ...state, pinnedAt: 20 }));
      await store.update("c", other, state => ({ ...state, pinnedAt: 999 }));
      await win.reload(); await idle(); assert.deepEqual(await order(), [["a", "b"], ["c"]]);
      await store.update("b", workspace, state => ({ ...state, pinnedAt: 30 }));
      await win.reload(); await idle(); assert.deepEqual(await order(), [["b", "a"], ["c"]]);
    });
    await check("生成中禁止置顶，搜索重绘仍禁用；停止保留后来输入", async () => {
      await edit("测试发送");
      await js(`document.getElementById('message-form').requestSubmit(document.getElementById('send-button'))`);
      await until(`!document.getElementById('stop-button').disabled`);
      const count = calls.length;
      await click(`${row("b")} .session-actions-toggle`);
      await click("#session-search-toggle");
      await js(`document.getElementById('session-search').value='当前';document.getElementById('session-search').dispatchEvent(new Event('input'))`);
      assert.equal(await js(`[...document.querySelectorAll('#session-list button')].every(b=>b.disabled)`), true);
      await edit("生成中后来输入"); await click("#session-search-toggle"); await click("#stop-button"); await idle();
      assert.equal(calls.length, count);
      assert.equal(await js(`document.getElementById('message-input').value`), "生成中后来输入");
    });
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const key = async (name, code, value) => {
      await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code, windowsVirtualKeyCode: value });
      if (name === "Enter") await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "char", key: name, text: "\r", windowsVirtualKeyCode: value });
      await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: value });
    };
    await check("键盘Enter展开、Tab到动作、Escape恢复焦点", async () => {
      win.show(); win.focus(); await js(`document.querySelector('${row("b")} .session-actions-toggle').focus()`);
      await key("Enter", "Enter", 13); await key("Tab", "Tab", 9);
      assert.equal(await js(`document.activeElement.className`), "session-pin-action");
      await key("Escape", "Escape", 27);
      assert.equal(await js(`document.activeElement.className`), "session-actions-toggle");
    });
    for (const width of [1120, 760, 375]) {
      await check(`宽度${width}无横向溢出，窄窗置顶保留侧栏`, async () => {
        win.setSize(width, 820); await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        if (await js(`document.getElementById('app-sidebar').hidden`)) await click("#sidebar-toggle");
        await pin("b"); await idle();
        assert.equal(await js(`document.getElementById('app-sidebar').hidden`), false);
        assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&document.getElementById('app-sidebar').scrollWidth<=document.getElementById('app-sidebar').clientWidth+1`), true);
        await click(`${row("b")} .session-actions-toggle`);
        assert.equal(await js(`document.querySelector('${row("b")} .session-actions-panel').hidden`), false);
        await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        await fs.writeFile(path.join(temporary, `pin-${width}.png`), (await win.webContents.capturePage()).toPNG());
        await js(`document.body.click()`);
      });
    }
    await check("窄窗打开失败仍保留侧栏和输入", async () => {
      flags.openFail = true;
      await click('.session-open[data-session-id="b"]'); await idle(); flags.openFail = false;
      assert.equal(current, "a");
      assert.equal(await js(`document.getElementById('app-sidebar').hidden`), false);
      assert.equal(await js(`document.getElementById('message-input').value`), "生成中后来输入");
    });
    await check("窄窗打开会话才收起侧栏", async () => {
      await click('.session-open[data-session-id="b"]'); await idle();
      assert.equal(current, "b"); assert.equal(await js(`document.getElementById('app-sidebar').hidden`), true);
    });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(temporary, "report.json"), JSON.stringify({ passed, count: passed.length }, null, 2));
    console.log(`置顶页面 ${passed.length} 项通过，报告与截图：${temporary}`);
  } finally { win.destroy(); }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

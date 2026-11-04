const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createProjectStore } = require("../../src/main/storage/project-store.js");
const { createProjectService } = require("../../src/main/services/project-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);
const temporary = mkdtempSync(path.join(os.tmpdir(), "project-rename-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");

async function main() {
  const workspace = path.join(temporary, "workspace");
  const other = path.join(temporary, "other");
  await fs.mkdir(workspace); await fs.mkdir(other);
  const storagePath = path.join(temporary, "projects.json");
  const store = createProjectStore(storagePath);
  const project = await store.add(workspace), another = await store.add(other);
  const marker = path.join(workspace, "marker.txt");
  await fs.writeFile(marker, "工作文件原文");
  const flags = {}, calls = [], drafts = new Map();
  let generating = false, sendGate;
  const draft = () => drafts.get("a") ?? { sessionId: "a", text: "保留输入\n第二行  ", revision: 0 };
  const projects = createProjectService({
    list: async () => { if (flags.listFail) throw Error("模拟读取失败"); return store.list(); },
    async rename(id, name) {
      calls.push(["rename", id, name]);
      if (flags.gate) await flags.gate.promise;
      if (flags.renameFail) throw Error("模拟写入失败");
      const result = await store.rename(id, name);
      if (flags.resultLost) throw Error("模拟返回丢失");
      return result;
    },
  }, () => assert.fail("不应选择目录"), { openWorkspace: () => assert.fail("不应打开项目") });
  const sessions = [{ id: "a", title: "原聊天", workspaceDir: workspace, updatedAt: 10 }];
  const session = {
    currentSession: async () => "a", loadHistory: async () => [{ role: "user", text: "原聊天内容" }],
    listSessions: async () => sessions, listUnsentSessions: async () => [],
    getSessionInfo: async () => ({ sessionId: "a", workspaceDir: workspace, provider: "test", modelId: "mock", contextUsage: null }),
    listModels: async () => ({ provider: "test", modelId: "mock", models: [{ id: "mock", name: "原模型", provider: "test" }] }),
  };
  const chat = {
    isBusy: () => generating, listProposals: async () => [{ id: "file" }],
    async send(_text, _delta, _tool, _status, request, ack) {
      generating = true; sendGate = Promise.withResolvers();
      const consumed = { sessionId: "a", text: "", revision: request.revision + 1, sendId: "send" };
      drafts.set("a", consumed); ack(consumed); await sendGate.promise; generating = false;
      return { stopped: true, outcome: "stopped", draft: consumed };
    },
    stop: async () => sendGate.resolve(),
  };
  registerAgentIpc(ipcMain, session, chat, {
    review: async () => ({ kind: "create-proposal", path: "mock.txt", content: "保留文件草稿" }),
  }, {}, {}, {}, projects, {
    loadCurrentDraft: async () => draft(),
    inspectSend: async () => ({ ...draft(), pendingSend: null }),
    saveDraft: async (id, text, revision) => {
      assert.equal(id, "a"); assert.equal(revision, draft().revision);
      const saved = { sessionId: id, text, revision: revision + 1 }; drafts.set(id, saved); return saved;
    },
  }, {});
  await app.whenReady();
  const win = new BrowserWindow({ width: 1120, height: 820, show: false,
    webPreferences: { preload: path.join(root, "src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
  const errors = [], passed = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const js = source => win.webContents.executeJavaScript(source);
  const until = expression => js(`(async()=>{for(let i=0;i<400;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败:'+${JSON.stringify(expression)});})()`);
  const idle = () => until(`!document.getElementById('new-chat-button').disabled&&!document.getElementById('model-select').disabled`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const toggle = id => `.project-rename-toggle[data-project-id="${id}"]`;
  const dialog = "#project-rename-dialog";
  const open = async (id = project.id) => { await click(toggle(id)); await until(`document.querySelector('${dialog}').open`); };
  const input = value => js(`document.getElementById('project-rename-name').value=${JSON.stringify(value)};document.getElementById('project-rename-name').dispatchEvent(new Event('input'))`);
  const save = () => click(`${dialog} [type=submit]`);
  const title = id => js(`document.querySelector(${JSON.stringify(toggle(id))}).closest('summary').querySelector('.session-group-name').textContent`);
  const closed = () => until(`!document.querySelector('${dialog}').open&&!document.getElementById('new-chat-button').disabled&&document.activeElement.classList.contains('project-rename-toggle')`);
  const check = async (name, fn) => { await fn(); passed.push(name); console.log("通过", name); };
  try {
    await win.loadFile(path.join(root, "src/renderer/index.html")); await idle();
    await js(`document.getElementById('proposal-review-panel').open=true`);
    await click('#proposal-list article button'); await idle();
    const baseline = await js(`({ messages:document.getElementById('messages').textContent,input:document.getElementById('message-input').value,files:document.getElementById('proposal-list').textContent,model:document.getElementById('model-select').value })`);
    await check("已登记项目才有独立入口，点击不打开项目、不折叠分组", async () => {
      assert.equal(await js(`document.querySelectorAll('.project-rename-toggle').length`), 2);
      const wasOpen = await js(`document.querySelector('.session-group').open`);
      await open(); assert.equal(await js(`document.querySelector('.session-group').open`), wasOpen);
      assert.equal(await js(`document.activeElement.id`), "project-rename-name");
      assert.equal(await js(`document.getElementById('project-rename-name').value`), "workspace");
      await click(`${dialog} [data-cancel]`);
    });
    await check("取消不写盘，返回项目操作按钮焦点", async () => {
      await open(); await input("取消的名称"); await click(`${dialog} [data-cancel]`); await closed();
      assert.equal(calls.length, 0); assert.equal(await title(project.id), "workspace");
      assert.equal(await js(`document.activeElement.dataset.projectId`), project.id);
    });
    await check("空白与过长名称显示行内错误，不发请求", async () => {
      await open();
      for (const name of ["   ", "长".repeat(41)]) {
        await input(name); await save();
        assert.match(await js(`document.getElementById('project-rename-error').textContent`), /1～40/);
        assert.equal(await js(`document.getElementById('project-rename-name').getAttribute('aria-invalid')`), "true");
      }
      assert.equal(calls.length, 0); await click(`${dialog} [data-cancel]`);
    });
    await check("写入失败保留填写内容和原名称，修正后可重试", async () => {
      await open(); await input(" 新项目 "); flags.renameFail = true; await save();
      await until(`document.getElementById('project-rename-error').textContent.includes('模拟写入失败')`); await idle();
      assert.equal(await js(`document.getElementById('project-rename-name').value`), " 新项目 ");
      assert.equal(await title(project.id), "workspace");
      flags.renameFail = false; await save(); await closed(); assert.equal(await title(project.id), "新项目");
    });
    await check("成功仅改名称，聊天、输入、模型和文件草稿不变，落盘重建可读", async () => {
      assert.deepEqual(await js(`({ messages:document.getElementById('messages').textContent,input:document.getElementById('message-input').value,files:document.getElementById('proposal-list').textContent,model:document.getElementById('model-select').value })`), baseline);
      assert.deepEqual(await createProjectStore(storagePath).list(), [{ ...project, name: "新项目" }, another]);
      assert.equal(await fs.readFile(marker, "utf8"), "工作文件原文");
      assert.equal(await js(`document.activeElement.dataset.projectId`), project.id);
    });
    await check("保存中禁止重复提交和取消，等待完成再释放操作", async () => {
      await open(); await input("等待保存"); const gate = flags.gate = Promise.withResolvers();
      const before = calls.length; await save(); await until(`document.querySelector('${dialog} [type=submit]').disabled`);
      await save(); await click(`${dialog} [data-cancel]`);
      assert.equal(calls.length, before + 1); assert.equal(await js(`document.querySelector('${dialog}').open`), true);
      gate.resolve(); delete flags.gate; await closed();
    });
    await check("已保存但列表读取失败仍展示新名称，重试只读", async () => {
      await open(); await input("确认保存"); flags.listFail = true; await save(); await closed();
      assert.equal(await title(project.id), "确认保存");
      assert.match(await js(`document.querySelector('#project-panel [role=status]').textContent`), /已保存/);
      const count = calls.length; flags.listFail = false; await click('#reload-projects-button');
      await until(`document.getElementById('reload-projects-button').hidden`); assert.equal(calls.length, count);
    });
    await check("返回丢失先只读核对，已落盘不重复写入", async () => {
      await open(); await input("返回丢失已保存"); flags.resultLost = true;
      const count = calls.length; await save(); await closed(); flags.resultLost = false;
      assert.equal(await title(project.id), "返回丢失已保存"); assert.equal(calls.length, count + 1);
    });
    await check("结果和读取都失败时保留表单，专用核对不重发", async () => {
      await open(); await input("等待核对"); flags.resultLost = true; flags.listFail = true;
      const count = calls.length; await save();
      await until(`!document.querySelector('${dialog} [data-check]').hidden&&!document.querySelector('${dialog} [data-check]').disabled`);
      assert.equal(await js(`document.querySelector('${dialog} [type=submit]').disabled`), true);
      flags.resultLost = false; flags.listFail = false; await click(`${dialog} [data-check]`); await closed();
      assert.equal(await title(project.id), "等待核对"); assert.equal(calls.length, count + 1);
    });
    await check("名称安全展示、40字边界、空项目重命名，重载保留", async () => {
      const name = '<img src=x onerror="alert(1)">';
      await open(); await input(name); await save(); await closed();
      assert.equal(await title(project.id), name);
      assert.equal(await js(`document.querySelectorAll('#session-list img').length`), 0);
      await open(another.id); await input("名".repeat(40)); await save(); await closed();
      assert.equal(await title(another.id), "名".repeat(40));
      await win.reload(); await idle(); await until(`document.querySelectorAll('.project-rename-toggle').length===2`);
      assert.equal(await title(project.id), name); assert.equal(await title(another.id), "名".repeat(40));
      assert.equal(await js(`document.getElementById('message-input').value`), baseline.input);
    });
    await win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const key = async (key, code, value) => {
      await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: value });
      if (key === "Enter") await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "char", key, text: "\r", windowsVirtualKeyCode: value });
      await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: value });
    };
    await check("键盘Enter打开、Tab可达、Escape取消及组词保护", async () => {
      win.show(); win.focus();
      await js(`document.querySelector(${JSON.stringify(toggle(project.id))}).focus()`); await key("Enter", "Enter", 13);
      await until(`document.querySelector('${dialog}').open`);
      const count = calls.length;
      assert.equal(await js(`!document.getElementById('project-rename-name').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))`), true);
      assert.equal(await js(`!document.getElementById('project-rename-name').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true}))`), true);
      assert.equal(calls.length, count);
      await key("Tab", "Tab", 9); assert.equal(await js(`document.activeElement.hasAttribute('data-cancel')`), true);
      await key("Escape", "Escape", 27); await closed();
      assert.equal(await js(`document.activeElement.dataset.projectId`), project.id);
      await open(); await input("键盘保存"); await key("Enter", "Enter", 13); await closed();
      assert.equal(await title(project.id), "键盘保存");
    });
    await check("生成时入口禁用、主进程拒绝写入，停止后恢复", async () => {
      await click('#send-button'); await until(`!document.getElementById('stop-button').disabled`);
      assert.equal(await js(`[...document.querySelectorAll('.project-rename-toggle')].every(button=>button.disabled)`), true);
      await assert.rejects(js(`window.agent.renameProject(${JSON.stringify(project.id)},'不该保存')`), /请等待/);
      await click('#stop-button'); await idle();
      assert.equal(await js(`[...document.querySelectorAll('.project-rename-toggle')].every(button=>!button.disabled)`), true);
    });
    for (const width of [1120, 760, 375]) {
      await check(`${width}宽度表单、按钮与侧栏无横向溢出`, async () => {
        win.setSize(width, 820); await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        if (await js(`document.getElementById('app-sidebar').dataset.collapsed==='true'`)) await click('#sidebar-toggle');
        await open(); await input("很长的项目名称".repeat(5));
        const fit = `document.documentElement.scrollWidth<=innerWidth&&[document.querySelector('${dialog}'),document.getElementById('app-sidebar'),document.getElementById('session-list')].every(e=>e.scrollWidth<=e.clientWidth+1)&&document.querySelector('${dialog}').getBoundingClientRect().right<=innerWidth`;
        // 等待侧栏展开/收起过渡结束，避免在中间帧测量宽度。
        await until(fit);
        assert.equal(await js(fit), true);
        await fs.writeFile(path.join(temporary, `rename-${width}.png`), (await win.webContents.capturePage()).toPNG());
        await click(`${dialog} [data-cancel]`);
        if (await js(`document.getElementById('app-sidebar').dataset.collapsed==='false'`)) await click('#sidebar-toggle');
      });
    }
    await check("保存名称期间关闭先等原操作，再补存聊天输入并确认", async () => {
      if (await js(`document.getElementById('app-sidebar').dataset.collapsed==='true'`)) await click('#sidebar-toggle');
      await open(); await input("关闭前名称");
      const gate = flags.gate = Promise.withResolvers();
      await save(); await until(`document.querySelector('${dialog} [type=submit]').disabled`);
      const result = Promise.withResolvers(); let confirmed = false;
      ipcMain.once("agent:close-result", (_event, value) => { confirmed = true; result.resolve(value); });
      win.webContents.send("agent:prepare-close", "rename-close");
      await until(`document.getElementById('window-close-dialog').open`);
      assert.equal(confirmed, false);
      gate.resolve(); delete flags.gate;
      assert.deepEqual(await result.promise, { requestId: "rename-close", saved: true });
      assert.equal((await store.list())[0].name, "关闭前名称");
      assert.equal(await js(`document.getElementById('project-rename-name').disabled`), true);
    });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(temporary, "report.json"), JSON.stringify({ count: passed.length, passed }, null, 2));
    console.log(`项目重命名页面 ${passed.length} 项通过，报告：${temporary}`);
  } finally { win.destroy(); }
}
const timeout = setTimeout(() => { console.error("项目重命名检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch(error => { clearTimeout(timeout); console.error(error); app.exit(1); });

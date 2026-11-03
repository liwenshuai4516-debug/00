const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { app, BrowserWindow, ipcMain } = require("electron");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = path.resolve(__dirname, "../..");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sidebar-layout-check-"));
  await mkdir(path.join(temporary, "user-data", "Shared Dictionary", "cache"), { recursive: true });
  app.setPath("userData", path.join(temporary, "user-data"));
  app.setPath("sessionData", path.join(temporary, "user-data"));
  await app.whenReady();
  const projects = [
    { id: "a", name: "演示项目", workspaceDir: "/demo/a" },
    { id: "b", name: "未创建对话的项目", workspaceDir: "/demo/b" },
  ];
  const sessions = [
    { id: "a1", title: "你好", workspaceDir: "/demo/a", updatedAt: 5 },
    { id: "a2", title: "写一首古诗", workspaceDir: "/demo/a", updatedAt: 4 },
    { id: "old1", title: "旧项目会话", workspaceDir: "/history/a", updatedAt: 1 },
  ];
  const unsentSessions = [];
  let current = "a1", nextId = 0;
  let addMode = "cancel", listFail = false, openFail = false;
  let releaseAdd, finishGeneration, consumed;
  const calls = [], drafts = new Map();
  const getDraft = () => drafts.get(current) ?? { sessionId: current, text: "", revision: 0 };
  ipcMain.handle("sidebar-check", async (event, name, args) => {
    calls.push([name, args]);
    if (name === "listUnsentSessions") return unsentSessions;
    if (name === "loadHistory") return [];
    if (name === "currentSession") return current;
    if (name === "listSessions") return sessions;
    if (name === "listProposals") return [];
    if (name === "listProjects") {
      if (listFail) throw Error("模拟清单失败");
      return projects;
    }
    if (name === "getSessionInfo") return { sessionId: current, workspaceDir: "/demo/a", provider: "demo", modelId: "demo", contextUsage: null };
    if (name === "listModels") return { provider: "demo", modelId: "demo", models: [{ id: "demo", name: "演示模型", provider: "demo" }] };
    if (name === "readModelConfiguration") return { modelsPath: "/demo/pi/models.json" };
    if (name === "loadComposerDraft") return getDraft();
    if (name === "inspectComposerSend") return { ...getDraft(), pendingSend: null };
    if (name === "saveComposerDraft") {
      const draft = { sessionId: args[0], text: args[1], revision: args[2] + 1 };
      drafts.set(args[0], draft);
      return draft;
    }
    if (name === "addProject") {
      if (addMode === "hold") await new Promise(resolve => { releaseAdd = resolve; });
      if (addMode === "fail") throw Error("模拟添加失败");
      if (addMode === "cancel") return { canceled: true };
      const project = { id: "new-" + ++nextId, name: "新增项目 " + nextId, workspaceDir: "/demo/new-" + nextId };
      projects.push(project);
      return { canceled: false, project };
    }
    if (name === "openProject") {
      if (openFail) throw Error("模拟打开失败");
      current = args[0] === "a" ? "a1" : "empty-" + args[0];
      return { sessionId: current, history: [], changed: true };
    }
    if (name === "openSession") { current = args[0]; return []; }
    if (name === "newChat") { current = "fresh"; return current; }
    if (name === "sendMessage") {
      const draft = { ...getDraft(), text: "", revision: getDraft().revision + 1 };
      drafts.set(current, draft);
      consumed = { ...draft, sendId: "send-demo" };
      event.sender.send("sidebar-consumed", consumed);
      return new Promise(resolve => { finishGeneration = resolve; });
    }
    if (name === "stop") { finishGeneration({ stopped: true, outcome: "stopped", draft: consumed }); return; }
    throw Error("未登记的模拟接口：" + name);
  });
  const win = new BrowserWindow({
    width: 1120, height: 820, show: false,
    webPreferences: { preload: path.join(__dirname, "sidebar-layout.preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
  const errors = [];
  win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  const run = source => win.webContents.executeJavaScript(source);
  const wait = expression => run(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
  let passed = 0;
  const check = async (name, expression) => { assert.ok(await run(expression), name); passed++; console.log("PASS " + name); };
  const idle = () => wait(`!document.getElementById('add-project-button').disabled&&!document.getElementById('model-select').disabled`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const search = value => run(`document.getElementById('session-search').value=${JSON.stringify(value)};document.getElementById('session-search').dispatchEvent(new Event('input',{bubbles:true}))`);
  try {
    await idle();
    await check("设置入口位于侧栏底部", `document.getElementById('model-settings-button').closest('.sidebar-footer')!==null&&document.getElementById('model-settings-button').textContent.trim()==='设置'`);
    await click(".recent-sessions > summary");
    await check("最近只收起无项目对话，项目保持展示", `!document.querySelector('.recent-sessions').open&&document.querySelectorAll('.recent-sessions .session-open').length===1&&document.querySelectorAll('.session-group:not(.recent-sessions) .session-open').length===2&&document.querySelector('.session-project-open').checkVisibility()`);
    await check("侧栏移除未发送与只读历史区块", `!document.querySelector('#unsent-session-list')&&!document.querySelector('#history-preview')&&document.querySelector('#project-list-title').textContent==='项目'`);
    await click("#session-search-toggle");
    await check("搜索自动展开最近", `document.querySelector('.recent-sessions').open`);
    await click("#session-search-toggle");
    await click("#model-settings-button");
    await wait(`document.getElementById('model-settings-dialog').open&&document.getElementById('model-settings-dialog').getAttribute('aria-busy')==='false'`);
    await check("设置左侧纵向显示模型、主题与已归档，模型页使用官方配置入口", `document.querySelector('#settings-model-tab').getAttribute('aria-selected')==='true'&&document.querySelector('#settings-theme-tab').textContent.trim()==='主题'&&document.querySelector('[data-open-models]')!==null&&!document.querySelector('#model-profile-form')&&document.querySelector('#settings-archive-tab').textContent.trim()==='已归档的聊天'&&document.querySelector('[role=tablist]').getAttribute('aria-orientation')==='vertical'`);
    await click("#model-settings-dialog [data-close]");
    await check("关闭设置返回入口", `!document.getElementById('model-settings-dialog').open&&document.activeElement.id==='model-settings-button'`);
    win.setSize(390, 700);
    await click("#model-settings-button");
    await wait(`document.getElementById('model-settings-dialog').open`);
    await check("窄窗口设置内容不横向溢出", `document.querySelector('.settings-content').scrollWidth<=document.querySelector('.settings-content').clientWidth+1&&document.getElementById('model-settings-dialog').getBoundingClientRect().width<=innerWidth`);
    await click("#model-settings-dialog [data-close]");
    win.setSize(1120, 820);
    await wait(`innerWidth>760&&!document.getElementById('app-sidebar').hidden`);
    await check("移除上方已添加项目卡片，标题右侧只保留加号", `!document.querySelector('.registered-project-list')&&document.getElementById('project-list-title').textContent==='项目'&&document.querySelector('#add-project-button use').getAttribute('href')==='#icon-plus'&&document.querySelectorAll('#add-project-button').length===1`);
    await check("搜索默认收起，顶部图标有标签与展开状态", `document.getElementById('session-search-field').hidden&&document.getElementById('session-search-toggle').closest('.sidebar-brand')!==null&&document.getElementById('session-search-toggle').getAttribute('aria-expanded')==='false'&&document.getElementById('session-search-toggle').getAttribute('aria-label')==='搜索对话'`);
    await check("项目对话按登记目录归组，空项目保留，无项目对话在最后的最近中", `document.querySelectorAll('.session-group').length===3&&document.querySelector('.session-group-name').textContent==='演示项目'&&document.querySelectorAll('.session-project-open').length===2&&document.querySelectorAll('.session-open').length===3&&document.querySelector('#session-list > details:last-of-type').classList.contains('recent-sessions')&&document.querySelector('.recent-sessions .session-open').dataset.sessionId==='old1'`);
    sessions.push({ id: "old2", title: "独立对话", workspaceDir: "/history/other", updatedAt: 8 });
    await click(".session-project-open"); await idle();
    await check("不同目录的无项目对话平铺在最近，按活动排序", `[...document.querySelectorAll('.recent-sessions .session-open')].map(b=>b.dataset.sessionId).join(',')==='old2,old1'&&document.querySelectorAll('.session-group').length===3`);
    sessions.pop();
    await click(".session-project-open"); await idle();
    await run(`document.getElementById('message-input').value='保留输入  ';document.getElementById('message-input').dispatchEvent(new Event('input'));document.getElementById('proposal-list').textContent='保留文件草稿'`);
    const opensBefore = calls.filter(c => c[0] === "openProject" || c[0] === "openSession").length;
    await click(".session-group summary");
    await click("#session-search-toggle");
    await check("点击搜索图标展开并聚焦", `!document.getElementById('session-search-field').hidden&&document.activeElement.id==='session-search'&&document.getElementById('session-search-toggle').getAttribute('aria-expanded')==='true'`);
    await search("古诗");
    await check("标题搜索只显示命中会话并展开", `document.querySelectorAll('.session-group').length===1&&document.querySelector('.session-group').open&&document.querySelector('.session-group-items button').textContent==='写一首古诗'`);
    await click("#session-search-toggle");
    await check("收起搜索清除筛选，恢复折叠和焦点，保留聊天草稿", `document.getElementById('session-search-field').hidden&&document.getElementById('session-search').value===''&&document.querySelectorAll('.session-group').length===3&&!document.querySelector('.session-group').open&&document.activeElement.id==='session-search-toggle'&&document.getElementById('message-input').value==='保留输入  '&&document.getElementById('proposal-list').textContent==='保留文件草稿'`);
    assert.equal(calls.filter(c => c[0] === "openProject" || c[0] === "openSession").length, opensBefore);
    await click("#session-search-toggle");await search("不存在");
    await check("无结果有提示", `document.querySelector('.session-list-empty').textContent.includes('没有匹配')`);
    await run(`document.getElementById('session-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))`);
    await check("输入法Escape不关闭搜索", `!document.getElementById('session-search-field').hidden`);
    await run(`document.getElementById('session-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await check("Escape先关闭搜索并保留侧栏", `document.getElementById('session-search-field').hidden&&!document.getElementById('app-sidebar').hidden&&document.activeElement.id==='session-search-toggle'`);
    const addCount = calls.filter(c => c[0] === "addProject").length;
    addMode = "hold";await click("#add-project-button");await wait(`document.getElementById('add-project-button').disabled`);
    await click("#add-project-button");
    assert.equal(calls.filter(c => c[0] === "addProject").length, addCount + 1);
    await check("添加期间禁用重复和项目/对话切换", `document.getElementById('new-chat-button').disabled&&[...document.querySelectorAll('#session-list button')].every(b=>b.disabled)`);
    addMode = "cancel";releaseAdd();await idle();
    await check("取消添加不改变输入和文件草稿，焦点返回加号", `document.getElementById('message-input').value==='保留输入  '&&document.getElementById('proposal-list').textContent==='保留文件草稿'&&document.activeElement.id==='add-project-button'`);
    addMode = "fail";await click("#add-project-button");await idle();
    await check("添加失败在项目入口显示错误并可再次添加", `document.querySelector('#project-panel [role=status]').textContent.includes('添加失败')&&!document.querySelector('#project-panel [role=status]').classList.contains('sr-only')`);
    addMode = "add";await click("#add-project-button");await idle();
    await check("新增空项目立即进入统一分组，成功提示不占常驻布局", `document.querySelectorAll('.session-group').length===4&&[...document.querySelectorAll('.session-project-open')].some(b=>b.textContent==='新增项目 1')&&document.querySelector('#project-panel [role=status]').classList.contains('sr-only')`);
    listFail = true;await click("#add-project-button");await idle();
    await check("登记成功后列表失败保留旧分组，显示重试", `!document.getElementById('reload-projects-button').hidden&&document.querySelectorAll('.session-group').length===4&&document.querySelector('#project-panel [role=status]').textContent.includes('项目已添加')`);
    listFail = false;await click("#reload-projects-button");await idle();
    await check("重试恢复项目，按目录不重复", `document.getElementById('reload-projects-button').hidden&&document.querySelectorAll('.session-group').length===5`);
    openFail = true;await click(".session-project-open");await idle();
    await check("项目打开失败保留输入，错误可见", `document.getElementById('message-input').value==='保留输入  '&&document.querySelector('#project-panel [role=status]').textContent.includes('打开失败')&&!document.querySelector('#project-panel [role=status]').classList.contains('sr-only')`);
    openFail = false;
    // 通过实际键盘事件打开空项目，名称按钮不同时折叠分组。
    win.show();
    win.focus();
    await run(`document.querySelectorAll('.session-project-open')[1].focus()`);
    await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "char", key: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await wait(`document.getElementById('message-input').value===''`);await idle();
    assert.equal(current, "empty-b");
    await check("项目名支持键盘打开，项目分组保留", `document.querySelectorAll('.session-group')[1].open&&document.querySelectorAll('.session-group').length===5`);
    await run(`document.querySelector('.session-group summary').click()`); // 展开原项目
    await click(".session-project-open");await idle();
    await check("打开原项目恢复原输入且不串会话", `document.getElementById('message-input').value==='保留输入  '`);
    // 历史会话仍从原列表打开。
    await run(`const b=[...document.querySelectorAll('.session-group-items button')].find(b=>b.textContent==='写一首古诗');b.click()`);await idle();
    assert.equal(current, "a2");
    await check("对话行继续使用原会话打开入口", `document.querySelector('.session-group-items button[aria-current=true]').textContent==='写一首古诗'`);
    if (!await run(`document.querySelector('.recent-sessions').open`)) await click('.recent-sessions > summary');
    await click('.recent-sessions .session-open'); await idle();
    await check("无项目对话可以直接打开，仍保留在最近", `document.querySelector('.recent-sessions .session-open[aria-current=true]').dataset.sessionId==='old1'`);
    projects.push({ id: "safe", name: '<img src=x onerror="window.injected=true">', workspaceDir: "/demo/safe" });
    await click("#add-project-button");await idle();
    await check("项目名称纯文本展示", `!document.querySelector('#session-list img')&&!window.injected&&[...document.querySelectorAll('.session-project-open')].some(b=>b.textContent.includes('<img'))`);
    projects.pop(); // 清理新增正常项，再清理攻击样例
    projects.pop();
    // 通过重载清单恢复截图数据。
    addMode = "add";await click("#add-project-button");await idle();
    for (const width of [1400, 900, 390]) {
      win.setSize(width, 820);
      await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      if (await run(`document.getElementById('app-sidebar').hidden`)) await click("#sidebar-toggle");
      await check(`窗口${width}侧栏布局无横向溢出，加号在标题右侧`, `document.documentElement.scrollWidth<=innerWidth&&document.getElementById('app-sidebar').scrollWidth<=document.getElementById('app-sidebar').clientWidth+1&&document.getElementById('add-project-button').getBoundingClientRect().left>document.getElementById('project-list-title').getBoundingClientRect().right`);
    }
    // 窄窗口打开项目成功后回到聊天；正常搜索关闭不抢侧栏。
    await click(".session-project-open");await idle();
    await check("窄窗口项目打开后返回聊天", `document.getElementById('app-sidebar').hidden`);
    win.setSize(1120, 820);await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await run(`document.getElementById('message-input').value='测试生成';document.getElementById('message-input').dispatchEvent(new Event('input'));document.getElementById('message-form').requestSubmit(document.getElementById('send-button'))`);
    await wait(`!document.getElementById('stop-button').disabled`);
    await check("生成期间加号和项目切换禁用，搜索仍可查看", `document.getElementById('add-project-button').disabled&&[...document.querySelectorAll('#session-list button')].every(b=>b.disabled)&&!document.getElementById('session-search-toggle').disabled`);
    await click("#session-search-toggle");await search("你好");
    await check("生成中搜索重绘仍保持项目和会话禁用", `[...document.querySelectorAll('#session-list button')].every(b=>b.disabled)`);
    await click("#session-search-toggle");await click("#stop-button");await idle();
    await check("停止后控件恢复", `!document.getElementById('add-project-button').disabled&&[...document.querySelectorAll('#session-list button')].every(b=>!b.disabled)`);
    unsentSessions.push({ id:'a1',title:'重复草稿',workspaceDir:'/demo/a',blockedReason:'' }, { id:'draft-alone',title:'独立输入',workspaceDir:'/draft/one',blockedReason:'' }, { id:'blocked-alone',title:'待核对输入',workspaceDir:'/draft/two',blockedReason:'仍有待确认发送，暂不能重建。' });
    await click('#new-chat-button'); await idle();
    await check("有历史优先历史，空对话并入最近且受阻项明确禁用", `document.querySelectorAll('.session-open[data-session-id=a1]').length===1&&!document.querySelector('.session-open[data-session-id=a1]').hasAttribute('data-empty-session')&&document.querySelector('.recent-sessions .session-open[data-session-id=draft-alone]').dataset.emptySession==='true'&&document.querySelector('.recent-sessions .session-open[data-session-id=blocked-alone]').disabled&&document.querySelector('.session-blocked-reason').textContent.includes('待确认')`);
    unsentSessions.length=0;
    await click('.session-project-open'); await idle();
    if (!await run(`document.querySelector('.recent-sessions').open`)) await click('.recent-sessions > summary');
    await writeFile(path.join(temporary, "sidebar-preview.png"), (await win.webContents.capturePage()).toPNG());
    if (process.env.SIDEBAR_SCREENSHOT_PATH) await writeFile(process.env.SIDEBAR_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log(`侧栏布局 ${passed} 项检查通过。`);
  } finally {
    win.destroy();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

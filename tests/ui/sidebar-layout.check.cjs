const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { rm, writeFile } = require("node:fs/promises");
const http = require("node:http");
const { app, BrowserWindow, ipcMain } = require("electron");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
// sessionData 必须在 ready 前设置，异步建目录会让 Chromium 抢先初始化。
const temporary = mkdtempSync(path.join(os.tmpdir(), "sidebar-layout-check-"));
mkdirSync(path.join(temporary, "user-data"), { recursive: true });
app.setPath("userData", path.join(temporary, "user-data"));
app.setPath("sessionData", path.join(temporary, "user-data"));

async function main() {
  const root = path.resolve(__dirname, "../..");
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
  const environments = [
    { id: "a", name: "演示项目", workspaceDir: "/demo/a", address: "https://demo.invalid", account: "demo", passwordConfigured: true },
    { id: "b", name: "未创建对话的项目", workspaceDir: "/demo/b", address: "", account: "", passwordConfigured: false },
  ];
  let testData = [
    { path: "ui/cases/demo.spec.cjs", name: "demo.spec.cjs", category: "ui", size: 2048, modifiedAt: 1762300000000 },
    { path: "ui/cases/demo.md", name: "demo.md", category: "ui", size: 512, modifiedAt: 1762200000000 },
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
    if (name === "searchSessions") {
      const query = String(args[0] ?? "");
      return query.includes("断言基线")
        ? { items: [{ id: "old1", matches: 2, snippet: "…旧项目会话包含断言基线…" }], truncated: false }
        : { items: [], truncated: false };
    }
    if (name === "listProposals") return [];
    if (name === "listProjects") {
      if (listFail) throw Error("模拟清单失败");
      return projects;
    }
    if (name === "listProjectEnvironments") return environments;
    if (name === "saveProjectEnvironment") {
      const environment = environments.find((item) => item.id === args[0]);
      if (!environment) throw Error("未找到项目环境");
      environment.name = args[1].name;
      environment.address = String(args[1].address ?? "").trim();
      environment.account = args[1].account;
      if (Object.hasOwn(args[1], "password")) {
        environment.passwordConfigured = args[1].password.length > 0;
      }
      return environment;
    }
    if (name === "deleteProjectEnvironment") {
      const index = environments.findIndex((item) => item.id === args[0]);
      if (index < 0) throw Error("未找到项目环境");
      const [removed] = environments.splice(index, 1);
      const projectIndex = projects.findIndex((item) => item.id === removed.id);
      if (projectIndex >= 0) projects.splice(projectIndex, 1);
      return { id: removed.id, name: removed.name };
    }
    if (name === "openBrowserDevTools") return undefined;
    if (name === "openExternalUrl") {
      if (!/^https?:\/\//i.test(args[0])) throw Error("只支持 http(s) 地址。");
      return undefined;
    }
    if (name === "listWorkspaceDirectory") {
      if (args[0] === "src") throw Error("目录不存在或不可读。");
      if (args[0] === "docs") {
        return { path: "docs", truncated: false, entries: [
          { name: "需求.md", path: "docs/需求.md", type: "file", size: 48 },
          { name: "cases.md", path: "docs/cases.md", type: "file", size: 20 },
        ] };
      }
      return { path: "", truncated: false, entries: [
        { name: "docs", path: "docs", type: "dir", size: 0 },
        { name: "src", path: "src", type: "dir", size: 0 },
        { name: "README.md", path: "README.md", type: "file", size: 120 },
      ] };
    }
    if (name === "readPreviewFile") {
      if (args[0] === "docs/missing.md") throw Error("文件不存在或不可读。");
      return { path: args[0], size: 48, content: "# 需求文档\n\n- **本地预览**\n" };
    }
    if (name === "listTestData") {
      if (args[0] !== "a") return { available: false, truncated: false, items: [], catalog: { total: 0, page: 1, pages: 1, pageSize: 50, cases: [] } };
      return {
        available: true,
        truncated: false,
        items: testData.map((item) => ({ ...item })),
        catalog: { total: 1, page: 1, pages: 1, pageSize: 50, cases: [{
          caseId: "demo", title: "T1 演示用例", modulePath: ["演示模块"], role: "管理员", currentRevision: "0001", displayRevision: "0001", candidates: [], assetHash: "demo-hash", runnable: true,
          lastResult: { status: "passed", finishedAt: "2026-11-04T06:51:00.000Z", runId: "run-1" },
        }] },
      };
    }
    if (name === "getTestCase") {
      return { assetHash: "demo-hash", revision: "0001", currentRevision: "0001", revisions: [{ revision: "0001", taskId: "task-demo", validatedRunId: "run-1" }], meta: {
        targetUrl: "https://demo.invalid", role: "管理员", initialState: "列表", dataStrategy: "read-only", cleanup: "none", steps: [], assertions: [],
        expected: [{ id: "E1", text: "演示断言", source: { kind: "baseline", reference: "演示基线" } }],
      } };
    }
    if (name === "deleteTestData") {
      const index = testData.findIndex((item) => item.path === args[1]);
      if (index < 0) throw Error("测试数据已不存在");
      testData.splice(index, 1);
      return { path: args[1] };
    }
    if (name === "getSessionInfo") return { sessionId: current, workspaceDir: "/demo/a", provider: "demo", modelId: "demo", contextUsage: null };
    if (name === "listModels") return { provider: "demo", modelId: "demo", models: [{ id: "demo", name: "演示模型", provider: "demo" }] };
    if (name === "readModelConfiguration") return { modelsPath: "/demo/pi/models.json" };
    if (name === "readModelCatalog") return { providers: [], options: { api: [], thinkingLevels: [], inputs: [] } };
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
      environments.push({ id: project.id, name: project.name, workspaceDir: project.workspaceDir, address: "", account: "", passwordConfigured: false });
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
    webPreferences: { preload: path.join(__dirname, "sidebar-layout.preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webviewTag: true },
  });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
  const errors = [];
  win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  // 浏览器检查使用本地页面，避免测试访问外网。
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>本地页面</title></head><body><h1>ok</h1></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const run = source => win.webContents.executeJavaScript(source);
  const wait = expression => run(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
  let passed = 0;
  const check = async (name, expression) => { assert.ok(await run(expression), name); passed++; console.log("PASS " + name); };
  const idle = () => wait(`!document.getElementById('add-project-button').disabled&&!document.getElementById('model-select').disabled`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const search = value => run(`document.getElementById('session-search').value=${JSON.stringify(value)};document.getElementById('session-search').dispatchEvent(new Event('input',{bubbles:true}))`);
  try {
    await idle();
    win.setSize(1523, 900);
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await check("宽窗口聊天输入区使用更多横向空间", `(()=>{const r=document.querySelector('.composer').getBoundingClientRect();return r.width>=1100&&r.width<=1440&&r.left>=0&&r.right<=innerWidth;})()`);
    if (process.env.CHAT_WIDE_SCREENSHOT_PATH) {
      await writeFile(process.env.CHAT_WIDE_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await click("#sidebar-toggle");
    await run(`new Promise(r=>setTimeout(r,400))`);
    await check("宽窗口收起侧栏后聊天列接近窗口宽度", `(()=>{const r=document.querySelector('.composer').getBoundingClientRect();return r.width>=1300&&r.width<=1440&&r.left<200&&innerWidth-r.right<100;})()`);
    if (process.env.CHAT_WIDE_COLLAPSED_SCREENSHOT_PATH) {
      await writeFile(process.env.CHAT_WIDE_COLLAPSED_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await click(".sidebar__rail [data-sidebar-expand]");
    await run(`new Promise(r=>setTimeout(r,400))`);
    win.setSize(1120, 820);
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
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
    await check("设置左侧纵向显示模型、主题与已归档，模型页使用官方配置入口", `document.querySelector('#settings-model-tab').getAttribute('aria-selected')==='true'&&document.querySelector('#settings-theme-tab').textContent.trim()==='主题'&&document.querySelector('[data-open-models]')!==null&&!document.querySelector('#model-profile-form')&&document.querySelector('#settings-archive-tab').textContent.trim()==='已归档的聊天'&&document.querySelector('#model-settings-dialog [role=tablist]').getAttribute('aria-orientation')==='vertical'`);
    await click("#model-settings-dialog [data-close]");
    await check("关闭设置返回入口", `!document.getElementById('model-settings-dialog').open&&document.activeElement.id==='model-settings-button'`);
    win.setSize(390, 700);
    await click("#model-settings-button");
    await wait(`document.getElementById('model-settings-dialog').open`);
    await check("窄窗口设置内容不横向溢出", `document.querySelector('.settings-content').scrollWidth<=document.querySelector('.settings-content').clientWidth+1&&document.getElementById('model-settings-dialog').getBoundingClientRect().width<=innerWidth`);
    await click("#model-settings-dialog [data-close]");
    win.setSize(1120, 820);
    await wait(`innerWidth>1024&&document.getElementById('app-sidebar').dataset.collapsed==='false'`);
    await check("移除上方已添加项目卡片，标题右侧只保留加号", `!document.querySelector('.registered-project-list')&&document.getElementById('project-list-title').textContent==='项目'&&document.querySelector('#add-project-button use').getAttribute('href')==='#icon-plus'&&document.querySelectorAll('#add-project-button').length===1`);
    await check("搜索默认收起，顶部图标有标签与展开状态", `document.getElementById('session-search-field').hidden&&document.getElementById('session-search-toggle').closest('.sidebar__top-actions')!==null&&document.getElementById('session-search-toggle').getAttribute('aria-expanded')==='false'&&document.getElementById('session-search-toggle').getAttribute('aria-label')==='搜索对话'`);
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
    await search("断言基线");
    await wait(`document.querySelector('.session-match')!==null`);
    await check("内容搜索展示命中片段", `document.querySelector('.session-match').textContent.includes('断言基线')&&document.querySelector('.session-row[data-session-id="old1"]')!==null&&document.querySelectorAll('.session-group').length===1`);
    await search("古诗");
    await wait(`document.querySelectorAll('.session-match').length===0`);
    await click("#session-search-toggle");
    await check("收起搜索清除筛选，恢复折叠和焦点，保留聊天草稿", `document.getElementById('session-search-field').hidden&&document.getElementById('session-search').value===''&&document.querySelectorAll('.session-group').length===3&&!document.querySelector('.session-group').open&&document.activeElement.id==='session-search-toggle'&&document.getElementById('message-input').value==='保留输入  '&&document.getElementById('proposal-list').textContent==='保留文件草稿'`);
    assert.equal(calls.filter(c => c[0] === "openProject" || c[0] === "openSession").length, opensBefore);
    await click("#session-search-toggle");await search("不存在");
    await check("无结果有提示", `document.querySelector('.session-list-empty').textContent.includes('没有匹配')`);
    await run(`document.getElementById('session-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))`);
    await check("输入法Escape不关闭搜索", `!document.getElementById('session-search-field').hidden`);
    await run(`document.getElementById('session-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await check("Escape先关闭搜索并保留侧栏", `document.getElementById('session-search-field').hidden&&document.getElementById('app-sidebar').dataset.collapsed==='false'&&document.activeElement.id==='session-search-toggle'`);
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
      if (await run(`document.getElementById('app-sidebar').dataset.collapsed==='true'`)) await click("#sidebar-toggle");
      // 等待 300ms 宽度过渡收尾，再检查稳定布局，避免把展开动画误判为溢出。
      await wait(`Math.abs(document.getElementById('app-sidebar').getBoundingClientRect().width-parseFloat(document.getElementById('app-sidebar').style.width))<1`);
      await check(`窗口${width}侧栏布局无横向溢出，加号在标题右侧`, `document.documentElement.scrollWidth<=innerWidth&&document.getElementById('app-sidebar').scrollWidth<=document.getElementById('app-sidebar').clientWidth+1&&document.getElementById('add-project-button').getBoundingClientRect().left>document.getElementById('project-list-title').getBoundingClientRect().right`);
    }
    // 窄窗口验证键盘改宽、56px 轨道和图标展开。
    await run(`document.querySelector('.sidebar__resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`);
    await check("键盘可调整侧栏宽度并同步无障碍数值", `document.getElementById('app-sidebar').style.width==='296px'&&document.querySelector('.sidebar__resize').getAttribute('aria-valuenow')==='296'`);
    await run(`new Promise(r=>setTimeout(r,250))`);
    await check("宽度写入本地偏好", `JSON.parse(localStorage.getItem('agent-client:sidebar')).width===296`);
    await click("#sidebar-toggle");
    await run(`new Promise(r=>setTimeout(r,400))`);
    await check("收起后保留56px轨道并隐藏宽内容", `Math.round(document.getElementById('app-sidebar').getBoundingClientRect().width)===56&&!document.querySelector('.sidebar__rail').hidden&&document.querySelector('.sidebar__wide').hidden`);
    await click(".sidebar__rail [data-sidebar-expand]");
    await run(`new Promise(r=>setTimeout(r,400))`);
    await check("点击轨道图标展开侧栏", `document.getElementById('app-sidebar').dataset.collapsed==='false'&&!document.querySelector('.sidebar__wide').hidden&&document.getElementById('app-sidebar').scrollWidth<=document.getElementById('app-sidebar').clientWidth+1`);
    await check("轨道图标展开后焦点回到折叠按钮", `document.activeElement.id==='sidebar-toggle'`);
    // 收起时若焦点在宽内容里，应回到仍然可见的折叠按钮。
    await run(`document.querySelector('.session-group summary').focus()`);
    await click("#sidebar-toggle");
    await run(`new Promise(r=>setTimeout(r,400))`);
    await check("收起后焦点回到折叠按钮", `document.activeElement.id==='sidebar-toggle'`);
    await click(".sidebar__rail [data-sidebar-expand]");
    await run(`new Promise(r=>setTimeout(r,400))`);
    // 窄窗口打开项目成功后回到轨道；正常搜索关闭不抢侧栏。
    await click(".session-project-open");await idle();
    await check("窄窗口项目打开后返回轨道", `document.getElementById('app-sidebar').dataset.collapsed==='true'`);
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
    // 右侧栏内容按固定的两个环境与两个数据文件验证，清掉前面左栏添加用例的影响。
    environments.splice(0, environments.length,
      { id: "a", name: "演示项目", workspaceDir: "/demo/a", address: "https://demo.invalid", account: "demo", passwordConfigured: true },
      { id: "b", name: "未创建对话的项目", workspaceDir: "/demo/b", address: "", account: "", passwordConfigured: false });
    testData = [
      { path: "ui/cases/demo.spec.cjs", name: "demo.spec.cjs", category: "ui", size: 2048, modifiedAt: 1762300000000 },
      { path: "ui/cases/demo.md", name: "demo.md", category: "ui", size: 512, modifiedAt: 1762200000000 },
    ];
    projects.splice(0, projects.length,
      { id: "a", name: "演示项目", workspaceDir: "/demo/a" },
      { id: "b", name: "未创建对话的项目", workspaceDir: "/demo/b" });
    await run(`document.dispatchEvent(new CustomEvent("projects-changed"))`);
    await wait(`document.querySelectorAll('.session-project-open').length===2`);
    // 右侧边栏外壳：默认收起，按钮在会话 header 右上角，宽度规则与 DSH 一致。
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await check("右侧边栏默认收起，header 右上角显示镜像按钮", `!document.getElementById('app-right-sidebar').hasAttribute('data-open')&&document.getElementById('app-right-sidebar').getAttribute('aria-hidden')==='true'&&!document.getElementById('right-sidebar-toggle').hidden&&getComputedStyle(document.querySelector('#right-sidebar-toggle .right-sidebar__mirror')).transform!=='none'`);
    await click("#right-sidebar-toggle");
    await wait(`Math.round(document.getElementById('app-right-sidebar').getBoundingClientRect().width)===424`);
    await check("右侧边栏按 45% 与中栏 400 约束打开", `document.getElementById('app-right-sidebar').hasAttribute('data-open')&&document.getElementById('app-right-sidebar').getAttribute('aria-hidden')===null&&document.getElementById('right-sidebar-toggle').hidden&&document.activeElement.id==='right-sidebar-close'&&Math.round(document.getElementById('app-right-sidebar').getBoundingClientRect().width)===424&&document.documentElement.scrollWidth<=innerWidth`);
    await wait(`document.querySelectorAll('.right-panel__card').length===5&&document.querySelectorAll('.right-panel__card-meta')[1].textContent==='1 条用例'`);
    if (process.env.RIGHT_SIDEBAR_SCREENSHOT_PATH) await writeFile(process.env.RIGHT_SIDEBAR_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    await check("右侧栏工作台显示 logo 与五张功能卡片", `document.querySelector('.right-panel__logo')!==null&&[...document.querySelectorAll('.right-panel__card-title')].map(e=>e.textContent).join(',')==='项目环境,测试数据,测试报告,文件浏览,浏览器'&&document.querySelectorAll('.right-panel__card-meta')[0].textContent==='2 个'&&document.querySelectorAll('.right-panel__card-meta')[1].textContent==='1 条用例'&&document.querySelectorAll('.right-panel__card-meta')[2].textContent==='UI / 接口'`);

    // 浏览器：空状态、拒绝非 http(s)、加载本地页面并同步标题与地址。
    await run(`[...document.querySelectorAll('.right-panel__card')].find(b=>b.textContent.includes('浏览器')).click()`);
    await wait(`document.querySelector('.browser-bar__address')!==null`);
    await check("浏览器空状态提供地址栏且不创建 webview", `document.querySelector('webview')===null&&document.querySelector('.right-panel__browser-start')!==null`);
    await run(`document.querySelector('.browser-bar__address').value='javascript:alert(1)';document.querySelector('.browser-bar__go').click()`);
    await check("浏览器拒绝非 http(s) 地址", `document.querySelector('.right-panel__status').dataset.error===''&&document.querySelector('.right-panel__status').textContent.includes('http(s)')&&document.querySelector('webview')===null`);
    await run(`document.querySelector('.browser-bar__address').value='http://127.0.0.1:${port}/';document.querySelector('.browser-bar__go').click()`);
    await wait(`document.querySelector('webview')!==null`);
    await wait(`document.querySelector('.right-panel__nav-title').textContent==='本地页面'`);
    await check("浏览器加载本地页面并同步地址", `document.querySelector('.browser-bar__address').value.includes('127.0.0.1:${port}')&&document.querySelector('webview').getAttribute('partition')==='persist:browser-panel'`);
    await check("浏览器面板无内层卡片边框且工具栏 38px", `getComputedStyle(document.querySelector('.right-panel--browser')).padding==='0px'&&getComputedStyle(document.querySelector('.right-panel__browser')).borderTopWidth==='0px'&&Math.round(document.querySelector('.browser-bar').getBoundingClientRect().height)===38`);
    await run(`document.querySelector('.browser-bar__devtools').click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      calls.some(([name]) => name === "openBrowserDevTools"),
      "工具栏“调试”应请求打开页面开发者工具",
    );
    passed++;
    console.log("PASS 浏览器工具栏提供开发者工具入口");

    await run(`document.querySelector('.browser-bar__external').click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      calls.some(([name, args]) => name === "openExternalUrl" && String(args?.[0]).startsWith("http://127.0.0.1:")),
      "系统浏览器打开应收到当前地址",
    );
    passed++;
    console.log("PASS 浏览器可在系统浏览器中打开当前地址");
    if (process.env.RIGHT_SIDEBAR_BROWSER_SCREENSHOT_PATH) {
      // 等 webview 完成首帧再截图。
      await run(`new Promise(r=>setTimeout(r,400))`);
      await writeFile(process.env.RIGHT_SIDEBAR_BROWSER_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    // 切换视图保活：离开再回来复用同一个 webview，地址不丢。
    await run(`document.querySelector('webview').dataset.keepAlive='x'`);
    await click('.right-panel__nav .right-sidebar__icon-button');
    await wait(`document.querySelector('.right-panel__hero')!==null`);
    await run(`[...document.querySelectorAll('.right-panel__card')].find(b=>b.textContent.includes('浏览器')).click()`);
    await wait(`document.querySelector('.browser-bar__address')!==null`);
    await check("浏览器切换视图后保活并保留地址", `document.querySelector('webview')?.dataset.keepAlive==='x'&&document.querySelector('.browser-bar__address').value.includes('127.0.0.1:${port}')`);

    // 多标签：新建、各自保留页面、切换与关闭。
    await run(`document.querySelector('.browser-tabs__new').click()`);
    await wait(`document.querySelectorAll('.browser-tab').length===2`);
    await check("新建标签页显示空状态且保留原页面", `document.querySelectorAll('webview').length===1&&document.querySelector('.right-panel__browser-start')!==null&&document.querySelector('.browser-bar__address').value===''`);
    await run(`document.querySelector('.browser-bar__address').value='http://127.0.0.1:${port}/';document.querySelector('.browser-bar__go').click()`);
    await wait(`document.querySelectorAll('webview').length===2`);
    await check("标签页各自保留自己的页面", `document.querySelectorAll('.browser-tab').length===2&&document.querySelectorAll('.browser-page:not([hidden])').length===1`);
    await run(`document.querySelectorAll('.browser-tab__label')[0].click()`);
    await wait(`document.querySelectorAll('.browser-tab')[0].dataset.active==='true'`);
    await check("切回第一个标签页保留地址", `document.querySelector('.browser-bar__address').value.includes('127.0.0.1:${port}')&&document.querySelectorAll('webview')[0].closest('.browser-page').hidden===false`);
    await run(`document.querySelectorAll('.browser-tab__close')[1].click()`);
    await wait(`document.querySelectorAll('.browser-tab').length===1`);
    await check("关闭标签页销毁对应页面", `document.querySelectorAll('webview').length===1`);

    if (process.env.RIGHT_SIDEBAR_TABS_SCREENSHOT_PATH) {
      await run(`new Promise(r=>setTimeout(r,300))`);
      await writeFile(process.env.RIGHT_SIDEBAR_TABS_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    await click('.right-panel__nav .right-sidebar__icon-button');
    await wait(`document.querySelector('.right-panel__hero')!==null`);

    // 文件树：从工作台卡片进入，目录按需展开，文件点击进入预览。
    await run(`[...document.querySelectorAll('.right-panel__card')].find(b=>b.textContent.includes('文件浏览')).click()`);
    await wait(`document.querySelectorAll('.file-tree__row').length===3`);
    await check("文件树列出工作目录根，目录在前", `[...document.querySelectorAll('.file-tree__name')].map(e=>e.textContent).join(',')==='docs,src,README.md'`);
    await run(`[...document.querySelectorAll('.file-tree__row')].find(b=>b.textContent.includes('docs')).click()`);
    await wait(`document.querySelectorAll('.file-tree__group .file-tree__row').length===2`);
    await check("展开目录按需加载下一层", `[...document.querySelectorAll('.file-tree__group .file-tree__name')].map(e=>e.textContent).join(',')==='需求.md,cases.md'`);
    await run(`[...document.querySelectorAll('.file-tree__row--file')].find(b=>b.textContent.includes('需求.md')).click()`);
    await wait(`document.querySelector('.right-panel__markdown')!==null`);
    await check("文件树点击文件打开预览", `document.querySelector('.right-panel__nav-title').textContent==='需求.md'`);
    await click('.right-panel__nav .right-sidebar__icon-button');
    await wait(`document.querySelector('.file-tree')!==null`);
    await check("预览返回文件树并保留展开状态", `document.querySelectorAll('.file-tree__group .file-tree__row').length===2`);
    await click('.right-panel__nav .right-sidebar__icon-button');
    await wait(`document.querySelector('.right-panel__hero')!==null`);

    // 文件预览：页面事件打开侧栏的文件视图，Markdown 走正文清理链路。
    await run(`document.dispatchEvent(new CustomEvent('open-file-preview',{detail:{path:'docs/需求.md'}}))`);
    await wait(`document.querySelector('.right-panel__markdown')!==null`);
    await check("本地路径打开文件预览并渲染 Markdown", `document.querySelector('.right-panel__nav-title').textContent==='需求.md'&&document.querySelector('.right-panel__file-meta').textContent.includes('docs/需求.md')&&document.querySelector('.right-panel__markdown strong')!==null&&document.querySelector('.right-panel__markdown').textContent.includes('本地预览')`);
    await run(`document.dispatchEvent(new CustomEvent('session-changed'))`);
    await wait(`document.querySelector('.right-panel__hero')!==null`);
    await check("切换会话关闭旧工作目录的文件预览", `document.querySelector('.right-panel--file')===null`);
    await run(`document.dispatchEvent(new CustomEvent('open-file-preview',{detail:{path:'docs/missing.md'}}))`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('文件不存在')`);
    await check("预览失败显示主进程错误且不伪装内容", `document.querySelector('.right-panel__status').dataset.error===''&&document.querySelector('.right-panel__markdown')===null`);
    await click('.right-panel__nav .right-sidebar__icon-button');
    await wait(`document.querySelector('.right-panel__hero')!==null`);
    // 卡片在工作台加载完成后才可点击，避免时序波动导致点击落空。
    await wait(`document.querySelectorAll('.right-panel__card').length===5&&document.querySelectorAll('.right-panel__card')[0].disabled===false&&document.getElementById('right-sidebar-body').getAttribute('aria-busy')==='false'`);
    await click('.right-panel__card');
    await wait(`document.querySelectorAll('.right-panel__env').length===2`);
    await check("项目环境列出地址、账号和密码状态", `document.querySelector('.right-panel__env-url').textContent==='https://demo.invalid'&&document.querySelector('.right-panel__env-badge').textContent==='密码已配置'&&document.querySelector('.right-panel__env-meta').textContent==='账号：demo'`);
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    if (process.env.RIGHT_SIDEBAR_ENV_SCREENSHOT_PATH) await writeFile(process.env.RIGHT_SIDEBAR_ENV_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    await click('.right-panel__env .right-panel__action');
    await wait(`document.querySelector('.right-panel__form')!==null`);
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    if (process.env.RIGHT_SIDEBAR_FORM_SCREENSHOT_PATH) await writeFile(process.env.RIGHT_SIDEBAR_FORM_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('[name="address"]').value='https://edited.invalid';document.querySelector('.right-panel__form').requestSubmit()`);
    await wait(`document.querySelectorAll('.right-panel__env').length===2&&document.querySelector('.right-panel__env-url').textContent==='https://edited.invalid'`);
    await check("编辑项目环境保存后与后端配置同步", `document.querySelector('.right-panel__env-url').textContent==='https://edited.invalid'&&document.querySelector('.right-panel__status').textContent.includes('已保存')`);
    assert.equal(environments[0].address, "https://edited.invalid");
    await click('.right-panel__nav .right-sidebar__icon-button');
    await wait(`document.querySelectorAll('.right-panel__card').length===5&&document.querySelectorAll('.right-panel__card')[1].disabled===false&&document.getElementById('right-sidebar-body').getAttribute('aria-busy')==='false'`);
    await run(`document.querySelectorAll('.right-panel__card')[1].click()`);
    await wait(`document.querySelectorAll('.case-row').length===1`);
    await check("测试数据按模块和用例展示最近结果", `document.querySelectorAll('.case-row').length===1&&document.querySelector('.case-row__meta').textContent.includes('演示模块')&&document.querySelector('.case-row__status').textContent==='正式 0001'&&document.querySelector('.case-row').textContent.includes('最近回归 通过')`);
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    if (process.env.RIGHT_SIDEBAR_DATA_SCREENSHOT_PATH) await writeFile(process.env.RIGHT_SIDEBAR_DATA_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('.case-row__head').click()`);
    await wait(`document.querySelector('.case-detail')!==null`);
    await check("展开用例显示断言与来源", `document.querySelector('.case-row__body')!==null&&document.querySelector('.case-row__body').textContent.includes('演示基线')`);
    await click('.right-panel__nav .right-sidebar__icon-button');
    await wait(`document.querySelectorAll('.right-panel__card').length===5`);
    await click('.right-panel__card');
    await wait(`document.querySelectorAll('.right-panel__env').length===2`);
    await run(`document.querySelectorAll('.right-panel__env')[1].querySelector('.right-panel__action--danger').click()`);
    await wait(`document.getElementById('right-sidebar-confirm-dialog').open`);
    await click('#right-sidebar-confirm-dialog [data-confirm]');
    await wait(`document.querySelectorAll('.right-panel__env').length===1`);
    await check("删除项目环境只移除配置记录", `document.querySelectorAll('.right-panel__env').length===1&&document.querySelector('.right-panel__status').textContent.includes('已删除项目环境')`);
    assert.equal(environments.length, 1);
    assert.equal(projects.some((project) => project.id === "b"), false);
    await run(`document.querySelector('.right-panel__nav .right-sidebar__icon-button:last-of-type').click()`);
    await wait(`document.querySelector('.right-panel__form')!==null`);
    await run(`document.querySelector('[name="name"]').value='新增环境';document.querySelector('[name="address"]').value='https://new.invalid';document.querySelector('.right-panel__form').requestSubmit()`);
    await wait(`document.querySelectorAll('.right-panel__env').length===2`);
    await check("添加项目环境后进入列表", `document.querySelectorAll('.right-panel__env').length===2&&document.querySelector('.right-panel__status').textContent.includes('已保存')`);
    assert.equal(environments.some((environment) => environment.name === "新增环境"), true);
    await run(`document.querySelector('.right-sidebar__resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`);
    await check("右侧边栏键盘改宽同步无障碍数值", `document.querySelector('.right-sidebar__resize').getAttribute('aria-valuenow')==='408'`);
    await run(`new Promise(r=>setTimeout(r,250))`);
    await check("右侧边栏宽度写入本地偏好", `JSON.parse(localStorage.getItem('agent-client:right-sidebar')).width===408`);
    await click("#right-sidebar-close");
    await wait(`Math.round(document.getElementById('app-right-sidebar').getBoundingClientRect().width)===0`);
    await run(`new Promise(r=>requestAnimationFrame(r))`);
    await check("收起右侧边栏恢复 0 宽并交回焦点", `!document.getElementById('app-right-sidebar').hasAttribute('data-open')&&Math.round(document.getElementById('app-right-sidebar').getBoundingClientRect().width)===0&&!document.getElementById('right-sidebar-toggle').hidden&&document.activeElement.id==='right-sidebar-toggle'`);
    win.setSize(390, 820);
    await run(`new Promise(r=>setTimeout(r,400))`);
    await click("#right-sidebar-toggle");
    await wait(`document.getElementById('app-right-sidebar').hasAttribute('data-fullscreen')`);
    await run(`new Promise(r=>requestAnimationFrame(r))`);
    await check("窄窗打开右侧边栏自动全屏", `document.getElementById('app-right-sidebar').hasAttribute('data-fullscreen')&&Math.round(document.getElementById('app-right-sidebar').getBoundingClientRect().width)===innerWidth&&getComputedStyle(document.getElementById('app-right-sidebar')).position==='fixed'&&document.querySelector('.chat-main').hasAttribute('inert')&&document.getElementById('app-sidebar').hasAttribute('inert')`);
    await click("#right-sidebar-close");
    await wait(`!document.getElementById('app-right-sidebar').hasAttribute('data-open')`);
    await run(`new Promise(r=>requestAnimationFrame(r))`);
    await check("关闭全屏右侧边栏恢复底层交互", `!document.querySelector('.chat-main').hasAttribute('inert')&&!document.getElementById('app-sidebar').hasAttribute('inert')`);
    win.setSize(900, 820);
    await run(`new Promise(r=>setTimeout(r,400))`);
    await click("#right-sidebar-toggle");
    await wait(`document.getElementById('app-sidebar').dataset.collapsed==='true'&&Math.round(document.getElementById('app-right-sidebar').getBoundingClientRect().width)===408`);
    await check("窄于 1024 打开右侧边栏临时收起左侧栏", `document.getElementById('app-sidebar').dataset.collapsed==='true'&&Math.round(document.getElementById('app-right-sidebar').getBoundingClientRect().width)===408`);
    await click("#right-sidebar-close");
    await wait(`!document.getElementById('app-right-sidebar').hasAttribute('data-open')`);
    await click("#sidebar-toggle");
    await run(`new Promise(r=>setTimeout(r,400))`);
    win.setSize(1120, 820);
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await writeFile(path.join(temporary, "sidebar-preview.png"), (await win.webContents.capturePage()).toPNG());
    if (process.env.SIDEBAR_SCREENSHOT_PATH) await writeFile(process.env.SIDEBAR_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log(`侧栏布局 ${passed} 项检查通过。`);
  } finally {
    server.close();
    win.destroy();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

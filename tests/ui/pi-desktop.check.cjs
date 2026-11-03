const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
require("../helpers/pi-test-isolation.cjs");
const { createExtensionUiBridge } = require("../../src/main/resources/extension-ui-bridge.js");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-ui-")));
  const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent"), packageDir = path.join(root, "package with spaces");
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await fs.mkdir(path.join(root, "user-data"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  app.setPath("userData", path.join(root, "user-data"));
  await fs.writeFile(path.join(agentDir, "extensions/desktop.js"), `export default function(pi) {
    pi.registerCommand("desktop-ui", { handler: async (_args, ctx) => {
      const value = await ctx.ui.select("选择验收选项", ["甲", "乙"]);
      if (!await ctx.ui.confirm("确认验收", value)) return;
      const input = await ctx.ui.input("输入中文", "请输入");
      const edited = await ctx.ui.editor("编辑多行", input);
      ctx.ui.setStatus("ready", "桌面交互完成");
      ctx.ui.setWidget("result", [value, edited], { placement: "belowEditor" });
      ctx.ui.notify("扩展通知"); ctx.ui.setTitle("Pi 桌面验收");
      ctx.ui.setToolsExpanded(true); ctx.ui.setEditorText("建议正文");
    }});
    pi.registerCommand("desktop-timeout", { handler: async (_args, ctx) => { await ctx.ui.input("超时取消", "", { timeout: 150 }); } });
    pi.registerCommand("desktop-wait", { handler: async (_args, ctx) => { await ctx.ui.input("等待停止"); } });
    pi.registerCommand("desktop-new", { handler: async (_args, ctx) => {
      await ctx.newSession({ withSession: async fresh => fresh.ui.setEditorText("新会话建议") });
    }});
  }`);
  await fs.mkdir(path.join(packageDir, "skills/local-check"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "local-check", pi: { skills: ["./skills"] } }));
  await fs.writeFile(path.join(packageDir, "skills/local-check/SKILL.md"), "---\nname: local-check\ndescription: 本地包技能\n---\n临时测试");
  await app.whenReady();
  globalThis.fetch = async () => assert.fail("离线桌面测试不得请求模型");
  const { createPiAgent, sendMessage } = await import("../../src/main/pi-agent.mjs");
  const { closePiSession } = require("../../src/main/resources/pi-session-lifecycle.js");
  const bridge = createExtensionUiBridge();
  bridge.register(ipcMain);
  const service = createSessionService(path.join(root, "sessions"), (dir, resume, file, workspace) => createPiAgent(
    dir, resume, file, workspace, { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1" },
    undefined, undefined, undefined, { createUiContext: bridge.createContext, cancelUi: bridge.cancelSession, cancelPendingUi: bridge.cancelPending },
  ), () => cwd, async () => {});
  registerAgentIpc(ipcMain, service, { isBusy: () => false }, {}, {}, {}, {}, {}, {}, {
    readConfiguration: async () => ({ modelsPath: path.join(agentDir, "models.json") }),
  });
  let win, passed = 0;
  const errors = [], network = [];
  try {
    const session = await service.getSession();
    win = new BrowserWindow({ width: 1280, height: 860, show: Boolean(process.env.PI_UI_MANUAL_SELECT),
      webPreferences: { preload: path.resolve(__dirname, "../../src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (request, done) => { network.push(request.url); done({ cancel: true }); });
    const rendererRoot = path.resolve(__dirname, "../../src/renderer");
    const html = (await fs.readFile(path.join(rendererRoot, "index.html"), "utf8"))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace("<head>", `<head><base href="${pathToFileURL(rendererRoot + path.sep).href}">`);
    const file = path.join(root, "fixture.html");
    await fs.writeFile(file, html);
    await win.loadFile(file);
    const run = source => win.webContents.executeJavaScript(source);
    const wait = (expression, attempts = 400) => run(`(async()=>{for(let i=0;i<${attempts};i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const check = async (label, expression) => { assert.ok(await run(expression), label); passed++; console.log(`PASS ${label}`); };
    await run(`(async()=>{
      window.nativeEvents={starts:0,ends:0};
      document.addEventListener('compositionstart',()=>window.nativeEvents.starts++,true);
      document.addEventListener('compositionend',()=>window.nativeEvents.ends++,true);
      const {createExtensionUi}=await import('./components/extension-ui.js');
      window.canEdit=true;window.inputEvents=0;
      const input=document.querySelector('#message-input');input.addEventListener('input',()=>window.inputEvents++);
      window.ui=createExtensionUi(window.agent,input,{canEdit:()=>window.canEdit});await window.ui.ready;
      window.ui.setSession(${JSON.stringify(session.sessionId)});
    })()`);
    const command = sendMessage(session, "/desktop-ui", () => {}, () => {});
    await wait(`document.querySelector('.extension-dialog select')`);
    if (process.env.PI_UI_MANUAL_SELECT) {
      console.log("NATIVE_SELECT_READY：请选择乙并确认。");
      await wait(`document.querySelector('.extension-dialog h2').textContent==='确认验收'`, 60000);
    } else {
      await run(`document.querySelector('.extension-dialog select').value='乙'`);
      await click(".extension-dialog button[type=submit]");
    }
    await wait(`document.querySelector('.extension-dialog h2').textContent==='确认验收'`);
    if (process.env.PI_UI_MANUAL_SELECT) {
      await wait(`document.querySelector('.extension-dialog input')`, 60000);
      await wait(`document.querySelector('.extension-dialog textarea')`, 60000);
      console.log("NATIVE_INPUT_EVENTS", await run(`JSON.stringify(window.nativeEvents)`));
      await check("原生中文输入结果进入多行编辑", `document.querySelector('.extension-dialog textarea').value==='中文验收'`);
      await run(`window.canEdit=false`);
      await wait(`!document.querySelector('.extension-dialog').open`, 60000);
      console.log("NATIVE_DIALOGS_COMPLETED");
    } else {
      await click(".extension-dialog button[type=submit]");
      await wait(`document.querySelector('.extension-dialog input')`);
      await run(`(()=>{const input=document.querySelector('.extension-dialog input');input.value='中文组词';input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));document.querySelector('.extension-dialog form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
      await check("中文组词期间不会提前提交", `document.querySelector('.extension-dialog h2').textContent==='输入中文'`);
      await run(`document.querySelector('.extension-dialog input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
      await click(".extension-dialog button[type=submit]");
      await wait(`document.querySelector('.extension-dialog textarea')`);
      await check("多行编辑接收输入结果", `document.querySelector('.extension-dialog textarea').value==='中文组词'`);
      await run(`window.canEdit=false;document.querySelector('.extension-dialog textarea').value=${JSON.stringify("中文第一行\n第二行")}`);
      await click(".extension-dialog button[type=submit]");
    }
    await command;
    await check("输入未就绪时保留待应用正文", `document.querySelector('#message-input').value==='' && window.inputEvents===0`);
    await run(`window.canEdit=true;window.ui.refresh()`);
    await check("扩展正文只应用一次并触发输入保存事件", `document.querySelector('#message-input').value==='建议正文' && window.inputEvents===1`);
    await run(`window.ui.refresh()`);
    await check("刷新不会重复覆盖输入", `window.inputEvents===1`);
    await check("通知、状态、文本组件与标题可见", `document.title==='Pi 桌面验收' && document.querySelector('.extension-notices').textContent.includes('扩展通知') && [...document.querySelectorAll('.extension-widgets')].some(e=>e.textContent.includes('中文第一行'))`);
    await run(`document.querySelector('#messages').innerHTML='<details class="tool-message"><summary>工具</summary></details>'`);
    await wait(`document.querySelector('.tool-message').open`);
    await sendMessage(session, "/desktop-timeout", () => {}, () => {});
    await check("超时请求自动关闭", `!document.querySelector('.extension-dialog').open`);
    const waiting = sendMessage(session, "/desktop-wait", () => {}, () => {});
    await wait(`document.querySelector('.extension-dialog').open`);
    bridge.cancelAll();
    await waiting;
    await check("停止取消扩展等待", `!document.querySelector('.extension-dialog').open`);
    await sendMessage(session, "/desktop-new", () => {}, () => {});
    const next = await service.getSession();
    await run(`window.ui.setSession(${JSON.stringify(next.sessionId)})`);
    await check("会话替换后正文归属新会话", `document.querySelector('#message-input').value==='新会话建议'`);
    await run(`(async()=>{
      const {createSettingsPanel}=await import('./components/settings/settings-panel.js');
      const dialog=document.querySelector('#model-settings-dialog');
      const api={...window.agent, readModelConfiguration:async()=>({modelsPath:'/temporary/models.json'})};
      window.resources=createSettingsPanel(dialog,document.querySelector('#model-settings-button'),api,busy=>window.resources.setBusy(busy),async()=>{},text=>{if(window.rejectInsert)throw Error('请先核对输入');window.inserted=text});
      window.resources.setBusy(false);document.querySelector('#model-settings-button').click();
      document.querySelector('#settings-resources-tab').click();
    })()`);
    await wait(`document.querySelector('[data-pi-cwd]').textContent===${JSON.stringify(cwd)} && !document.querySelector('[data-pi-refresh]').disabled`);
    await run(`(()=>{
      document.querySelector('[data-pi-kind="packages"]').click();
      document.querySelector('.pi-install-section').open=true;
      document.querySelector('[data-pi-source]').value=${JSON.stringify(`pi install "${packageDir}"`)};
      document.querySelector('[data-pi-source]').dispatchEvent(new Event('input'));
    })()`);
    await check("扩展包安装表单可见且可操作", `document.querySelector('#pi-packages-view').checkVisibility() && document.querySelector('[data-pi-install]').checkVisibility() && !document.querySelector('[data-pi-install]').disabled`);
    await click("[data-pi-install]");
    await wait(`document.querySelector('[data-pi-status]').textContent.includes('配置已保存')`);
    await check("粘贴安装命令可安装含空格路径的包，并保留显式重载步骤", `document.querySelectorAll('.pi-package-row').length===1 && !document.querySelector('[data-pi-resources]').textContent.includes('本地包技能')`);
    await click("[data-pi-reload]");
    await wait(`document.querySelector('[data-pi-resources]').textContent.includes('本地包技能')`);
    await click('[data-pi-kind="skills"]');
    await run(`window.rejectInsert=true;document.querySelector('[data-pi-command="/skill:local-check"]').click()`);
    await check("输入受限时显示原因并保留设置窗口", `document.querySelector('#model-settings-dialog').open && document.querySelector('[data-pi-status]').textContent.includes('无法插入')`);
    await run(`window.rejectInsert=false;document.querySelector('[data-pi-command="/skill:local-check"]').click()`);
    await check("技能选择只插入官方命令并关闭设置", `window.inserted==='/skill:local-check ' && !document.querySelector('#model-settings-dialog').open`);
    await click("#model-settings-button");
    await wait(`document.querySelector('[data-pi-cwd]').textContent===${JSON.stringify(cwd)} && !document.querySelector('[data-pi-refresh]').disabled`);
    await click('[data-pi-kind="packages"]');
    await run(`(()=>{const row=document.querySelector('.pi-package-row');[...row.querySelectorAll('button')].find(b=>b.textContent==='筛选资源').click();document.querySelector('[data-pi-filters]').value='{"skills":[]}';})()`);
    await click("[data-pi-save-filters]");
    await wait(`document.querySelector('[data-pi-status]').textContent.includes('配置已保存')`);
    await click("[data-pi-reload]");
    await wait(`document.querySelector('[data-pi-status]').textContent==='资源已重新加载。'`);
    await check("官方空数组筛选禁用包技能", `!document.querySelector('[data-pi-resources]').textContent.includes('本地包技能')`);
    for (const width of [1280, 390]) {
      win.setSize(width, 860);
      await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await check(`资源面板 ${width} 宽度无横向溢出`, `document.querySelector('#settings-resources-panel').scrollWidth<=document.querySelector('#settings-resources-panel').clientWidth+1`);
      if (process.env.PI_UI_ARTIFACT_DIR) {
        await fs.mkdir(process.env.PI_UI_ARTIFACT_DIR, { recursive: true });
        await fs.writeFile(path.join(process.env.PI_UI_ARTIFACT_DIR, `pi-resources-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await run(`(()=>{const row=document.querySelector('.pi-package-row');[...row.querySelectorAll('button')].find(b=>b.textContent==='移除').click();})()`);
    await check("移除需要明确确认", `document.querySelector('[data-confirm-remove]')!==null && document.querySelectorAll('.pi-package-row').length===1`);
    await click("[data-confirm-remove]");
    await wait(`document.querySelectorAll('.pi-package-row').length===0 && !document.querySelector('[data-pi-refresh]').disabled`);
    assert.deepEqual(network, []);
    assert.deepEqual(errors, []);
    console.log(`Pi 桌面 ${passed} 项页面检查通过。`);
  } finally {
    bridge.cancelAll();
    await closePiSession(await service.getSession());
    win?.destroy();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

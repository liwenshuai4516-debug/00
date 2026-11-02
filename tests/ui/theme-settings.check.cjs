const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-http-cache");
app.on("window-all-closed", () => {});

function contrast(foreground, background) {
  const luminance = color => {
    const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "theme-settings-ui-"));
  await mkdir(path.join(temporary, "user-data"));
  app.setPath("userData", path.join(temporary, "user-data"));
  await app.whenReady();
  let draft = { sessionId: "theme-demo", text: "保留聊天输入", revision: 1 };
  let switches = 0, releaseSwitch;
  const profile = { id: "demo", name: "演示模型", kind: "custom", provider: "demo", modelId: "demo-model", baseUrl: "https://example.invalid/v1", authMode: "saved", hasSavedKey: true, api: "openai-completions", contextWindow: 32000, maxTokens: 2000 };
  const session = {
    loadHistory: async () => [
      { role: "user", text: "请展示代码" },
      { role: "assistant", text: '# 标题\n\n正文与 **强调**、`inline`。\n\n```javascript\n// 注释\nconst name = "樱粉";\nfunction hello() { return 42; }\n```' },
    ],
    currentSession: async () => "theme-demo", listSessions: async () => [], listUnsentSessions: async () => [],
    getSessionInfo: async () => ({ sessionId: "theme-demo", workspaceDir: "/demo", provider: "demo", modelId: "demo-model", contextUsage: null }),
    listModelProfiles: async () => ({ currentProfileId: "demo", profiles: [profile] }),
    switchModelProfile: async () => { switches++; await new Promise(resolve => { releaseSwitch = resolve; }); },
  };
  const flow = { list: () => [], subscribe: () => () => {} };
  registerAgentIpc(ipcMain, session, { isBusy: () => false, listProposals: async () => [] }, {}, {}, {}, {}, { listProjects: async () => [] }, {
    loadCurrentDraft: async () => draft, inspectSend: async () => ({ ...draft, pendingSend: null }),
    saveDraft: async (id, text, revision) => (draft = { sessionId: id, text, revision: revision + 1 }),
  }, { read: async () => ({ profiles: [profile], providers: [], defaultProfileId: "demo", encryptionAvailable: true }),
    providerAuth: async () => ({ keys: [], mode: "none" }), oauth: flow, enrichment: flow });

  let win;
  const errors = [], network = [];
  const createWindow = () => {
    win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: {
      preload: path.resolve(__dirname, "../../src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (request, done) => { network.push(request.url); done({ cancel: true }); });
  };
  const run = source => win.webContents.executeJavaScript(source);
  const wait = expression => run(`(async()=>{for(let i=0;i<400;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
  const idle = () => wait(`!document.querySelector('#model-settings-button').disabled`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const load = async () => { await win.loadFile(path.resolve(__dirname, "../../src/renderer/index.html")); await idle(); };
  const open = async () => { await click("#model-settings-button"); await wait(`document.querySelector('#model-settings-dialog').getAttribute('aria-busy')==='false'`); };
  let passed = 0;
  const check = async (label, expression) => { assert.ok(await run(expression), label); passed++; console.log("PASS " + label); };
  const frame = () => run(`new Promise(resolve=>requestAnimationFrame(()=>{for(const animation of document.getAnimations())animation.finish();requestAnimationFrame(resolve)}))`);
  try {
    createWindow(); await load();
    await check("首次使用保留默认深色，首帧主题模块阻塞渲染", `document.documentElement.dataset.theme==='dark' && getComputedStyle(document.body).backgroundColor==='rgb(24, 24, 24)' && document.querySelector('script[src="./theme/theme-preference.js"]').blocking.contains('render')`);
    await open();
    await check("主题与模型管理位于同级设置分类", `document.querySelectorAll('[role=tablist] [role=tab]').length===2 && document.querySelector('#settings-model-tab').getAttribute('aria-selected')==='true'`);
    await run(`document.querySelector('#profile-name').value='未保存的模型名称';document.querySelector('#profile-key').value='仅测试未保存值';window.originalMessage=document.querySelector('.chat-message');window.originalForm=document.querySelector('#model-profile-form');undefined;`);
    await click("#settings-theme-tab");
    await check("主题面板独立展示，模型操作和状态收起", `!document.querySelector('#settings-theme-panel').hidden && document.querySelector('#settings-model-panel').hidden && document.querySelector('.model-manager-feedback').hidden && document.querySelector('[data-refresh-official]').hidden`);
    await click('input[name="appearance-theme"][value="sakura"]');
    await check("选择樱粉立即生效并保存偏好", `document.documentElement.dataset.theme==='sakura' && localStorage.getItem('agent-client:theme')==='sakura' && document.querySelector('[data-theme-status]').textContent.includes('下次启动') && getComputedStyle(document.body).backgroundColor==='rgb(253, 242, 245)'`);
    await check("主题切换保留聊天节点、输入和未保存模型表单", `document.querySelector('.chat-message')===window.originalMessage && document.querySelector('#model-profile-form')===window.originalForm && document.querySelector('#message-input').value==='保留聊天输入' && document.querySelector('#profile-name').value==='未保存的模型名称' && document.querySelector('#profile-key').value==='仅测试未保存值'`);
    assert.equal(switches, 0);
    await click("#settings-model-tab");
    await check("返回模型管理保留编辑内容，模型页面跟随樱粉", `document.querySelector('#profile-name').value==='未保存的模型名称' && getComputedStyle(document.querySelector('.new-profile-editor')).backgroundColor==='rgb(253, 242, 245)' && getComputedStyle(document.querySelector('.model-add-provider')).backgroundColor==='rgb(219, 39, 119)' && getComputedStyle(document.querySelector('#profile-name')).color==='rgb(74, 43, 53)'`);
    const savePoint = await run(`(()=>{const rect=document.querySelector('.model-save-button').getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`);
    win.webContents.sendInputEvent({ type: "mouseMove", ...savePoint }); await frame();
    const saveColors = await run(`(()=>{const css=getComputedStyle(document.querySelector('.model-save-button'));return [css.color,css.backgroundColor]})()`);
    assert.ok(contrast(...saveColors) >= 4.5, "保存按钮悬停后文字仍可读"); passed++; console.log("PASS 主要保存按钮悬停状态可读");
    win.webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });
    await click("[data-apply]"); await wait(`document.querySelector('#settings-theme-tab').disabled`);
    await check("模型操作期间分类和主题选择共用忙碌保护", `document.querySelector('#settings-model-tab').disabled && [...document.querySelectorAll('[name=appearance-theme]')].every(input=>input.disabled)`);
    releaseSwitch(); await idle();
    await click("#settings-theme-tab");
    await run(`document.querySelector('#settings-theme-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`);
    await check("设置分类支持键盘切换和焦点跟随", `document.activeElement.id==='settings-model-tab' && !document.querySelector('#settings-model-panel').hidden`);
    await run(`document.querySelector('#settings-model-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))`);
    await check("End选择主题，输入法组词不误切换分类", `document.activeElement.id==='settings-theme-tab' && !document.querySelector('#settings-theme-panel').hidden`);
    await run(`document.querySelector('#settings-theme-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',isComposing:true,bubbles:true,cancelable:true}))`);
    await check("输入法组词保留当前分类", `document.querySelector('#settings-theme-tab').getAttribute('aria-selected')==='true'`);

    // 从实际渲染结果测量正文、次要文字、行内代码、语法高亮及主要按钮的对比度。
    const colors = await run(`(()=>{const css=e=>getComputedStyle(e);const body=css(document.body);const code=document.querySelector('.markdown-body pre');const samples=[['正文',body.color,body.backgroundColor],['次要文字',css(document.querySelector('.theme-choice small')).color,body.backgroundColor],['行内代码',css(document.querySelector('.markdown-body p code')).color,css(document.querySelector('.markdown-body p code')).backgroundColor],['主要按钮',css(document.querySelector('.model-add-provider')).color,css(document.querySelector('.model-add-provider')).backgroundColor]];for(const e of document.querySelectorAll('.hljs span'))samples.push([e.className,css(e).color,css(code).backgroundColor]);return samples})()`);
    assert.ok(colors.length > 7);
    for (const [label, foreground, background] of colors) assert.ok(contrast(foreground, background) >= 4.5, `${label}对比度不足：${contrast(foreground, background).toFixed(2)}`);
    console.log("PASS 樱粉正文、按钮与代码高亮的实际对比度"); passed++;

    for (const width of [1280, 800, 390]) {
      win.setSize(width, 860); await frame();
      await check(`主题设置${width}宽度无横向溢出`, `document.querySelector('#settings-theme-panel').scrollWidth<=document.querySelector('#settings-theme-panel').clientWidth+1 && document.querySelector('#model-settings-dialog').getBoundingClientRect().right<=innerWidth`);
      if (process.env.THEME_UI_ARTIFACT_DIR) {
        await mkdir(process.env.THEME_UI_ARTIFACT_DIR, { recursive: true });
        await writeFile(path.join(process.env.THEME_UI_ARTIFACT_DIR, `theme-settings-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    win.setSize(1280, 860);
    await click("#settings-model-tab"); await frame();
    if (process.env.THEME_UI_ARTIFACT_DIR) await writeFile(path.join(process.env.THEME_UI_ARTIFACT_DIR, "sakura-model.png"), (await win.webContents.capturePage()).toPNG());
    await click("[data-close]"); await frame();
    await check("聊天、侧栏和输入区使用樱粉表面色", `getComputedStyle(document.querySelector('.sidebar')).backgroundColor==='rgb(255, 251, 252)' && getComputedStyle(document.querySelector('.composer')).backgroundColor==='rgb(255, 251, 252)' && getComputedStyle(document.querySelector('[data-role=user] .message-body')).backgroundColor==='rgb(248, 226, 232)'`);
    if (process.env.THEME_UI_ARTIFACT_DIR) await writeFile(path.join(process.env.THEME_UI_ARTIFACT_DIR, "sakura-chat.png"), (await win.webContents.capturePage()).toPNG());
    await run(`(async()=>{const {appendMessage}=await import('./components/message-view.js');const {renderProposalDiff}=await import('./components/proposal-diff.js');appendMessage(document.querySelector('#messages'),'error','模拟错误');appendMessage(document.querySelector('#messages'),'tool','模拟工具结果');document.querySelector('#proposal-list').append(renderProposalDiff({startLine:1,oldText:'old\\n',newText:'new\\n'}));document.querySelector('#conversation-menu').open=true})()`);
    await check("菜单、工具结果、错误和文件差异使用各自主题语义色", `getComputedStyle(document.querySelector('.conversation-menu-body')).backgroundColor==='rgb(248, 226, 232)' && getComputedStyle(document.querySelector('[data-role=tool] .message-body')).backgroundColor==='rgb(248, 226, 232)' && getComputedStyle(document.querySelector('[data-role=error] .message-body')).backgroundColor==='rgb(249, 223, 228)' && getComputedStyle(document.querySelector('.proposal-diff [data-kind=add]')).backgroundColor==='rgb(221, 239, 220)' && getComputedStyle(document.querySelector('.proposal-diff [data-kind=remove]')).backgroundColor==='rgb(249, 223, 228)'`);
    await run(`document.querySelector('#conversation-menu').open=false;document.querySelector('#window-close-dialog').showModal();undefined;`);
    await check("关闭等待弹窗使用主题色，焦点可见颜色已映射", `getComputedStyle(document.querySelector('#window-close-dialog')).backgroundColor==='rgb(248, 226, 232)' && getComputedStyle(document.documentElement).getPropertyValue('--focus').trim()==='#db2777'`);
    await run(`document.querySelector('#window-close-dialog').close()`);
    await open(); await click("#settings-theme-tab"); await click('input[value="dark"][name="appearance-theme"]');
    await check("恢复深色移除樱粉影响，包括代码高亮", `getComputedStyle(document.body).backgroundColor==='rgb(24, 24, 24)' && getComputedStyle(document.querySelector('.hljs-keyword')).color!=='rgb(202, 26, 65)' && getComputedStyle(document.querySelector('.model-add-provider')).backgroundColor==='rgb(236, 236, 236)'`);
    await click('input[value="sakura"][name="appearance-theme"]');
    await run(`window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('测试存储不可用','QuotaExceededError')};undefined;`);
    await click('input[value="dark"][name="appearance-theme"]');
    await check("保存失败仍可切换，并明确提示未持久化", `document.documentElement.dataset.theme==='dark' && document.querySelector('[data-theme-status]').textContent.includes('无法读写') && localStorage.getItem('agent-client:theme')==='sakura'`);
    await run(`Storage.prototype.setItem=window.originalSetItem;undefined;`);
    await click('input[value="sakura"][name="appearance-theme"]');
    win.webContents.session.flushStorageData(); win.destroy(); createWindow(); await load();
    await check("重建窗口恢复已保存主题，代码高亮同步恢复", `document.documentElement.dataset.theme==='sakura' && getComputedStyle(document.body).backgroundColor==='rgb(253, 242, 245)' && getComputedStyle(document.querySelector('.hljs-keyword')).color==='rgb(202, 26, 65)'`);
    await run(`localStorage.setItem('agent-client:theme','../../unknown.css')`);
    await load();
    await check("未知主题编号回到默认深色，不加载任意主题路径", `document.documentElement.dataset.theme==='dark' && getComputedStyle(document.body).backgroundColor==='rgb(24, 24, 24)'`);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Page.enable");
    await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `Storage.prototype.getItem=function(){throw new DOMException('测试读取失败','SecurityError')}` });
    await load(); await open(); await click("#settings-theme-tab");
    await check("启动读取失败不会阻止设置和聊天初始化", `document.documentElement.dataset.theme==='dark' && document.querySelector('[data-theme-status]').textContent.includes('无法读写') && document.querySelector('#message-input').value==='保留聊天输入'`);
    assert.deepEqual(network, []); assert.deepEqual(errors, []);
    console.log(`主题设置 ${passed} 项页面检查通过。`);
  } finally { win?.destroy(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

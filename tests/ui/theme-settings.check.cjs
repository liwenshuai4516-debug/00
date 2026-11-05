const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
require("../../src/main/resources/extension-ui-bridge.js").createExtensionUiBridge().register(ipcMain);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-http-cache");
app.on("window-all-closed", () => {});

function contrast(foreground, background) {
  const luminance = (color) => {
    const values = color
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "theme-settings-ui-"));
  await mkdir(path.join(temporary, "user-data"));
  app.setPath("userData", path.join(temporary, "user-data"));
  await app.whenReady();
  let draft = { sessionId: "theme-demo", text: "保留聊天输入", revision: 1 };
  let switches = 0,
    releaseSwitch;


  let promptSettings = {
    version: 1,
    revision: 0,
    testAgentPrompt: "新对话默认职责",
  };
  const promptSnapshot = {
    ...promptSettings,
    origin: "new",
    testAgentPrompt: "当前对话原职责",
  };
  let releasePromptSave;
  const session = {
    getSession: async () => ({
      sessionId: "theme-demo",
      desktopPromptSnapshot: promptSnapshot,
    }),

    loadHistory: async () => [
      { role: "user", text: "请展示代码" },
      {
        role: "assistant",
        text: '# 标题\n\n正文与 **强调**、`inline`。\n\n```javascript\n// 注释\nconst name = "樱粉";\nfunction hello() { return 42; }\n```',
      },
    ],
    currentSession: async () => "theme-demo",
    listSessions: async () => [],
    listUnsentSessions: async () => [],
    getSessionInfo: async () => ({
      sessionId: "theme-demo",
      workspaceDir: "/demo",
      provider: "demo",
      modelId: "demo-model",
      contextUsage: null,
    }),
    listModels: async () => ({
      provider: "demo", modelId: "demo-model",
      models: [{ id: "demo-model", name: "演示模型", provider: "demo" }],
    }),
    setDefaultModel: async () => {
      switches++;
      await new Promise((resolve) => {
        releaseSwitch = resolve;
      });
    },
  };
  registerAgentIpc(
    ipcMain,
    session,
    { isBusy: () => false, listProposals: async () => [] },
    {},
    {},
    {},
    {},
    { listProjects: async () => [] },
    {
      loadCurrentDraft: async () => draft,
      inspectSend: async () => ({ ...draft, pendingSend: null }),
      saveDraft: async (id, text, revision) =>
        (draft = { sessionId: id, text, revision: revision + 1 }),
    },
    {
      readConfiguration: async () => ({ modelsPath: "/demo/pi/models.json" }),
      readCatalog: async () => ({
        modelsPath: "/demo/pi/models.json",
        providers: [{ id: "demo", name: "演示", baseUrl: "", api: "", models: [{ id: "demo-model", name: "演示模型" }] }],
        options: { api: ["openai-completions"], thinkingLevels: ["off", "low", "high"], inputs: ["text", "image"] },
      }),
      saveModel: async () => ({ action: "created" }),
      deleteModel: async () => ({ action: "deleted" }),
    },
    {
      read: async () => ({ ...promptSettings }),
      save: async (text, revision) => {
        assert.equal(revision, promptSettings.revision);
        await new Promise((resolve) => {
          releasePromptSave = resolve;
        });
        promptSettings = {
          version: 1,
          revision: revision + 1,
          testAgentPrompt: text,
        };
        return { ...promptSettings };
      },
    },
    {
      settings: async () => ({
        mode: "ask",
        options: [
          { id: "ask", label: "每次确认", description: "写入和命令每次确认。" },
          { id: "read-only", label: "只读", description: "阻止写入和命令。" },
          { id: "full-access", label: "完全权限", description: "全部直接执行。", risk: true },
        ],
      }),
      save: async (mode) => ({ mode, options: [
        { id: "ask", label: "每次确认", description: "写入和命令每次确认。" },
        { id: "read-only", label: "只读", description: "阻止写入和命令。" },
        { id: "full-access", label: "完全权限", description: "全部直接执行。", risk: true },
      ] }),
    },
  );

  let win;
  const errors = [],
    network = [];
  const createWindow = () => {
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      webPreferences: {
        preload: path.resolve(__dirname, "../../src/preload/preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (request, done) => {
        network.push(request.url);
        done({ cancel: true });
      },
    );
  };
  const run = (source) => win.webContents.executeJavaScript(source);
  const wait = (expression) =>
    run(
      `(async()=>{for(let i=0;i<400;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`,
    );
  const idle = () =>
    wait(`!document.querySelector('#model-settings-button').disabled`);
  const click = (selector) =>
    run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const load = async () => {
    await win.loadFile(
      path.resolve(__dirname, "../../src/renderer/index.html"),
    );
    await idle();
  };
  const open = async () => {
    await click("#model-settings-button");
    await wait(
      `document.querySelector('#model-settings-dialog').getAttribute('aria-busy')==='false'`,
    );
  };
  let passed = 0;
  const check = async (label, expression) => {
    assert.ok(await run(expression), label);
    passed++;
    console.log("PASS " + label);
  };
  const frame = () =>
    run(
      `new Promise(resolve=>requestAnimationFrame(()=>{for(const animation of document.getAnimations())animation.finish();requestAnimationFrame(resolve)}))`,
    );
  try {
    createWindow();
    await load();
    if (process.env.PERMISSION_COMPOSER_SCREENSHOT_PATH) {
      await writeFile(process.env.PERMISSION_COMPOSER_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await check(
      "提供四个任务模板，未选择时不可插入",
      `document.querySelector('#task-template-select').options.length===5 && document.querySelector('#task-template-insert').disabled`,
    );
    const beforeMessages = await run(
      `document.querySelectorAll('.chat-message').length`,
    );
    await run(
      `(()=>{const select=document.querySelector('#task-template-select');select.value='cases';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await click("#task-template-insert");
    await check(
      "插入模板保留输入并把焦点移回编辑区",
      `document.querySelector('#message-input').value.startsWith('保留聊天输入\\n\\n请依据以下资料设计测试用例。') && document.activeElement.id==='message-input'`,
    );
    await wait(
      `document.querySelector('#composer-draft-status').textContent==='输入已保存。'`,
    );
    assert.ok(draft.text.includes("测试范围：【填写】"));
    assert.equal(
      await run(`document.querySelectorAll('.chat-message').length`),
      beforeMessages,
    );

    // 输入法组词时，模板选择和插入都不可用；结束后恢复。
    await run(
      `document.querySelector('#message-input').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`,
    );
    await check(
      "组词期间模板入口禁用",
      `document.querySelector('#task-template-select').disabled && document.querySelector('#task-template-insert').disabled`,
    );
    await run(
      `document.querySelector('#message-input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`,
    );
    await check(
      "组词结束后恢复模板入口",
      `!document.querySelector('#task-template-select').disabled && !document.querySelector('#task-template-insert').disabled`,
    );

    // 恢复后续既有测试使用的输入，仍沿用真实页面输入事件与自动保存。
    await run(
      `(()=>{const input=document.querySelector('#message-input');input.value='保留聊天输入';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait(
      `document.querySelector('#composer-draft-status').textContent==='输入已保存。'`,
    );
    await check(
      "首次使用保留默认深色，首帧主题模块阻塞渲染",
      `document.documentElement.dataset.theme==='dark' && getComputedStyle(document.body).backgroundColor==='rgb(24, 24, 24)' && document.querySelector('script[src="./theme/theme-preference.js"]').blocking.contains('render')`,
    );
    await open();
    await check(
      "主题与模型管理位于同级设置分类",
      `document.querySelectorAll('[role=tablist] [role=tab]').length===6 && document.querySelector('#settings-model-tab').getAttribute('aria-selected')==='true' && !document.querySelector('#settings-general-tab').matches('[aria-selected=true]')`,
    );
    await click("#settings-general-tab");
    await wait(`document.querySelectorAll('[data-permission-mode-select] option').length===3`);
    await check(
      "通用设置打开权限控制并读取默认模式",
      `!document.querySelector('#settings-general-panel').hidden && document.querySelector('#settings-model-panel').hidden && document.querySelector('[data-permission-mode-select]').value==='ask'`,
    );
    if (process.env.PERMISSION_SETTINGS_SCREENSHOT_PATH) {
      await run("new Promise((resolve)=>setTimeout(resolve,120))");
      await writeFile(process.env.PERMISSION_SETTINGS_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await click("#settings-model-tab");
    await run(
      `window.originalMessage=document.querySelector('.chat-message');window.originalPanel=document.querySelector('#settings-model-panel');undefined;`,
    );
    await click("#settings-theme-tab");
    await check(
      "主题面板独立展示，模型操作和状态收起",
      `!document.querySelector('#settings-theme-panel').hidden && document.querySelector('#settings-model-panel').hidden && !document.querySelector('#model-profile-form')`,
    );
    await click('input[name="appearance-theme"][value="sakura"]');
    await check(
      "选择樱粉立即生效并保存偏好",
      `document.documentElement.dataset.theme==='sakura' && localStorage.getItem('agent-client:theme')==='sakura' && document.querySelector('[data-theme-status]').textContent.includes('下次启动') && getComputedStyle(document.body).backgroundColor==='rgb(253, 242, 245)'`,
    );
    await check(
      "主题切换保留聊天节点、输入和模型配置入口",
      `document.querySelector('.chat-message')===window.originalMessage && document.querySelector('#settings-model-panel')===window.originalPanel && document.querySelector('#message-input').value==='保留聊天输入'`,
    );
    assert.equal(switches, 0);
    await click("#settings-model-tab");
    await check(
      "返回模型设置保留节点，模型页面跟随樱粉",
      `document.querySelector('#settings-model-panel')===window.originalPanel && getComputedStyle(document.querySelector('#model-settings-dialog')).backgroundColor==='rgb(253, 242, 245)' && getComputedStyle(document.querySelector('[data-models-path]')).color==='rgb(125, 85, 97)'`,
    );
    await run(`document.querySelector('[data-provider-list] .model-row [data-action="default"]').click()`);
    await wait(`document.querySelector('#settings-theme-tab').disabled`);
    await check(
      "模型操作期间分类和主题选择共用忙碌保护",
      `[...document.querySelectorAll('.settings-category, [name=appearance-theme], #archive-session-search')].every(input=>input.disabled)`,
    );

    await check(
      "页面操作期间模板入口禁用",
      `document.querySelector('#task-template-select').disabled && document.querySelector('#task-template-insert').disabled`,
    );

    releaseSwitch();
    await idle();
    await click("#settings-theme-tab");
    await run(
      `document.querySelector('#settings-theme-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))`,
    );
    await check(
      "设置分类支持键盘切换和焦点跟随",
      `document.activeElement.id==='settings-model-tab' && !document.querySelector('#settings-model-panel').hidden`,
    );
    await run(
      `document.querySelector('#settings-model-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))`,
    );
    // End 跟随实际最后一项；资源面板不影响提示词内容。
    await check(
      "End选择技能与扩展包，菜单与内容对应",
      `document.activeElement.id==='settings-resources-tab' && !document.querySelector('#settings-resources-panel').hidden && document.querySelector('#model-settings-title').textContent==='技能与扩展包'`,
    );
    await click("#settings-prompt-tab");

    // 等待默认配置与当前会话快照读取完成。
    await wait(`!document.querySelector('#prompt-default').disabled`);

    await check(
      "基础规则与当前职责只读，默认职责可编辑",
      `document.querySelector('#prompt-core').readOnly &&
       document.querySelector('#prompt-current').readOnly &&
       document.querySelector('#prompt-current').value==='当前对话原职责' &&
       document.querySelector('#prompt-default').value==='新对话默认职责'`,
    );

    // 模拟用户编辑；触发 input 事件，让保存按钮更新状态。
    await run(`(()=>{
      const editor=document.querySelector('#prompt-default');
      editor.value='修改后的默认职责';
      editor.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);

    await click("[data-prompt-save]");
    await wait(`document.querySelector('#settings-prompt-tab').disabled`);

    // 模拟存储正在等待完成，检查保存期间的操作保护。
    await check(
      "提示词保存期间分类、编辑和关闭按钮均禁用",
      `document.querySelector('[data-close]').disabled &&
       document.querySelector('#prompt-default').disabled &&
       [...document.querySelectorAll('.settings-category')].every(tab=>tab.disabled)`,
    );

    await run(
      `document.querySelector('#model-settings-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))`,
    );
    await check(
      "提示词保存期间键盘取消不会关闭设置",
      `document.querySelector('#model-settings-dialog').open`,
    );

    // 解除模拟存储的等待，让保存操作完成。
    releasePromptSave();
    await wait(
      `document.querySelector('#prompt-status').textContent.includes('已保存默认修订 1')`,
    );

    await check(
      "保存默认提示词保留当前职责和聊天输入",
      `document.querySelector('#prompt-current').value==='当前对话原职责' &&
       document.querySelector('#message-input').value==='保留聊天输入' &&
       document.querySelector('[data-prompt-save]').disabled`,
    );

    // 同时核对保存接口实际收到并保存的正文。
    assert.equal(promptSettings.testAgentPrompt, "修改后的默认职责");
    // 从提示词向上移动到已归档，检查分类顺序。
    await run(
      `document.querySelector('#settings-prompt-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))`,
    );
    await check(
      "提示词上一项为已归档",
      `document.activeElement.id==='settings-archive-tab' && !document.querySelector('#settings-archive-panel').hidden`,
    );

    // 再向上回到主题，为后续输入法组词检查准备状态。
    await run(
      `document.querySelector('#settings-archive-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))`,
    );
    await run(
      `document.querySelector('#settings-theme-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',isComposing:true,bubbles:true,cancelable:true}))`,
    );
    await check(
      "两个列表操作编号互不重复，主页面不展示归档入口",
      `new Set([...document.querySelectorAll('[id]')].map(e=>e.id)).size===document.querySelectorAll('[id]').length && document.querySelector('#session-list .session-view-switch')===null && document.querySelector('#settings-archive-tab').closest('.settings-sidebar')!==null`,
    );
    await check(
      "输入法组词保留当前分类",
      `document.querySelector('#settings-theme-tab').getAttribute('aria-selected')==='true'`,
    );

    // 从实际渲染结果测量正文、次要文字、行内代码、语法高亮及主要按钮的对比度。
    const colors = await run(
      `(()=>{const css=e=>getComputedStyle(e);const body=css(document.body);const code=document.querySelector('.markdown-body pre');const samples=[['正文',body.color,body.backgroundColor],['次要文字',css(document.querySelector('.theme-choice small')).color,body.backgroundColor],['行内代码',css(document.querySelector('.markdown-body p code')).color,css(document.querySelector('.markdown-body p code')).backgroundColor],['主题卡片',css(document.querySelector('.theme-choice')).color,body.backgroundColor]];for(const e of document.querySelectorAll('.hljs span'))samples.push([e.className,css(e).color,css(code).backgroundColor]);return samples})()`,
    );
    assert.ok(colors.length > 7);
    for (const [label, foreground, background] of colors)
      assert.ok(
        contrast(foreground, background) >= 4.5,
        `${label}对比度不足：${contrast(foreground, background).toFixed(2)}`,
      );
    console.log("PASS 樱粉正文、按钮与代码高亮的实际对比度");
    passed++;

    for (const width of [1280, 800, 390]) {
      win.setSize(width, 860);
      await frame();
       await check(`模板输入区${width}宽度无横向溢出`, `document.querySelector('#message-form').scrollWidth<=document.querySelector('#message-form').clientWidth+1`);
      await check(
        `设置${width}宽度左侧纵向菜单、右侧内容`,
        `(()=>{const nav=document.querySelector('.settings-sidebar').getBoundingClientRect();const panel=document.querySelector('#settings-theme-panel').getBoundingClientRect();const tabs=[...document.querySelectorAll('.settings-category')].map(e=>e.getBoundingClientRect());return nav.right<=panel.left+1 && tabs.every((tab,i)=>!i||tab.top>=tabs[i-1].bottom) && document.querySelector('[role=tablist]').getAttribute('aria-orientation')==='vertical';})()`,
      );
      await check(
        `主题设置${width}宽度无横向溢出`,

        `document.querySelector('#settings-theme-panel').scrollWidth<=document.querySelector('#settings-theme-panel').clientWidth+1 && document.querySelector('#model-settings-dialog').getBoundingClientRect().right<=innerWidth`,
      );
      await click("#settings-prompt-tab");
      await frame();
      await check(
        `提示词设置${width}宽度无横向溢出`,
        `document.querySelector('#settings-prompt-panel').scrollWidth<=document.querySelector('#settings-prompt-panel').clientWidth+1 && document.querySelector('#model-settings-dialog').getBoundingClientRect().right<=innerWidth`,
      );
      if (process.env.THEME_UI_ARTIFACT_DIR) {
        await mkdir(process.env.THEME_UI_ARTIFACT_DIR, { recursive: true });
        await writeFile(
          path.join(
            process.env.THEME_UI_ARTIFACT_DIR,
            `prompt-settings-${width}.png`,
          ),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      await click("#settings-theme-tab");
      await frame();
      if (process.env.THEME_UI_ARTIFACT_DIR) {
        await mkdir(process.env.THEME_UI_ARTIFACT_DIR, { recursive: true });
        await writeFile(
          path.join(
            process.env.THEME_UI_ARTIFACT_DIR,
            `theme-settings-${width}.png`,
          ),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
    }
    win.setSize(1280, 860);
    await click("#settings-model-tab");
    await frame();
    if (process.env.THEME_UI_ARTIFACT_DIR)
      await writeFile(
        path.join(process.env.THEME_UI_ARTIFACT_DIR, "sakura-model.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
    await click("[data-close]");
    await frame();
    await check(
      "聊天、侧栏和输入区使用樱粉表面色",
      `getComputedStyle(document.querySelector('.sidebar')).backgroundColor==='rgb(255, 251, 252)' && getComputedStyle(document.querySelector('.composer')).backgroundColor==='rgb(255, 251, 252)' && getComputedStyle(document.querySelector('[data-role=user] .message-body')).backgroundColor==='rgb(248, 226, 232)'`,
    );
    if (process.env.THEME_UI_ARTIFACT_DIR)
      await writeFile(
        path.join(process.env.THEME_UI_ARTIFACT_DIR, "sakura-chat.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
    await run(
      `(async()=>{const {appendMessage}=await import('./components/message-view.js');const {renderProposalDiff}=await import('./components/proposal-diff.js');appendMessage(document.querySelector('#messages'),'error','模拟错误');appendMessage(document.querySelector('#messages'),'tool','模拟工具结果');document.querySelector('#proposal-list').append(renderProposalDiff({startLine:1,oldText:'old\\n',newText:'new\\n'}));document.querySelector('#conversation-menu').open=true})()`,
    );
    await check(
      "菜单、工具结果、错误和文件差异使用各自主题语义色",
      `getComputedStyle(document.querySelector('.conversation-menu-body')).backgroundColor==='rgb(248, 226, 232)' && getComputedStyle(document.querySelector('[data-role=tool] .message-body')).backgroundColor==='rgb(248, 226, 232)' && getComputedStyle(document.querySelector('[data-role=error] .message-body')).backgroundColor==='rgb(249, 223, 228)' && getComputedStyle(document.querySelector('.proposal-diff [data-kind=add]')).backgroundColor==='rgb(221, 239, 220)' && getComputedStyle(document.querySelector('.proposal-diff [data-kind=remove]')).backgroundColor==='rgb(249, 223, 228)'`,
    );
    await run(
      `document.querySelector('#conversation-menu').open=false;document.querySelector('#window-close-dialog').showModal();undefined;`,
    );
    await check(
      "关闭等待弹窗使用主题色，焦点可见颜色已映射",
      `getComputedStyle(document.querySelector('#window-close-dialog')).backgroundColor==='rgb(248, 226, 232)' && getComputedStyle(document.documentElement).getPropertyValue('--focus').trim()==='#db2777'`,
    );
    await run(`document.querySelector('#window-close-dialog').close()`);
    await open();
    await click("#settings-theme-tab");
    await click('input[value="dark"][name="appearance-theme"]');
    await check(
      "恢复深色移除樱粉影响，包括代码高亮",
      `getComputedStyle(document.body).backgroundColor==='rgb(24, 24, 24)' && getComputedStyle(document.querySelector('.hljs-keyword')).color!=='rgb(202, 26, 65)' && getComputedStyle(document.querySelector('#model-settings-dialog')).backgroundColor==='rgb(24, 24, 24)'`,
    );
    await click('input[value="sakura"][name="appearance-theme"]');
    await run(
      `window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('测试存储不可用','QuotaExceededError')};undefined;`,
    );
    await click('input[value="dark"][name="appearance-theme"]');
    await check(
      "保存失败仍可切换，并明确提示未持久化",
      `document.documentElement.dataset.theme==='dark' && document.querySelector('[data-theme-status]').textContent.includes('无法读写') && localStorage.getItem('agent-client:theme')==='sakura'`,
    );
    await run(`Storage.prototype.setItem=window.originalSetItem;undefined;`);
    await click('input[value="sakura"][name="appearance-theme"]');
    win.webContents.session.flushStorageData();
    win.destroy();
    createWindow();
    await load();
    await check(
      "重建窗口恢复已保存主题，代码高亮同步恢复",
      `document.documentElement.dataset.theme==='sakura' && getComputedStyle(document.body).backgroundColor==='rgb(253, 242, 245)' && getComputedStyle(document.querySelector('.hljs-keyword')).color==='rgb(202, 26, 65)'`,
    );
    await run(`localStorage.setItem('agent-client:theme','../../unknown.css')`);
    await load();
    await check(
      "未知主题编号回到默认深色，不加载任意主题路径",
      `document.documentElement.dataset.theme==='dark' && getComputedStyle(document.body).backgroundColor==='rgb(24, 24, 24)'`,
    );
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Page.enable");
    await win.webContents.debugger.sendCommand(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `Storage.prototype.getItem=function(){throw new DOMException('测试读取失败','SecurityError')}`,
      },
    );
    await load();
    await open();
    await click("#settings-theme-tab");
    await check(
      "启动读取失败不会阻止设置和聊天初始化",
      `document.documentElement.dataset.theme==='dark' && document.querySelector('[data-theme-status]').textContent.includes('无法读写') && document.querySelector('#message-input').value==='保留聊天输入'`,
    );
    assert.deepEqual(network, []);
    assert.deepEqual(errors, []);
    console.log(`主题设置 ${passed} 项页面检查通过。`);
  } finally {
    win?.destroy();
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

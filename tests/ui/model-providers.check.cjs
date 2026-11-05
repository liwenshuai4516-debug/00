const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-management-ui-"));
  app.setPath("userData", root);
  app.setPath("sessionData", root);
  await app.whenReady();

  const calls = [];
  let current = { provider: "alpha", id: "same" };
  let defaultSelection = { provider: "", modelId: "" };
  let info = { sessionId: "session-a", provider: "alpha", modelId: "same", thinkingLevel: "low", thinkingLevels: ["off", "low", "high"] };
  let providers = [
    {
      id: "alpha", name: "Alpha 供应商", baseUrl: "https://alpha.example.com/v1", api: "openai-completions",
      hasApiKey: true, credential: "environment", credentialDetail: "使用环境变量 ALPHA_KEY",
      models: [{ id: "same", name: "同名模型", contextWindow: 128000, maxTokens: 16384, input: ["text"], reasoning: true, thinkingLevelMap: { low: "low", high: "high" } }],
    },
    {
      id: "beta", name: "", baseUrl: "", api: "", hasApiKey: false, credential: "unknown",
      credentialDetail: "models.json 未配置 apiKey；环境变量或 auth.json 仍可能提供认证",
      models: [{ id: "same", name: "Beta 模型", input: ["text", "image"] }],
    },
  ];
  let runtimeModels = [
    { provider: "alpha", id: "same", name: "同名模型", contextWindow: 128000, maxTokens: 16384, reasoning: true, input: ["text"], thinkingLevelMap: { low: "low", high: "high" } },
    { provider: "beta", id: "same", name: "Beta 模型", input: ["text", "image"] },
  ];
  const list = () => ({
    provider: current.provider,
    modelId: current.id,
    thinkingLevel: info.thinkingLevel,
    thinkingLevels: info.thinkingLevels,
    models: runtimeModels.map((model) => ({ ...model })),
    defaultProvider: defaultSelection.provider,
    defaultModel: defaultSelection.modelId,
  });
  const catalog = () => ({
    modelsPath: "/temporary/pi/models.json",
    providers: providers.map((provider) => ({ ...provider, models: provider.models.map((model) => ({ ...model })) })),
    options: {
      api: ["openai-completions", "openai-responses", "anthropic-messages"],
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      inputs: ["text", "image"],
    },
  });

  ipcMain.handle("agent:list-models", () => list());
  ipcMain.handle("agent:session-info", () => ({ ...info, provider: current.provider, modelId: current.id }));
  ipcMain.handle("agent:read-model-configuration", () => ({ modelsPath: "/temporary/pi/models.json" }));
  ipcMain.handle("agent:read-model-catalog", () => catalog());
  ipcMain.handle("agent:open-models-configuration", () => { calls.push("open"); });
  ipcMain.handle("agent:reload-models", () => { calls.push("reload"); return list(); });
  ipcMain.handle("agent:save-provider", (_event, input) => {
    calls.push(["saveProvider", input]);
    const existed = providers.some((item) => item.id === input.providerId);
    let provider = providers.find((item) => item.id === input.providerId);
    if (!provider) {
      provider = { id: input.providerId, name: "", baseUrl: "", api: "", hasApiKey: false, credential: "unknown", credentialDetail: "models.json 未配置 apiKey", models: [] };
      providers.push(provider);
    }
    Object.assign(provider, input.provider);
    if (typeof input.apiKey === "string" && input.apiKey.trim()) {
      provider.hasApiKey = true;
      provider.credential = "configured";
      provider.credentialDetail = "models.json 已配置 apiKey";
    } else if (input.clearApiKey === true) {
      provider.hasApiKey = false;
      provider.credential = "unknown";
      provider.credentialDetail = "models.json 未配置 apiKey";
    }
    if (Array.isArray(input.models)) {
      provider.models = input.models.map((model) => ({ ...model }));
      runtimeModels = runtimeModels.filter((model) => model.provider !== input.providerId);
      for (const model of input.models) runtimeModels.push({ ...model, provider: input.providerId });
    }
    return { providerId: input.providerId, action: existed ? "updated" : "created", modelCount: provider.models.length };
  });
  ipcMain.handle("agent:delete-provider", (_event, providerId) => {
    calls.push(["deleteProvider", providerId]);
    const index = providers.findIndex((item) => item.id === providerId);
    if (index < 0) throw Error("该供应商不在 models.json 中");
    const [removed] = providers.splice(index, 1);
    runtimeModels = runtimeModels.filter((model) => model.provider !== providerId);
    return { providerId, modelCount: removed.models.length, action: "deleted" };
  });
  ipcMain.handle("agent:discover-models", (_event, input) => {
    calls.push(["discover", input]);
    return { models: [{ id: "gpt-discovery", name: "发现模型" }, { id: "same", name: "重复模型" }] };
  });
  ipcMain.handle("agent:set-default-model", (_event, provider, modelId) => {
    calls.push(["default", provider, modelId]);
    if (provider && modelId) defaultSelection = { provider, modelId };
    return { provider: provider || current.provider, modelId: modelId || current.id };
  });
  ipcMain.handle("agent:switch-model", (_event, id, provider) => {
    calls.push(["switch", provider, id]);
    current = { provider, id };
  });
  ipcMain.handle("agent:set-thinking-level", (_event, level) => {
    calls.push(["thinking", level]);
    info = { ...info, thinkingLevel: level };
  });

  const win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: {
    preload: path.resolve(__dirname, "../../src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  try {
    win.webContents.on("console-message", (details) => { if (details.level === "error") console.log("CONSOLE", details.message); });
    const renderer = path.resolve(__dirname, "../../src/renderer");
    const html = (await fs.readFile(path.join(renderer, "index.html"), "utf8"))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace("<head>", `<head><base href="${pathToFileURL(renderer + path.sep).href}">`);
    await fs.writeFile(path.join(root, "fixture.html"), html);
    await win.loadFile(path.join(root, "fixture.html"));
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const run = (source) => win.webContents.executeJavaScript(source);
    const wait = (expression) => run(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
    const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (selector, value) => run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    let passed = 0;
    const check = async (label, expression) => {
      assert.ok(await run(expression), label);
      passed += 1;
      console.log(`PASS ${label}`);
    };

    await run(`(async()=>{
      const {createSettingsPanel}=await import('./components/settings/settings-panel.js');
      const {createModelSelector}=await import('./components/model-selector.js');
      window.busy=false;
      const setBusy=value=>{window.busy=value;window.settings.setBusy(value);window.models.setBusy(value)};
      window.models=createModelSelector(document.querySelector('#model-selector'),window.agent,setBusy,async()=>{});
      window.settings=createSettingsPanel(document.querySelector('#model-settings-dialog'),document.querySelector('#model-settings-button'),window.agent,setBusy,()=>window.models.refresh(),()=>{});
      setBusy(false);await window.models.refresh();
    })()`);

    await check("对话框按提供商分组显示当前模型并可打开菜单", `document.querySelector('[data-model-trigger-name]').textContent==='同名模型'&&(()=>{document.querySelector('#model-trigger').click();return document.querySelectorAll('#model-menu .model-menu__group').length===2&&document.querySelectorAll('#model-menu .model-menu__item').length===2&&document.querySelector('#model-menu').hidden===false;})()`);
    await run(`document.querySelector('#model-search').value='Beta';document.querySelector('#model-search').dispatchEvent(new Event('input'))`);
    await check("模型菜单支持按名称过滤且保留当前选择", `document.querySelectorAll('#model-menu .model-menu__item').length===1&&document.querySelector('#model-menu .model-menu__item').textContent.includes('Beta 模型')`);
    await run(`document.querySelector('#model-menu .model-menu__item').click()`);
    await wait(`document.querySelector('[data-model-trigger-name]').textContent==='Beta 模型'&&!window.busy`);
    await check("选择模型后更新触发按钮与隐藏原生选择", `document.querySelector('#model-select').value===JSON.stringify(['beta','same'])&&document.querySelector('#model-trigger').getAttribute('aria-expanded')==='false'`);
    await run(`document.querySelector('#model-trigger').click()`);
    await check("模型菜单展示当前模型的思考强度", `document.querySelectorAll('#model-effort .model-effort__button').length===3&&[...document.querySelectorAll('#model-effort .model-effort__button')].some((button)=>button.textContent==='高')`);
    await run(`[...document.querySelectorAll('#model-effort .model-effort__button')].find((button)=>button.textContent==='高').click()`);
    await wait(`!window.busy`);
    await check("思考强度在模型菜单内切换", `document.querySelector('[data-model-trigger-effort]').textContent.includes('高')`);
    info = { ...info, thinkingLevels: ["off"] };
    await run("window.models.refresh()");
    await run(`document.querySelector('#model-trigger').click()`);
    await check("模型没有思考档位时说明开启入口", `document.querySelector('#model-effort .model-effort__hint').textContent.includes('设置 → 模型与供应商')`);
    await run(`document.querySelector('#model-trigger').click()`);
    info = { ...info, thinkingLevels: ["off", "low", "high"] };
    await run("window.models.refresh()");
    win.setSize(390, 860);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await run(`document.querySelector('#model-trigger').click()`);
    await check("模型菜单在窄窗内不溢出", `(()=>{const box=document.querySelector('#model-menu').getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&box.width>0;})()`);
    await run(`document.querySelector('#model-trigger').click()`);
    win.setSize(1180, 860);
    await run(`document.querySelector('#model-trigger').click()`);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    if (process.env.MODEL_MENU_SCREENSHOT_PATH) {
      await fs.writeFile(process.env.MODEL_MENU_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await run(`document.querySelector('#model-trigger').click()`);

    await click("#model-settings-button");
    await wait(`document.querySelectorAll('[data-provider-list] .provider-card').length===2`);
    await check("提供商卡片显示认证状态、模型数与当前标记", `(()=>{const alpha=document.querySelector('[data-provider-list] .provider-card[data-provider-id="alpha"]');const beta=document.querySelector('[data-provider-list] .provider-card[data-provider-id="beta"]');return alpha.querySelector('.provider-credential-dot').dataset.credential==='configured'&&beta.querySelector('.provider-credential-dot').dataset.credential==='unknown'&&alpha.querySelector('.model-catalog-count').textContent==='1'&&beta.querySelector('.model-row').classList.contains('is-current')&&document.querySelector('[data-model-state]').textContent==='已就绪';})()`);

    await run(`document.querySelector('[data-provider-list] .provider-card[data-provider-id="alpha"] [data-provider-action="edit"]').click()`);
    await check("编辑提供商显示端点、协议和只写密钥字段", `!document.querySelector('[data-provider-editor]').hidden&&document.querySelector('[data-provider-field="providerId"]').value==='alpha'&&document.querySelector('[data-provider-field="providerId"]').readOnly&&document.querySelector('[data-provider-field="apiKey"]').type==='password'&&document.querySelectorAll('[data-provider-editor] .model-editor-row').length===1`);
    await run(`document.querySelector('[data-key-toggle]').click()`);
    await check("密钥显示按钮只切换当前输入类型", `document.querySelector('[data-provider-field="apiKey"]').type==='text'&&document.querySelector('[data-provider-field="apiKey"]').value===''`);
    if (process.env.MODEL_EDITOR_SCREENSHOT_PATH) {
      await run(`document.documentElement.dataset.theme='dark';document.querySelector('[data-provider-editor]').scrollIntoView({block:'start'});`);
      await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await fs.writeFile(process.env.MODEL_EDITOR_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
      await run(`document.documentElement.dataset.theme='sakura';`);
    }
    await fill('[data-provider-field="apiKey"]', "sk-secret");
    await click('[data-add-model-row]');
    await check("提供商编辑器可增加模型行", `document.querySelectorAll('[data-provider-editor] .model-editor-row').length===2`);
    await fill('[data-provider-editor] .model-editor-row:last-child [data-model-field="id"]', "demo-new");
    await fill('[data-provider-editor] .model-editor-row:last-child [data-model-field="name"]', "新模型");
    await fill('[data-provider-editor] .model-editor-row:last-child [data-model-field="contextWindow"]', "200000");
    await click('[data-save-provider]');
    await wait(`document.querySelector('[data-provider-editor]').hidden&&!window.busy`);
    const saved = calls.filter((call) => Array.isArray(call) && call[0] === "saveProvider").at(-1)[1];
    assert.equal(saved.providerId, "alpha");
    assert.equal(saved.provider.name, "Alpha 供应商");
    assert.equal(saved.models.length, 2);
    assert.equal(saved.models[1].id, "demo-new");
    assert.equal(saved.apiKey, "sk-secret");
    await check("保存提供商后目录出现新模型", `document.querySelectorAll('[data-provider-list] .provider-card[data-provider-id="alpha"] .model-row').length===2&&document.querySelector('[data-provider-status]').textContent.includes('更新提供商 alpha')`);

    await run(`document.querySelector('[data-provider-list] .provider-card[data-provider-id="alpha"] [data-provider-action="edit"]').click()`);
    await check("已保存密钥不回填输入框", `document.querySelector('[data-provider-field="apiKey"]').value===''&&document.querySelector('[data-provider-editor]').textContent.includes('models.json 已配置 apiKey')`);
    await click('[data-provider-cancel]');
    await run(`document.querySelector('[data-provider-list] .provider-card[data-provider-id="beta"] [data-provider-action="edit"]').click()`);
    await fill('[data-provider-field="baseUrl"]', "https://beta.example.com/v1");
    await fill('[data-provider-field="api"]', "openai-completions");
    await click('[data-discover-models]');
    await run(`new Promise((resolve)=>setTimeout(resolve,150))`);
    await wait(`document.querySelector('.model-candidates')!==null&&!window.busy`);
    await check("获取可用模型显示候选列表并跳过重复项", `document.querySelectorAll('.model-candidate').length===2&&[...document.querySelectorAll('.model-candidate')].find((node)=>node.textContent.includes('same'))?.querySelector('input').checked===false`);
    await click('[data-add-candidates]');
    await check("添加所选模型回到编辑行", `document.querySelectorAll('[data-provider-editor] .model-editor-row').length===2&&[...document.querySelectorAll('[data-provider-editor] [data-model-field="id"]')].some((input)=>input.value==='gpt-discovery')`);

    await run(`document.querySelector('[data-provider-editor] [data-provider-cancel]').click()`);
    await click("[data-add-provider]");
    await check("添加提供商打开空白编辑器", `document.querySelector('[data-provider-editor] h3').textContent==='添加模型提供商'&&document.querySelector('[data-provider-field="providerId"]').value===''&&document.querySelector('[data-provider-field="providerId"]').readOnly===false&&document.querySelector('[data-provider-delete]').hidden`);
    await fill('[data-provider-field="providerId"]', "gamma");
    await fill('[data-provider-field="name"]', "Gamma 供应商");
    await fill('[data-provider-field="baseUrl"]', "https://gamma.example.com/v1");
    await fill('[data-provider-field="api"]', "openai-completions");
    await fill('[data-provider-editor] .model-editor-row [data-model-field="id"]', "gamma-model");
    await click('[data-save-provider]');
    await wait(`document.querySelector('[data-provider-editor]').hidden&&!window.busy`);
    await check("新增提供商后出现卡片", `(()=>{const card=document.querySelector('[data-provider-list] .provider-card[data-provider-id="gamma"]');return card!==null&&card.querySelector('.model-catalog-count').textContent==='1'&&document.querySelector('[data-provider-status]').textContent.includes('新增提供商 gamma');})()`);
    await run(`document.querySelector('[data-provider-list] .provider-card[data-provider-id="gamma"] [data-provider-action="edit"]').click()`);
    await click('[data-provider-delete]');
    await check("删除提供商需要二次确认", `document.querySelector('[data-provider-delete]').textContent==='确认删除提供商'`);
    await click('[data-provider-delete]');
    await wait(`document.querySelector('[data-provider-editor]').hidden&&!window.busy`);
    await check("确认后删除提供商卡片", `document.querySelector('[data-provider-list] .provider-card[data-provider-id="gamma"]')===null`);

    await run(`document.querySelector('[data-provider-list] .provider-card[data-provider-id="alpha"] .model-row [data-action="default"]').click()`);
    await wait(`!window.busy`);
    await check("模型行可设为新对话默认", `document.querySelector('[data-default-model-label]').textContent.includes('alpha/same')`);
    await click("[data-open-models]"); await wait("!window.busy");
    assert.equal(calls.pop(), "open");
    await check("配置文件入口仍可用", `document.querySelector('[data-provider-status]').textContent.includes('编辑保存后')`);
    await click("[data-reload-models]"); await wait("!window.busy");
    await check("重新读取后目录保持", `document.querySelectorAll('[data-provider-list] .provider-card').length===2`);

    for (const theme of ["dark", "sakura"]) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const width of [1180, 760, 390]) {
        win.setSize(width, 860);
        await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        await check(`${theme} ${width}设置页可滚动且不横向溢出`, `document.querySelector('#model-settings-dialog').getBoundingClientRect().width<=innerWidth&&document.querySelector('#settings-model-panel').scrollWidth<=document.querySelector('#settings-model-panel').clientWidth+1`);
      }
    }
    win.setSize(1180, 860);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await fs.writeFile("/tmp/model-management.png", (await win.webContents.capturePage()).toPNG());
    console.log(`模型管理页面 ${passed} 项检查通过。`);
  } finally {
    win.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });

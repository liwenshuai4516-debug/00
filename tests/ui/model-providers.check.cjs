const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-providers-ui-"));
  app.setPath("userData", root);
  app.setPath("sessionData", root);
  await app.whenReady();
  let current = { provider: "alpha", id: "same" };
  const models = [
    { ...current, name: "同名模型", contextWindow: 128000, maxTokens: 16384, input: ["text"], api: "openai-completions" },
    { provider: "beta", id: "same", name: "<img src=x onerror=alert(1)>", reasoning: true, input: ["text", "image"] },
  ];
  const calls = [];
  let failed = false, configFailed = false, gate, infoGate, warning;
  let defaultSelection = { provider: "", modelId: "" };
  let info = { sessionId: "session-a", provider: "alpha", modelId: "same", thinkingLevel: "off", thinkingLevels: ["off", "low"] };
  const list = () => ({
    provider: current.provider, modelId: current.id, models, warning,
    defaultProvider: defaultSelection.provider, defaultModel: defaultSelection.modelId,
  });
  // 模拟 models.json：保存与删除同步更新这份结构，页面读到的是写入后的结果。
  const configProviders = [
    {
      id: "alpha", name: "Alpha 供应商", baseUrl: "https://alpha.example.com/v1", api: "openai-completions",
      hasApiKey: true,
      models: [{ id: "same", name: "同名模型", contextWindow: 128000, maxTokens: 16384, input: ["text"], cost: { input: 1, output: 2 } }],
    },
    { id: "beta", name: "", baseUrl: "", api: "", hasApiKey: false, models: [] },
  ];
  const catalog = () => ({
    modelsPath: "/temporary/pi/models.json",
    providers: configProviders.map(provider => ({ ...provider, models: provider.models.map(model => ({ ...model })) })),
    options: {
      api: ["openai-completions", "anthropic-messages"],
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      inputs: ["text", "image"],
    },
  });
  ipcMain.handle("agent:list-models", () => list());
  ipcMain.handle("agent:session-info", async () => {
    if (infoGate) { const pending = infoGate; infoGate = undefined; await pending.promise; }
    if (configFailed) throw Error("模拟配置损坏");
    // 供应商与模型编号跟随实际选择，模拟主进程当前会话的真实状态。
    return { ...info, provider: current.provider, modelId: current.id };
  });
  ipcMain.handle("agent:read-model-configuration", () => ({ modelsPath: "/temporary/pi/models.json" }));
  ipcMain.handle("agent:read-model-catalog", () => catalog());
  ipcMain.handle("agent:open-models-configuration", () => { calls.push("open"); });
  ipcMain.handle("agent:reload-models", async () => { calls.push("reload"); if (gate) await gate.promise; return list(); });
  ipcMain.handle("agent:save-model", (_event, input) => {
    calls.push(["save", input]);
    const existing = models.findIndex(model => model.provider === input.providerId && model.id === input.original?.modelId);
    const saved = {
      provider: input.providerId,
      id: input.model.id,
      name: input.model.name || input.model.id,
      contextWindow: input.model.contextWindow,
      maxTokens: input.model.maxTokens,
      reasoning: input.model.reasoning,
      input: input.model.input,
    };
    if (existing >= 0) models[existing] = saved;
    else models.push(saved);

    const provider = configProviders.find(item => item.id === input.providerId);
    const configIndex = provider?.models.findIndex(model => model.id === (input.original?.modelId ?? saved.id)) ?? -1;
    if (provider && configIndex >= 0) provider.models[configIndex] = { ...provider.models[configIndex], ...saved, provider: undefined };
    else if (provider) provider.models.push({ ...saved, provider: undefined });
    return { providerId: input.providerId, modelId: saved.id, action: existing >= 0 ? "updated" : "created" };
  });
  ipcMain.handle("agent:delete-model", (_event, provider, modelId) => {
    calls.push(["delete", provider, modelId]);
    const index = models.findIndex(model => model.provider === provider && model.id === modelId);
    if (index >= 0) models.splice(index, 1);
    const configProvider = configProviders.find(item => item.id === provider);
    if (configProvider) configProvider.models = configProvider.models.filter(model => model.id !== modelId);
    return { providerId: provider, modelId, action: "deleted" };
  });
  ipcMain.handle("agent:set-default-model", (_event, provider, modelId) => {
    calls.push(["default", provider, modelId]);
    if (provider) defaultSelection = { provider, modelId };
    return { provider: provider || current.provider, modelId: modelId || current.id };
  });
  ipcMain.handle("agent:set-thinking-level", (_event, level) => { calls.push(["thinking", level]); info = { ...info, thinkingLevel: level }; });
  ipcMain.handle("agent:switch-model", (_event, id, provider) => {
    calls.push(["switch", provider, id]); current = { provider, id };
    if (failed) throw Error("模拟更新后失败");
  });
  const win = new BrowserWindow({ width: 1180, height: 820, show: false, webPreferences: {
    preload: path.resolve(__dirname, "../../src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  try {
    const renderer = path.resolve(__dirname, "../../src/renderer");
    const html = (await fs.readFile(path.join(renderer, "index.html"), "utf8"))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace("<head>", `<head><base href="${pathToFileURL(renderer + path.sep).href}">`);
    await fs.writeFile(path.join(root, "fixture.html"), html);
    await win.loadFile(path.join(root, "fixture.html"));
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const run = source => win.webContents.executeJavaScript(source);
    const wait = expression => run(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (selector, value) => run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    let passed = 0;
    const check = async (label, expression) => { assert.ok(await run(expression), label); passed++; console.log(`PASS ${label}`); };
    await run(`(async()=>{
      const {createSettingsPanel}=await import('./components/settings/settings-panel.js');
      const {createModelSelector}=await import('./components/model-selector.js');
      window.busy=false;
      const setBusy=value=>{window.busy=value;window.settings.setBusy(value);window.models.setBusy(value)};
      window.models=createModelSelector(document.querySelector('#model-selector'),window.agent,setBusy,async()=>{});
      window.settings=createSettingsPanel(document.querySelector('#model-settings-dialog'),document.querySelector('#model-settings-button'),window.agent,setBusy,()=>window.models.refresh(),()=>{});
      setBusy(false);await window.models.refresh();
    })()`);
    await check("原生模型按供应商分组，同名模型编号互不混淆且按文本展示", `document.querySelectorAll('#model-select optgroup').length===2&&document.querySelectorAll('#model-select option')[1].textContent.includes('<img')&&!document.querySelector('#model-select img')&&document.querySelector('#model-select').value===JSON.stringify(['alpha','same'])`);
    warning = "上次对话的模型已不可用，已新建对话。旧记录和输入仍保留。";
    await run("window.models.refresh()");
    await check("自动恢复失败提示新对话原因，同时模型选择保持可用", `!document.querySelector('#model-select').disabled&&document.querySelector('#model-select').value===JSON.stringify(['alpha','same'])&&document.querySelector('#model-status').textContent.includes('已新建对话')&&!document.querySelector('#model-status').hidden`);
    warning = undefined;
    await run("window.models.refresh()");
    await check("离开恢复候选后不残留上次恢复提示", `document.querySelector('#model-status').hidden`);
    await check("旧配置档案、密钥管理与目录探测接口和节点均已移除", `!window.agent.saveModelSettings&&!window.agent.listModelProfiles&&!window.agent.startProviderOAuth&&!window.agent.enrichModels&&!document.querySelector('#model-profile-form')&&!document.querySelector('[data-provider-auth]')&&!document.querySelector('[data-enrichment]')`);
    await click("#model-settings-button");
    await wait(`document.querySelector('[data-current-model]').textContent==='alpha/same'&&!document.querySelector('[data-open-models]').disabled`);
    await check("设置页不提供密钥回填入口，路径来自主进程", `document.querySelector('[data-models-path]').textContent==='/temporary/pi/models.json'&&!document.querySelector('#settings-model-panel input[type=password]')&&[...document.querySelectorAll('#settings-model-panel input,#settings-model-panel textarea')].every(el=>!/apikey|secret|密钥/i.test(el.dataset.field||''))`);
    await check("可用模型按供应商分组，名称来自目录且标出当前模型", `document.querySelectorAll('[data-model-catalog] .model-catalog-group').length===2&&document.querySelector('[data-current-model-name]').textContent==='同名模型'&&document.querySelector('[data-model-catalog] .model-row.is-current .model-row-id').textContent==='same'&&!document.querySelector('[data-model-catalog] img')`);
    await check("模型卡片展示上下文、输出与推理能力，默认模型初始为未设置", `document.querySelector('[data-model-catalog] .model-row .model-row-meta .model-chip').textContent.includes('上下文')&&[...document.querySelectorAll('[data-model-catalog] .model-row')].some(row=>[...row.querySelectorAll('.model-row-meta .model-chip')].some(chip=>chip.textContent==='推理'))&&document.querySelector('[data-default-model]').textContent==='未设置'`);
    await check("上下文未知时明确说明不可用而不是显示为零", `document.querySelector('[data-current-context]').textContent.includes('暂不可用')&&!/\\b0\\b/.test(document.querySelector('[data-current-context]').textContent)`);
    await click("[data-open-models]"); await wait("!window.busy");
    assert.equal(calls.pop(), "open");
    await check("配置文件打开后提示保存与重新读取", `document.querySelector('[data-provider-status]').textContent.includes('编辑保存后')`);
    gate = Promise.withResolvers();
    await click("[data-reload-models]");
    await wait("window.busy");
    await check("重读期间禁用分类、关闭、切换及重复操作", `document.querySelector('[data-close]').disabled&&document.querySelector('#model-select').disabled&&document.querySelector('[data-reload-models]').disabled&&[...document.querySelectorAll('[role=tab]')].every(el=>el.disabled)`);
    await click("[data-close]");
    await check("重读期间设置窗口保持打开", `document.querySelector('#model-settings-dialog').open`);
    gate.resolve(); gate = undefined; await wait("!window.busy");

    // 新增模型：表单字段与 models.json 对齐，保存后立即出现在目录里。
    await click("[data-add-model]");
    await check("新增模型表单按 models.json 字段展开，含供应商、能力、计费与高级字段", `!document.querySelector('[data-model-editor]').hidden&&['providerId','providerBaseUrl','providerApi','id','name','api','contextWindow','maxTokens','reasoning','thinkingFormat','costInput','extraInputLimits'].every(name=>document.querySelector('[data-field="'+name+'"]'))&&document.querySelector('[data-editor-title]').textContent==='新增模型'`);
    await fill('[data-field="id"]', "demo-new");
    await fill('[data-field="name"]', "新模型");
    await fill('[data-field="contextWindow"]', "200000");
    await fill('[data-field="maxTokens"]', "32000");
    await run(`document.querySelector('[data-field="inputImage"]').click();document.querySelector('[data-field="reasoning"]').click()`);
    await click('[data-model-form] button[type=submit]');
    await wait("document.querySelector('[data-model-editor]').hidden&&!window.busy");
    const saved = calls.filter(call => Array.isArray(call) && call[0] === "save").at(-1)[1];
    assert.equal(saved.providerId, "alpha");
    assert.equal(saved.provider.name, "Alpha 供应商");
    assert.equal(saved.model.id, "demo-new");
    assert.equal(saved.model.reasoning, true);
    assert.equal(saved.model.contextWindow, 200000);
    assert.deepEqual(saved.model.input, ["text", "image"]);
    assert.deepEqual(saved.model.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
    await check("保存新增模型后表单关闭，目录出现新行且提示写入结果", `document.querySelector('[data-model-editor]').hidden&&[...document.querySelectorAll('[data-model-catalog] .model-row')].some(row=>row.dataset.modelId==='demo-new')&&document.querySelector('[data-provider-status]').textContent.includes('新增模型 alpha/demo-new')`);

    // 编辑：回填已有字段，保存时带上原始定位，保证是更新而不是重复新增。
    await run(`[...document.querySelectorAll('[data-model-catalog] .model-row')].find(row=>row.dataset.modelId==='demo-new').querySelector('[data-action=edit]').click()`);
    await check("编辑模型时按已有配置回填字段与思考档位", `document.querySelector('[data-editor-title]').textContent==='编辑模型'&&document.querySelector('[data-field="id"]').value==='demo-new'&&document.querySelector('[data-field="contextWindow"]').value==='200000'&&document.querySelector('[data-field="reasoning"]').checked&&[...document.querySelectorAll('.model-level input')].filter(el=>el.checked).map(el=>el.dataset.level).join(',')==='off,minimal,low,medium,high'&&document.querySelector('[data-field="inputImage"]').checked`);
    await fill('[data-field="name"]', "新模型改名");
    await click('[data-model-form] button[type=submit]');
    await wait("document.querySelector('[data-model-editor]').hidden&&!window.busy");
    const updated = calls.filter(call => Array.isArray(call) && call[0] === "save").at(-1)[1];
    assert.deepEqual(updated.original, { providerId: "alpha", modelId: "demo-new" });
    await check("编辑保存沿用原始定位并更新同一行", `document.querySelector('[data-provider-status]').textContent.includes('更新模型 alpha/demo-new')&&[...document.querySelectorAll('[data-model-catalog] .model-row')].filter(row=>row.dataset.modelId==='demo-new').length===1&&[...document.querySelectorAll('[data-model-catalog] .model-row')].find(row=>row.dataset.modelId==='demo-new').textContent.includes('新模型改名')`);

    // 行内设为默认：写入官方设置并立即反映在卡片上。
    await run(`[...document.querySelectorAll('[data-model-catalog] .model-row')].find(row=>row.dataset.modelId==='demo-new').querySelector('[data-action=default]').click()`);
    await wait("!window.busy");
    assert.deepEqual(calls.at(-1), ["default", "alpha", "demo-new"]);
    await check("行内设为默认后显示默认标记，按钮不再重复出现", `document.querySelector('[data-default-model]').textContent==='alpha/demo-new'&&[...document.querySelectorAll('[data-model-catalog] .model-row')].find(row=>row.dataset.modelId==='demo-new').textContent.includes('默认')&&![...document.querySelectorAll('[data-model-catalog] .model-row')].find(row=>row.dataset.modelId==='demo-new').querySelector('[data-action=default]')`);

    // 删除：需要同一行二次确认，避免误删。
    await run(`[...document.querySelectorAll('[data-model-catalog] .model-row')].find(row=>row.dataset.modelId==='demo-new').querySelector('[data-action=delete]').click()`);
    await check("删除需要二次确认", `[...document.querySelectorAll('[data-model-catalog] .model-row')].find(row=>row.dataset.modelId==='demo-new').querySelector('[data-action=delete]').textContent==='确认删除'&&!window.busy`);
    await run(`[...document.querySelectorAll('[data-model-catalog] .model-row')].find(row=>row.dataset.modelId==='demo-new').querySelector('[data-action=delete]').click()`);
    await wait("!window.busy");
    assert.deepEqual(calls.at(-1), ["delete", "alpha", "demo-new"]);
    await check("确认后删除模型并刷新目录", `![...document.querySelectorAll('[data-model-catalog] .model-row')].some(row=>row.dataset.modelId==='demo-new')&&document.querySelector('[data-provider-status]').textContent.includes('已从 models.json 删除 alpha/demo-new')`);

    // 当前对话卡片的按钮仍按当前选择设置默认。
    await click("[data-default-model-button]"); await wait("!window.busy");
    assert.deepEqual(calls.at(-1), ["default", undefined, undefined]);
    await check("默认模型操作使用当前原生选择", `document.querySelector('[data-provider-status]').textContent.includes('已有对话保持各自选择')`);

    // 思考强度：模型有档位时可直接调整，并按模型记住。
    await check("模型支持思考强度时下拉可用并列出全部档位", `!document.querySelector('#model-thinking-level').disabled&&document.querySelectorAll('#model-thinking-level option').length===2&&document.querySelector('[data-enable-thinking]').hidden`);
    await run(`document.querySelector('#model-thinking-level').value='low';document.querySelector('#model-thinking-level').dispatchEvent(new Event('change'))`);
    await wait("!window.busy");
    assert.deepEqual(calls.at(-1), ["thinking", "low"]);
    await check("思考强度更新后按模型保存并提示", `document.querySelector('[data-provider-status]').textContent.includes('按模型记住')`);
    info = { ...info, thinkingLevels: ["off"], thinkingLevel: "off" };
    await click("#settings-theme-tab"); await click("#settings-model-tab");
    await wait("!document.querySelector('[data-open-models]').disabled");
    await check("模型没有思考档位时给出开启入口而不是灰掉的控件", `document.querySelector('#model-thinking-level').disabled&&!document.querySelector('[data-enable-thinking]').hidden&&document.querySelector('[data-thinking-hint]').textContent.includes('未标记支持思考强度')`);
    await click("[data-enable-thinking]");
    await check("开启入口直接打开当前模型的编辑表单", `!document.querySelector('[data-model-editor]').hidden&&document.querySelector('[data-field="id"]').value==='same'&&document.querySelector('[data-editor-title]').textContent==='编辑模型'`);
    await click("[data-cancel-edit]");
    await check("取消编辑不提交任何写入", `document.querySelector('[data-model-editor]').hidden&&!document.querySelector('[data-provider-status]').textContent.includes('模型 alpha/same')`);
    info = { ...info, thinkingLevels: ["off", "low"], thinkingLevel: "low" };

    for (const theme of ["dark", "sakura"]) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const width of [1180, 760, 390]) {
        win.setSize(width, 820);
        await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        await check(`${theme} ${width}设置页可滚动且不横向溢出`, `document.querySelector('#model-settings-dialog').getBoundingClientRect().width<=innerWidth&&document.querySelector('#settings-model-panel').scrollWidth<=document.querySelector('#settings-model-panel').clientWidth+1`);
      }
    }
    win.setSize(1180,820);
    await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await click("[data-close]");
    await check("关闭设置返回入口焦点", `!document.querySelector('#model-settings-dialog').open&&document.activeElement.id==='model-settings-button'`);
    failed = true;
    await run(`document.querySelector('#model-select').value=JSON.stringify(['beta','same']);document.querySelector('#model-select').dispatchEvent(new Event('change'))`);
    await wait("!window.busy");
    await check("切换报错后读取实际选择，跨供应商同名模型不会回滚显示", `document.querySelector('#model-select').value===JSON.stringify(['beta','same'])&&document.querySelector('#model-status').textContent.includes('模拟更新后失败')`);
    configFailed = true;
    await click("#model-settings-button");
    await wait(`document.querySelector('[data-provider-status]').textContent.includes('模拟配置损坏')`);
    await check("模型初始化失败时仍可打开配置修复", `!document.querySelector('[data-open-models]').disabled&&document.querySelector('[data-models-path]').textContent.includes('models.json')`);
    await click("[data-open-models]"); await wait("!window.busy");
    await check("打开文件成功不会掩盖仍存在的模型配置错误", `document.querySelector('[data-provider-status]').textContent.includes('模拟配置损坏')`);
    configFailed = false;
    await click("[data-reload-models]"); await wait("!window.busy");
    await check("修正配置后重新读取恢复实际模型", `document.querySelector('[data-current-model]').textContent==='beta/same'`);
    await click("[data-close]");
    infoGate = Promise.withResolvers(); const late = infoGate;
    await click("#model-settings-button");
    await click("#settings-theme-tab");
    late.resolve(); await run(`new Promise(resolve=>setTimeout(resolve,20))`);
    await check("切换设置分类后迟到模型响应不覆盖当前面板", `!document.querySelector('#settings-theme-panel').hidden&&document.querySelector('#settings-model-panel').hidden&&document.querySelector('#model-settings-title').textContent==='主题'`);
    await click("#settings-model-tab");
    await wait(`!document.querySelector('[data-open-models]').disabled`);
    await fs.writeFile("/tmp/pi-custom-providers-settings.png", (await win.webContents.capturePage()).toPNG());
    console.log(`模型与供应商页面 ${passed} 项检查通过。`);
  } finally {
    win.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

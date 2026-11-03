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
  const models = [{ ...current, name: "同名模型" }, { provider: "beta", id: "same", name: "<img src=x onerror=alert(1)>" }];
  const calls = [];
  let failed = false, configFailed = false, gate, infoGate, warning;
  const list = () => ({ provider: current.provider, modelId: current.id, models, warning });
  ipcMain.handle("agent:list-models", () => list());
  ipcMain.handle("agent:session-info", async () => {
    if (infoGate) { const pending = infoGate; infoGate = undefined; await pending.promise; }
    if (configFailed) throw Error("模拟配置损坏");
    return { sessionId: "session-a", provider: current.provider, modelId: current.id, thinkingLevel: "off", thinkingLevels: ["off", "low"] };
  });
  ipcMain.handle("agent:read-model-configuration", () => ({ modelsPath: "/temporary/pi/models.json" }));
  ipcMain.handle("agent:open-models-configuration", () => { calls.push("open"); });
  ipcMain.handle("agent:reload-models", async () => { calls.push("reload"); if (gate) await gate.promise; return list(); });
  ipcMain.handle("agent:set-default-model", () => { calls.push(["default", current.provider, current.id]); });
  ipcMain.handle("agent:set-thinking-level", (_event, level) => { calls.push(["thinking", level]); });
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
    let passed = 0;
    const check = async (label, expression) => { assert.ok(await run(expression), label); passed++; console.log(`PASS ${label}`); };
    await run(`(async()=>{
      const {createSettingsPanel}=await import('./components/settings/settings-panel.js');
      const {createModelSelector}=await import('./components/model-selector.js');
      window.busy=false;
      document.querySelector("#app-sidebar").hidden=false;
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
    await check("设置显示官方配置路径及模型，不提供密钥回填表单", `document.querySelector('[data-models-path]').textContent==='/temporary/pi/models.json'&&!document.querySelector('#settings-model-panel input')`);
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
    await click("[data-default-model]"); await wait("!window.busy");
    assert.deepEqual(calls.at(-1), ["default", "alpha", "same"]);
    await check("默认模型操作使用当前原生选择", `document.querySelector('[data-provider-status]').textContent.includes('已有对话保持各自选择')`);
    await run(`document.querySelector('#model-thinking-level').value='low';document.querySelector('#model-thinking-level').dispatchEvent(new Event('change'))`);
    await wait("!window.busy");
    assert.deepEqual(calls.at(-1), ["thinking", "low"]);
    passed++; console.log("PASS 思考强度通过原生接口更新");
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

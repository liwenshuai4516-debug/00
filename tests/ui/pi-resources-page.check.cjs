const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-resources-page-"));
  app.setPath("userData", root);
  await app.whenReady();
  const data = {
    sessionId: "fixture-a", cwd: "/workspace/需求与测试项目", projectTrusted: true,
    skills: [
      { name: "qa-requirement-review", description: "梳理需求范围、识别歧义与缺失约束，形成可以直接讨论的评审清单。", package: { source: "npm:@example/pi-tools@1.0.0", scope: "user", configured: true }, control: { source: "/fixture/first/SKILL.md", scope: "user", disabled: false } },
      { name: "qa-case-design", description: "从需求和验收标准出发，设计覆盖业务规则、边界条件与异常场景的测试用例。" },
      { name: "qa-api-test", description: "Makes coding agents faster and more accurate with fewer tokens when designing, implementing, mocking, testing, monitoring, documenting, or deploying an API." },
      { name: "qa-ui-test", description: "检查关键页面交互与用户流程，记录可复现的步骤和验证结果。" },
    ],
    prompts: [{ name: "review", description: "Review/fix loop until clean" }],
    extensions: [{ name: "codemode", path: "builtin:codemode" }, { name: "pi-subagents", path: "/packages/pi-subagents/index.js", package: { source: "git:github.com/example/qa-workflows@v1", scope: "project", configured: true } }],
    packages: [
      { source: "npm:@example/pi-tools@1.0.0", scope: "user", installedPath: "/temporary/npm/pi-tools", filtered: false, filters: {} },
      { source: "git:github.com/example/qa-workflows@v1", scope: "project", installedPath: "/temporary/git/qa-workflows", filtered: true, filters: { skills: [] } },
    ],
    diagnostics: [],
  };
  let gate, listGate, listFailure = false, manageFailure = false;
  const calls = [];
  ipcMain.handle("agent:list-pi-resources", async () => {
    const snapshot = structuredClone(data);
    if (listGate) { const pending = listGate; listGate = undefined; await pending.promise; }
    if (listFailure) throw Error("模拟资源读取失败");
    return snapshot;
  });
  ipcMain.handle("agent:manage-pi-package", async (event, request) => {
    calls.push(request);
    event.sender.send("agent:pi-package-progress", { source: request.source ?? "Pi", action: request.action, type: "progress", message: "处理中" });
    if (gate) await gate.promise;
    if (manageFailure) throw Error("模拟安装失败");
    return request.action === "reload" ? { reloaded: true } : request.action === "check" ? { updates: [] } : { needsReload: true };
  });
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: {
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
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const wait = expression => run(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
    const ready = `!document.querySelector('[data-pi-refresh]').disabled`;
    let passed = 0;
    const check = async (label, expression) => { assert.ok(await run(expression), label); passed++; console.log(`PASS ${label}`); };
    await run(`(async()=>{
      const {createSettingsPanel}=await import('./components/settings/settings-panel.js');
      window.busy=false;
      document.querySelector('#app-sidebar').hidden=false;
      document.querySelector('.app-shell').classList.remove('sidebar-closed');
      const api={...window.agent, readModelConfiguration:async()=>({modelsPath:'/temporary/models.json'}),getSessionInfo:async()=>({provider:'fixture',modelId:'fixture'})};
      window.settings=createSettingsPanel(document.querySelector('#model-settings-dialog'),document.querySelector('#model-settings-button'),api,value=>{window.busy=value;window.settings.setBusy(value)},async()=>{},text=>{window.inserted=text});
      window.settings.setBusy(false);document.querySelector('#model-settings-button').click();document.querySelector('#settings-resources-tab').click();
    })()`);
    await wait(ready);
    await check("默认展示技能卡片和真实数量，资源分类不干扰设置导航", `document.querySelectorAll('.pi-resource-card').length===5&&document.querySelector('[data-pi-kind=skills]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-pi-count=skills]').textContent==='4'&&document.querySelectorAll('.settings-categories [role=tab]').length===5`);
    await check("工作目录和项目信任独立显示，不占用操作状态", `document.querySelector('[data-pi-cwd]').textContent==='/workspace/需求与测试项目'&&document.querySelector('[data-pi-trust]').textContent==='项目资源已信任'&&document.querySelector('[data-pi-status]').textContent===''`);
    await check("英文技能和模板描述显示中文，执行命令保留原名", `document.querySelector('[data-pi-items=skills]').textContent.includes('帮助编程智能体')&&document.querySelector('[data-pi-items=prompts]').textContent.includes('反复审查和修复')&&document.querySelector('[data-pi-command="/skill:qa-api-test"]')!==null`);
    await check("技能标题和操作名称使用中文，实际命令保留技能标识", `[...document.querySelectorAll('[data-pi-items=skills] h4')].map(title=>title.textContent).join('|')==='需求评审|测试用例设计|接口测试|界面测试'&&document.querySelector('[data-pi-command="/skill:qa-requirement-review"]').getAttribute('aria-label')==='使用技能：需求评审'`);
    await check("扩展显示中文名称与用途，不以 index.js 作为标题", `document.querySelector('[data-pi-items=extensions]').textContent.includes('子智能体协作')&&document.querySelector('[data-pi-items=extensions]').textContent.includes('代码执行')&&[...document.querySelectorAll('.pi-extension-row h4')].every(title=>!title.textContent.includes('index.'))&&document.querySelectorAll('.pi-extension-description').length===2`);
    await check("包内技能和扩展有卸载所属包入口，独立技能与内置扩展不冒充包", `document.querySelectorAll('[data-pi-items=skills] .pi-remove-button').length===1&&document.querySelectorAll('[data-pi-items=extensions] .pi-remove-button').length===1&&document.querySelector('[data-pi-items=extensions] .pi-resource-origin').textContent.includes('内置扩展')`);
    const artifacts = process.env.PI_UI_ARTIFACT_DIR || "/tmp/pi-resources-design";
    await fs.mkdir(artifacts, { recursive: true });
    for (const theme of ["dark", "sakura"]) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await run("new Promise(resolve=>setTimeout(resolve,180))");
      for (const width of [1280, 800, 390]) {
        win.setSize(width, 860);
        for (const kind of ["skills", "prompts", "extensions", "packages"]) {
          await click(`[data-pi-kind="${kind}"]`);
          await run(`document.querySelector('#settings-resources-panel').scrollTop=0;document.querySelector('.pi-install-section').open=true;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
          await check(`${theme} ${width} ${kind} 无横向溢出`, `document.querySelector('#settings-resources-panel').scrollWidth<=document.querySelector('#settings-resources-panel').clientWidth+1`);
          if (kind === "skills" || (["extensions", "packages"].includes(kind) && width === 1280)) await fs.writeFile(path.join(artifacts, `${theme}-${kind}-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
      }
    }
    win.setSize(1280, 860);
    await click('[data-pi-kind="prompts"]');
    await click('[data-pi-command="/review"]');
    await check("模板只插入原生命令，关闭后返回设置入口焦点", `window.inserted==='/review '&&!document.querySelector('#model-settings-dialog').open&&document.activeElement.id==='model-settings-button'`);
    await click("#model-settings-button"); await wait(ready);
    await click('[data-pi-kind="packages"]');
    await check("空来源不能安装，安装区与包操作分别归类", `document.querySelector('[data-pi-install]').disabled&&document.querySelectorAll('.pi-package-row').length===2`);
    await run(`document.querySelector('[data-pi-source]').value='npm:example';document.querySelector('[data-pi-source]').dispatchEvent(new Event('input'))`);
    gate = Promise.withResolvers();
    await click("[data-pi-install]"); await wait("window.busy");
    await check("执行期间禁用资源分类、设置关闭和重复安装", `document.querySelector('[data-close]').disabled&&document.querySelector('[data-pi-install]').disabled&&[...document.querySelectorAll('[data-pi-kind]')].every(button=>button.disabled)`);
    await click("[data-close]");
    await check("操作期间保留设置窗口", `document.querySelector('#model-settings-dialog').open`);
    gate.resolve(); gate = undefined; await wait("!window.busy");
    await check("安装后明确显示待重载状态", `!document.querySelector('[data-pi-reload-notice]').hidden&&document.querySelector('[data-pi-status]').textContent.includes('配置已保存')`);
    await click("[data-pi-refresh]"); await wait(ready);
    await check("刷新列表不冒充重载，待应用提示保持", `!document.querySelector('[data-pi-reload-notice]').hidden`);
    await click("[data-pi-reload]"); await wait("!window.busy");
    await check("重载成功才清除待应用提示", `document.querySelector('[data-pi-reload-notice]').hidden`);
    await run(`document.querySelector('.pi-package-actions button:nth-child(2)').click();document.querySelector('[data-pi-filters]').value='invalid'`);
    await click("[data-pi-save-filters]");
    await check("高级筛选显示所属来源并保留无效编辑供修正", `document.querySelector('[data-pi-filter-source]').textContent==='npm:@example/pi-tools@1.0.0'&&document.querySelector('[data-pi-status]').textContent.includes('筛选格式无效')&&!document.querySelector('[data-pi-filter-editor]').hidden`);
    await click("[data-pi-cancel-filters]");
    await check("收起筛选后焦点回到包分类入口", `document.querySelector('[data-pi-filter-editor]').hidden&&document.activeElement.dataset.piKind==='packages'`);
    await run(`document.querySelector('.pi-package-actions button:nth-child(2)').click()`);
    await run(`document.querySelector('[data-pi-filters]').value='{"skills":[]}'`);
    await click("[data-pi-save-filters]"); await wait("!window.busy");
    assert.deepEqual(calls.at(-1), { action: "filter", source: data.packages[0].source, scope: "user", filters: { skills: [] } });
    await run(`document.querySelector('.pi-package-row .pi-remove-button').click();document.querySelector('.pi-package-row .pi-remove-confirm button:last-child').click()`);
    await check("取消移除关闭确认并恢复焦点，不执行移除操作", `!document.querySelector('[data-confirm-remove]')&&document.activeElement.classList.contains('pi-remove-button')`);
    assert.equal(calls.some(call => call.action === "remove"), false);
    await click('[data-pi-kind="skills"]');
    await click('[data-disable-skill]');
    await check("单项停用明确保留同包其他技能与文件", `document.querySelector('[data-confirm-skill]').closest('.pi-remove-confirm').textContent.includes('同包其他技能和源文件保留')`);
    await check("技能停用确认使用中文名", `document.querySelector('[data-confirm-skill]').closest('.pi-remove-confirm').textContent.includes('停用“需求评审”')`);
    await run(`document.querySelector('[data-confirm-skill]').closest('.pi-resource-card').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await run("new Promise(resolve=>setTimeout(resolve,180))");
    await fs.writeFile(path.join(artifacts, "single-skill-disable-confirmation.png"), (await win.webContents.capturePage()).toPNG());
    await click('[data-confirm-skill]'); await wait("!window.busy");
    assert.deepEqual(calls.at(-1), { action: "disable-skill", source: "/fixture/first/SKILL.md", scope: "user" });
    data.skills[0].control.disabled = true;
    await click('[data-pi-refresh]'); await wait(ready);
    await check("停用待重载时禁止重复操作和插入技能命令", `document.querySelector('[data-disable-skill]').disabled&&document.querySelector('[data-pi-command="/skill:qa-requirement-review"]').disabled`);
    await click('[data-pi-items="skills"] .pi-remove-button');
    await check("技能卸载确认明确影响整包、范围、本地源文件与重载", `document.querySelector('[data-pi-items=skills] .pi-remove-confirm').textContent.includes('卸载整个包')&&document.querySelector('[data-pi-items=skills] .pi-remove-confirm').textContent.includes('保留源文件')&&document.querySelector('[data-pi-items=skills] .pi-remove-confirm').textContent.includes('重载')`);
    await fs.writeFile(path.join(artifacts, "uninstall-confirmation.png"), (await win.webContents.capturePage()).toPNG());
    await click('[data-pi-items="skills"] .pi-remove-confirm button:last-child');
    await click('[data-pi-kind="extensions"]');
    await click('[data-pi-items="extensions"] .pi-remove-button');
    gate = Promise.withResolvers();
    await click('[data-pi-items="extensions"] [data-confirm-remove]'); await wait("window.busy");
    await check("卸载期间阻止重复确认与关闭设置", `document.querySelector('[data-confirm-remove]').disabled&&document.querySelector('[data-close]').disabled`);
    gate.resolve(); gate = undefined; await wait("!window.busy");
    assert.deepEqual(calls.at(-1), { action: "remove", source: data.packages[1].source, scope: "project" });
    await check("卸载成功明确提示重载而非宣称已停用", `document.querySelector('[data-pi-status]').textContent.includes('资源包已卸载')&&!document.querySelector('[data-pi-reload-notice]').hidden`);
    await click('[data-pi-kind="packages"]');
    manageFailure = true;
    await click("[data-pi-install]"); await wait("!window.busy");
    await check("安装失败可重试，明确提示核对安装事实", `document.querySelector('[data-pi-status]').dataset.state==='error'&&document.querySelector('[data-pi-status]').textContent.includes('可能已改动磁盘')&&!document.querySelector('[data-pi-install]').disabled`);
    manageFailure = true;
    await click('.pi-package-row .pi-remove-button');
    await click('[data-confirm-remove]'); await wait("!window.busy");
    await check("卸载失败不移走包条目，保留重试并提示核对磁盘", `document.querySelectorAll('.pi-package-row').length===2&&document.querySelector('[data-pi-status]').dataset.state==='error'&&!document.querySelector('[data-confirm-remove]').disabled`);
    await click('.pi-remove-confirm button:last-child');
    manageFailure = false;
    listFailure = true;
    await click("[data-pi-refresh]"); await wait(ready);
    await check("读取失败显示错误并保留刷新入口", `document.querySelector('[data-pi-status]').textContent.includes('模拟资源读取失败')`);
    listFailure = false;
    data.projectTrusted = false;
    data.diagnostics = [{ type: "error", path: "/fixture/<script>.ts", message: "<img src=x onerror=alert(1)>" }];
    await click("[data-pi-refresh]"); await wait(ready);
    await check("未信任项目不允许安装或修改项目包，个人包操作仍可用", `document.querySelector('[data-pi-scope] option[value=project]').disabled&&[...document.querySelectorAll('.pi-package-row')[1].querySelectorAll('button')].every(button=>button.disabled)&&!document.querySelector('.pi-package-row button').disabled`);
    await check("未信任项目也禁用扩展卡片上的卸载入口", `document.querySelector('[data-pi-items=extensions] .pi-remove-button').disabled`);
    data.skills[0].package.configured = false;
    await click("[data-pi-refresh]"); await wait(ready);
    await check("卸载未重载的资源保留显示但不能重复卸载", `!document.querySelector('[data-pi-items=skills] .pi-remove-button')&&document.querySelector('[data-pi-items=skills]').textContent.includes('重载资源后核对')`);
    await run(`document.querySelector('[data-pi-diagnostics]').open=true`);
    await check("诊断以安全文本展示，带数量、错误级别和来源路径", `document.querySelector('[data-pi-diagnostic-count]').textContent==='1 条'&&document.querySelector('.pi-diagnostic-row').textContent.includes('<img')&&!document.querySelector('.pi-diagnostic-row img')&&document.querySelector('.pi-diagnostic-row code').textContent.includes('<script>')`);
    for (const kind of ["skills", "prompts", "extensions", "packages"]) data[kind] = [];
    await click("[data-pi-refresh]"); await wait(ready);
    await check("各资源分类提供空状态，数量同步为零", `document.querySelectorAll('.pi-resource-empty').length===4&&[...document.querySelectorAll('[data-pi-count]')].every(count=>count.textContent==='0')`);
    listGate = Promise.withResolvers(); const late = listGate;
    await click("[data-pi-refresh]"); await wait("document.querySelector('[data-pi-refresh]').disabled");
    await click("#settings-theme-tab");
    late.resolve(); await run("new Promise(resolve=>setTimeout(resolve,30))");
    await check("切换设置分类后迟到资源响应不覆盖当前界面", `!document.querySelector('#settings-theme-panel').hidden&&document.querySelector('#settings-resources-panel').hidden&&document.querySelector('#model-settings-title').textContent==='主题'`);
    // 直接运行页面的命令菜单代码，核对中文检索与原始命令插入的衔接。
    const rendererSource = await fs.readFile(path.join(renderer, "renderer.js"), "utf8");
    const menuSource = rendererSource.slice(rendererSource.indexOf("const slashMenu ="), rendererSource.indexOf("// 解析内置命令"));
    await click('[data-close]');
    await run(`(async()=>{
      const {getPiSkillName,translatePiDescription}=await import('./components/settings/pi-resource-translations.js');
      const input=document.querySelector('#message-input'),composerState={sessionId:'fixture-a'};
      ${menuSource}
      slashCommands=[{name:'skill:playwright-trace',source:'skill',description:'Inspect Playwright trace files from the command line — list actions, view requests, console, errors, snapshots and screenshots.'}];
      slashCommandsOwner=composerState.sessionId;
      input.disabled=false;input.readOnly=false;input.value='/追踪';updateSlashMenu();
    })()`);
    await check("命令菜单可按中文技能名检索并显示中文描述", `!document.querySelector('#slash-command-menu').hidden&&document.querySelector('.slash-command-label').textContent==='浏览器测试追踪分析'&&document.querySelector('.slash-command-description').textContent.includes('通过命令行分析 Playwright 测试追踪文件')`);
    await click('.slash-command-item');
    await check("中文检索选中技能仍插入官方命令", `document.querySelector('#message-input').value==='/skill:playwright-trace'&&document.querySelector('#slash-command-menu').hidden`);
    console.log(`Pi 资源设置 ${passed} 项页面检查通过。截图：${artifacts}`);
  } finally { win.destroy(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = path.resolve(__dirname, "../..");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "test-data-catalog-check-"));
  app.setPath("userData", path.join(temporary, "user-data"));
  app.setPath("sessionData", path.join(temporary, "user-data"));
  await app.whenReady();

  const indexHtml = await readFile(path.join(root, "src/renderer/index.html"), "utf8");
  const spriteStart = indexHtml.indexOf('<svg class="icon-definitions"');
  const spriteEnd = indexHtml.indexOf("</svg>", spriteStart) + "</svg>".length;
  const iconSprite = indexHtml.slice(spriteStart, spriteEnd);
  const panelUrl = pathToFileURL(path.join(root, "src/renderer/components/right-sidebar-panel.js")).href;
  const themeUrl = pathToFileURL(path.join(root, "src/renderer/styles/codex-theme.css")).href;
  const stylesUrl = pathToFileURL(path.join(root, "src/renderer/styles/right-sidebar-panel.css")).href;
  const shellStylesUrl = pathToFileURL(path.join(root, "src/renderer/styles/right-sidebar.css")).href;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${themeUrl}">
<link rel="stylesheet" href="${shellStylesUrl}">
<link rel="stylesheet" href="${stylesUrl}">
<style>
  html, body { margin: 0; min-height: 100%; background: var(--page); color: var(--text); font-family: -apple-system, "PingFang SC", sans-serif; }
  #body { width: 424px; height: 860px; overflow: auto; box-sizing: border-box; }
</style></head>
<body>
  ${iconSprite}
  <div id="tabs"></div>
  <div id="body"></div>
  <dialog id="confirm"></dialog>
  <script type="module">
    import { createRightSidebarPanel } from "${panelUrl}";
    const panel = createRightSidebarPanel({
      body: document.getElementById("body"),
      tabs: document.getElementById("tabs"),
      confirmDialog: document.getElementById("confirm"),
    });
    window.__panel = panel;
    panel.open()
      .then(() => { window.__ready = true; })
      .catch((error) => { window.__error = String(error); });
  </script>
</body></html>`;
  await writeFile(path.join(temporary, "index.html"), html);

  const win = new BrowserWindow({
    width: 480,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "test-data-catalog.preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  await win.loadFile(path.join(temporary, "index.html"));

  const run = (source) => win.webContents.executeJavaScript(source);
  const wait = (expression) => run(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error("等待失败: "+${JSON.stringify(expression)});})()`);
  let passed = 0;
  const check = async (name, expression) => {
    assert.ok(await run(expression), name);
    passed += 1;
    console.log("PASS " + name);
  };

  try {
    await wait(`window.__ready===true || window.__error!==undefined`);
    assert.equal(await run(`window.__error ?? null`), null);
    await check("打开侧栏显示工作台卡片", `document.querySelectorAll('.right-panel__card').length===4`);

    await run(`[...document.querySelectorAll('.right-panel__card')].find((button)=>button.textContent.includes('测试数据')).click()`);
    await wait(`document.querySelector('.case-catalog')!==null`);

    await check("顶部显示项目与模块/用例/断言计数", `document.querySelector('.right-panel__nav-title').textContent==='测试数据 · 演示项目'&&document.querySelector('.right-panel__select').selectedOptions[0].textContent==='演示项目'&&[...document.querySelectorAll('.case-catalog__stat')].map((node)=>node.textContent.replace(/\\s+/g,'')).join(',')==='2模块,3用例,5断言'&&document.querySelector('.case-catalog__policy').textContent==='只读'`);
    await check("按页面归为两个模块", `document.querySelectorAll('.case-module').length===2&&document.querySelector('.case-module__name').textContent==='合同管理'&&document.querySelector('.case-module__page').textContent.includes('/pms/Contract')`);
    await check("模块内用例按优先级排序", `document.querySelector('.case-module .case-card__name').textContent==='T2 权限拒绝时列表为空'&&document.querySelector('.case-module .case-card__priority').textContent==='P0'`);
    await check("展开前不显示断言，展开后显示断言与来源", `(()=>{const card=document.querySelector('.case-module .case-card');const body=card.querySelector('.case-card__body');const before=body.hidden;card.querySelector('.case-card__head').click();return before&&!body.hidden&&body.textContent.includes('列表 0 行')&&body.textContent.includes('需求声明')&&card.querySelector('.case-card__head').getAttribute('aria-expanded')==='true';})()`);
    await check("文件清理区保留原始文件", `document.querySelectorAll('.right-panel__file').length===3&&document.querySelector('.right-panel__files-title').textContent.includes('3 个')`);
    await check("未标准化资产有提示", `document.querySelector('.right-panel__note').textContent.includes('1 个资产未包含')`);
    await check("面板没有横向溢出", `document.getElementById('body').scrollWidth<=document.getElementById('body').clientWidth`);
    await run(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH) {
      await writeFile(process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='空态';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("搜索按用例名过滤", `document.querySelectorAll('.case-module').length===1&&document.querySelectorAll('.case-card').length===1&&document.querySelector('.case-card__name').textContent.includes('空态')`);
    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='需求声明';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("搜索命中断言来源", `document.querySelectorAll('.case-card').length===1&&document.querySelector('.case-card__name').textContent==='T2 权限拒绝时列表为空'`);
    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("清空搜索恢复全部用例", `document.querySelectorAll('.case-card').length===3`);

    assert.deepEqual(errors, [], "页面不应有 console error");
    console.log(`PASS ${passed} 项检查`);
  } catch (error) {
    console.error("FAIL", error);
    process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    app.quit();
  }
}

main();

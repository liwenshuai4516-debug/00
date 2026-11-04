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
    await check("打开侧栏显示工作台卡片", `document.querySelectorAll('.right-panel__card').length===5`);

    await run(`[...document.querySelectorAll('.right-panel__card')].find((button)=>button.textContent.includes('测试数据')).click()`);
    await wait(`document.querySelector('.case-catalog')!==null`);

    await check("顶部显示项目与模块/子模块/用例/断言计数", `document.querySelector('.right-panel__nav-title').textContent==='测试数据 · 演示项目'&&document.querySelector('.right-panel__select').selectedOptions[0].textContent==='演示项目'&&[...document.querySelectorAll('.case-catalog__stat')].map((node)=>node.textContent.replace(/\\s+/g,'')).join(',')==='1模块,2子模块,3用例,5断言'&&document.querySelector('.case-catalog__policy').textContent==='只读'`);
    await check("按 modulePath 展示两级模块", `document.querySelectorAll('.case-module').length===3&&document.querySelector('.case-module[data-depth="0"] > .case-module__head .case-module__name').textContent==='合同管理'&&[...document.querySelectorAll('.case-module--nested > .case-module__head .case-module__name')].map((node)=>node.textContent).join(',')==='经营合同,采购合同'`);
    await check("子模块显示页面、角色与汇总条数", `(()=>{const node=document.querySelectorAll('.case-module--nested')[0];return node.querySelector('.case-module__page').textContent.includes('/pms/OperationContract')&&node.querySelector('.case-module__page').textContent.includes('管理员')&&node.querySelector('.case-module__count').textContent==='2 条'&&node.querySelectorAll('.case-card').length===2;})()`);
    await check("模块内用例按优先级排序", `document.querySelector('.case-module--nested .case-card__name').textContent==='T2 权限拒绝时列表为空'&&document.querySelector('.case-module--nested .case-card__priority').textContent==='P0'`);
    await check("折叠行显示断言预览与业务/前置计数", `document.querySelector('.case-module--nested .case-card__assertion-preview').textContent.includes('列表 0 行')&&document.querySelector('.case-module--nested .case-card__meta').textContent.includes('业务 1')&&document.querySelector('.case-module--nested .case-card__meta').textContent.includes('前置 1')`);
    await run(`document.querySelector('.case-module[data-depth="0"] > .case-module__head').click()`);
    await check("折叠一级模块隐藏整棵子树", `document.querySelector('.case-module[data-depth="0"] > .case-module__body').hidden===true&&document.querySelector('.case-module[data-depth="0"] > .case-module__head').getAttribute('aria-expanded')==='false'`);
    await run(`document.querySelector('.case-module[data-depth="0"] > .case-module__head').click()`);
    await check("重新展开一级模块恢复子树与箭头", `document.querySelector('.case-module[data-depth="0"] > .case-module__body').hidden===false&&document.querySelector('.case-module[data-depth="0"] > .case-module__head').getAttribute('aria-expanded')==='true'&&getComputedStyle(document.querySelector('.case-module[data-depth="0"] > .case-module__head .case-module__chevron')).transform!=='none'`);
    await check("展开前不显示断言，展开后按业务/前置分组显示", `(()=>{const card=document.querySelector('.case-module--nested .case-card');const body=card.querySelector('.case-card__body');const before=body.hidden;card.querySelector('.case-card__head').click();const labels=[...body.querySelectorAll('.case-assertions__label')].map((node)=>node.textContent).join(',');return before&&!body.hidden&&labels==='业务断言 1,前置断言 1'&&body.textContent.includes('列表 0 行')&&body.textContent.includes('需求声明')&&body.textContent.includes('最近运行 失败')&&body.textContent.includes('模块 合同管理 / 经营合同')&&card.querySelector('.case-card__head').getAttribute('aria-expanded')==='true';})()`);
    await run(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH) {
      await writeFile(process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await run(`document.querySelector('.case-module--nested .case-card__edit').click()`);
    await check("打开断言编辑器", `document.querySelectorAll('.case-editor__row').length===2&&document.querySelector('.case-editor__text').value==='列表 0 行'`);
    await run(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_EDITOR_SCREENSHOT_PATH) {
      await writeFile(process.env.TEST_DATA_EDITOR_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await run(`document.querySelector('.case-editor__text').value='列表 0 行（已编辑）';document.querySelector('.case-editor__text').dispatchEvent(new Event('input',{bubbles:true}))`);
    await run(`document.querySelector('.case-editor__button--primary').click()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('断言已保存')`);
    await check("保存断言后刷新展示", `document.querySelector('.case-module--nested .case-card__body').textContent.includes('列表 0 行（已编辑）')&&document.querySelector('.case-editor')===null`);
    await check("顶部显示最近运行结果", `document.querySelector('.case-run').textContent==='失败'&&document.querySelector('.case-run').dataset.status==='failed'&&document.querySelector('.case-catalog__run-text').textContent.includes('2/3 通过')`);
    await check("用例行显示最近状态", `[...document.querySelectorAll('.case-card__status')].map((node)=>node.textContent).join(',')==='失败,通过,通过'`);
    await check("未标准化资产有提示", `document.querySelector('.right-panel__note').textContent.includes('1 个资产未包含')&&document.querySelectorAll('.right-panel__file').length===0`);
    await check("面板没有横向溢出", `document.getElementById('body').scrollWidth<=document.getElementById('body').clientWidth`);

    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='空态';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("搜索按用例名保留祖先与命中子模块", `document.querySelectorAll('.case-module').length===2&&document.querySelectorAll('.case-module--nested').length===1&&document.querySelectorAll('.case-card').length===1&&document.querySelector('.case-module--nested .case-module__name').textContent==='采购合同'&&document.querySelector('.case-card__name').textContent.includes('空态')`);
    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='需求声明';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("搜索命中断言来源", `document.querySelectorAll('.case-card').length===1&&document.querySelector('.case-card__name').textContent==='T2 权限拒绝时列表为空'&&document.querySelector('.case-module--nested .case-module__name').textContent==='经营合同'`);
    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='经营合同';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("搜索命中模块路径显示该分支全部用例", `document.querySelectorAll('.case-module--nested').length===1&&document.querySelectorAll('.case-card').length===2`);
    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("清空搜索恢复全部用例", `document.querySelectorAll('.case-module').length===3&&document.querySelectorAll('.case-card').length===3`);

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

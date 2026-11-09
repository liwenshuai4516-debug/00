const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { readFile, writeFile, rm } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
// sessionData 必须在 ready 前设置，异步建目录会让 Chromium 抢先初始化。
const temporary = mkdtempSync(path.join(os.tmpdir(), "test-data-catalog-check-"));
mkdirSync(path.join(temporary, "user-data"), { recursive: true });
app.setPath("userData", path.join(temporary, "user-data"));
app.setPath("sessionData", path.join(temporary, "user-data"));

async function main() {
  const root = path.resolve(__dirname, "../..");
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
  <dialog id="confirm">
    <h2 id="right-panel-confirm-title"></h2>
    <p id="right-panel-confirm-message"></p>
    <div><button type="button" data-cancel>取消</button><button type="button" data-confirm>确定</button></div>
  </dialog>
  <script type="module">
    import { createRightSidebarPanel } from "${panelUrl}";
    const panel = createRightSidebarPanel({
      body: document.getElementById("body"),
      tabs: document.getElementById("tabs"),
      confirmDialog: document.getElementById("confirm"),
    });
    window.__panel = panel;
    document.addEventListener("insert-composer-text", (event) => {
      window.__insertedPrompt = event.detail?.text ?? "";
      if (event.detail) event.detail.accepted = true;
    });
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

    await check("列表每页 50 条并显示正式版本、候选和回归状态", `document.querySelectorAll('.case-card').length===50&&document.querySelector('.case-catalog__summary').textContent.includes('52 条')&&document.querySelector('.case-card').textContent.includes('正式 0001')&&document.querySelector('.case-card').textContent.includes('新候选 0002')&&document.querySelector('.case-card').textContent.includes('最近回归 通过')`);
    await check("列表不预取详情并移除旧编辑、标记入口", `(async()=>{const stats=await window.agent.getTestStats();return stats.details===0&&document.querySelectorAll('.case-card__body,.case-editor,.case-card__workflow').length===0;})()`);
    await run(`document.querySelector('.case-card__head').click()`);
    await wait(`document.querySelector('.case-version-detail')!==null`);
    await check("展开只读步骤、业务预期与来源、业务和前置断言", `(()=>{const body=document.querySelector('.case-card__body');return body.textContent.includes('打开合同列表')&&body.textContent.includes('合同需求第 3 条')&&body.textContent.includes('业务断言 1')&&body.textContent.includes('前置断言 1')&&body.textContent.includes('task-source')&&body.querySelectorAll('input,textarea').length===0;})()`);
    await check("面板没有横向溢出", `document.getElementById('body').scrollWidth<=document.getElementById('body').clientWidth`);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH) await writeFile(process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    await run(`(()=>{const select=document.querySelector('.case-version-detail select');select.value='0002';select.dispatchEvent(new Event('change'));})()`);
    await wait(`document.querySelector('.case-version-detail')?.textContent.includes('新候选步骤')`);
    await check("可按需查看候选版本", `document.querySelector('.case-version-detail select').value==='0002'&&document.querySelector('.case-version-detail').textContent.includes('run-candidate')`);
    await run(`[...document.querySelectorAll('.case-card__edit')].find(button=>button.textContent==='生成执行提示').click()`);
    await check("执行提示只选正式 case，不使用 grep、all 或自动发送", `window.__insertedPrompt.includes("--project 'a' --cases 'contracts'")&&window.__insertedPrompt.includes('当前列表版本 0001')&&!window.__insertedPrompt.includes('--grep')&&!window.__insertedPrompt.includes('--all')&&document.querySelector('.right-panel__status').textContent.includes('请确认后发送')`);
    await run(`document.querySelector('[data-case-id="candidate"] .case-card__head').click()`);
    await wait(`document.querySelector('[data-case-id="candidate"] .case-version-detail')!==null`);
    await check("候选用例没有回归执行入口", `![...document.querySelectorAll('[data-case-id="candidate"] button')].some(button=>button.textContent==='生成执行提示')`);
    await run(`[...document.querySelectorAll('.case-catalog__pager button')].find(button=>button.textContent==='下一页').click()`);
    await wait(`document.querySelectorAll('.case-card').length===2`);
    await check("翻页后最后两条可见且详情缓存清空", `document.querySelector('.case-catalog__pager').textContent.includes('第 2 / 2 页')&&document.querySelectorAll('.case-card__body').length===0`);
    const search = async (query) => {
      await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value=${JSON.stringify(query)};input.form.requestSubmit();})()`);
      await wait(`document.getElementById('body').getAttribute('aria-busy')==='false'`);
    };
    await search('仅候选');
    await check("搜索传到服务端并重置第一页", `(async()=>{const last=(await window.agent.getTestStats()).lists.at(-1);return last.page===1&&last.query==='仅候选'&&document.querySelectorAll('.case-card').length===1&&document.querySelector('.case-catalog__pager').textContent.includes('第 1 / 1 页');})()`);
    await run(`document.querySelector('.case-card__head').click()`);
    await wait(`document.querySelector('.case-version-detail')!==null`);
    await run(`[...document.querySelectorAll('.case-card__edit')].find(button=>button.textContent==='删除整个用例').click()`);
    await wait(`document.getElementById('confirm').open`);
    await check("整例删除说明全部版本及历史保留", `document.getElementById('right-panel-confirm-message').textContent.includes('全部版本和脚本')&&document.getElementById('right-panel-confirm-message').textContent.includes('历史任务和运行快照保留')`);
    await run(`document.querySelector('#confirm [data-cancel]').click()`);
    await check("取消删除保留用例", `document.querySelectorAll('.case-card').length===1`);
    await run(`[...document.querySelectorAll('.case-card__edit')].find(button=>button.textContent==='删除整个用例').click()`);
    await wait(`document.getElementById('confirm').open`);
    await run(`document.querySelector('#confirm [data-confirm]').click()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('已删除整个用例')`);
    await check("删除使用 case 编号和列表哈希，刷新后展示空态", `(async()=>{const deletion=(await window.agent.getTestStats()).deletions[0];return deletion.caseId==='candidate'&&deletion.assetHash==='hash-1'&&document.querySelectorAll('.case-card').length===0;})()`);
    await check("其他测试数据文件仍可管理", `document.querySelector('.case-data-file').textContent.includes('api/sample.json')`);
    await run(`document.querySelector('.case-data-file button').click()`);
    await wait(`document.getElementById('confirm').open`);
    await run(`document.querySelector('#confirm [data-confirm]').click()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('测试数据文件已删除')`);
    await check("其他测试数据删除后刷新", `document.querySelectorAll('.case-data-file').length===0`);
    await search('');
    await run(`document.querySelector('[data-case-id="contracts"] .case-card__head').click()`);
    await wait(`document.querySelector('.case-version-detail')!==null`);
    await run(`(()=>{const select=document.querySelector('.case-version-detail select');select.value='0002';select.dispatchEvent(new Event('change'));const env=document.querySelector('[aria-label="选择项目环境"]');env.value='b';env.dispatchEvent(new Event('change'));})()`);
    await wait(`document.querySelector('.case-catalog__summary')?.textContent.includes('0 条')`);
    await run(`new Promise(resolve=>setTimeout(resolve,150))`);
    await check("换项目后迟到详情不覆盖新列表", `document.querySelectorAll('.case-version-detail,.case-card').length===0&&document.querySelector('[aria-label="选择项目环境"]').value==='b'`);

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

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
  const temporary = await mkdtemp(path.join(os.tmpdir(), "test-reports-check-"));
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
      preload: path.join(__dirname, "test-reports.preload.cjs"),
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
    await check("工作台增加测试报告卡片", `document.querySelectorAll('.right-panel__card').length===5&&[...document.querySelectorAll('.right-panel__card-title')].map((node)=>node.textContent).join(',')==='项目环境,测试数据,测试报告,文件浏览,浏览器'`);

    await run(`[...document.querySelectorAll('.right-panel__card')].find((button)=>button.textContent.includes('测试报告')).click()`);
    await wait(`document.querySelectorAll('.report-card').length===50`);
    await check("报告列表每页50条，总数包含后续页", `document.querySelector('.report-summary').textContent.includes('53')&&document.querySelector('[aria-label="报告列表分页"]').textContent.includes('第 1 / 2 页')&&window.__reportFixture.stats().details.length===0`);
    await check("类型数量基于完整集合", `[...document.querySelectorAll('.report-filter__button')].map((node)=>node.textContent).join(',')==='全部53,UI52,接口1'`);
    await check("报告名称使用模块与日期", `document.querySelector('.report-card[data-kind="api"] .report-card__title').textContent==='采购合同 2026-11-04'`);
    await run(`document.querySelector('[aria-label="报告列表分页"] button:last-child').click()`);
    await wait(`document.querySelectorAll('.report-card').length===3`);
    await check("报告第二页可达，接口筛选在服务端重新分页", `window.__reportFixture.stats().lists.at(-1).page===2`);
    await run(`[...document.querySelectorAll('.report-filter__button')].find((button)=>button.textContent.includes('接口')).click()`);
    await wait(`document.querySelectorAll('.report-card').length===1`);
    await check("从后续页筛选接口不遗漏首页之外报告", `document.querySelector('.report-card').dataset.kind==='api'&&window.__reportFixture.stats().lists.at(-1).kind==='api'&&window.__reportFixture.stats().lists.at(-1).page===1`);
    await run(`[...document.querySelectorAll('.report-filter__button')].find((button)=>button.textContent.includes('全部')).click()`);
    await wait(`document.querySelectorAll('.report-card').length===50`);
    await run(`(()=>{const head=document.querySelectorAll('.report-card__head')[1];head.focus();head.click();})()`);
    await wait(`document.querySelector('.report-detail')!==null`);
    await check("详情按需读取，结论与失败摘要覆盖全部103条", `(()=>{const body=document.querySelector('.report-detail');return window.__reportFixture.stats().details.length===1&&body.querySelector('.report-verdict__rate').textContent==='99%'&&body.textContent.includes('共 103 个用例')&&body.textContent.includes('失败与异常（1）')&&body.textContent.includes('T103 合同列表加载')&&body.textContent.includes('expect(received).toBe(expected)')&&body.textContent.includes('failure.png')&&body.querySelector('.report-cases').querySelectorAll('.report-test').length===50&&!body.textContent.includes('本次没有失败');})()`);
    await check("详情展示准确版本、来源、用途与证据边界", `(()=>{const body=document.querySelector('.report-detail');return body.textContent.includes('正式回归')&&body.querySelector('.report-sources').textContent.includes('case-a · 版本 0002 · 来源 task-source')&&body.textContent.includes('Node 22.19.0')&&body.textContent.includes('已关闭（私有登录态）')&&body.textContent.includes('附件缺失：failure.png');})()`);
    await check("展开保留标题焦点且逐例默认折叠", `document.activeElement===document.querySelectorAll('.report-card__head')[1]&&!document.querySelector('.report-cases').open`);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    if (process.env.TEST_REPORTS_SCREENSHOT_PATH) await writeFile(process.env.TEST_REPORTS_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('.report-cases > summary').click();document.querySelector('[aria-label="逐例结果分页"] button:last-child').click()`);
    await wait(`document.querySelector('[aria-label="逐例结果分页"]')?.textContent.includes('第 2 / 3 页')`);
    await check("逐例第二页保持展开", `document.querySelector('.report-cases').open&&document.querySelector('.report-cases .report-test__name').textContent==='T51 合同列表加载'`);
    await run(`document.querySelector('[aria-label="逐例结果分页"] button:last-child').click()`);
    await wait(`document.querySelector('[aria-label="逐例结果分页"]')?.textContent.includes('第 3 / 3 页')`);
    await check("第100条后结果没有丢失", `document.querySelector('.report-cases').querySelectorAll('.report-test').length===3&&document.querySelector('.report-cases').textContent.includes('T103 合同列表加载')`);
    await run(`document.querySelector('[aria-label="逐例结果分页"] button:first-child').click()`);
    await wait(`document.querySelector('[aria-label="逐例结果分页"]')?.textContent.includes('第 2 / 3 页')`);
    await run(`document.querySelector('[aria-label="逐例结果分页"] button:first-child').click()`);
    await wait(`document.querySelector('[aria-label="逐例结果分页"]')?.textContent.includes('第 1 / 3 页')`);
    await check("逐例可返回第一页", `document.querySelector('.report-cases .report-test__name').textContent==='T1 合同列表加载'`);
    await check("报告面板没有横向溢出", `document.getElementById('body').scrollWidth<=document.getElementById('body').clientWidth`);
    await check("无效摘要提示保留", `[...document.querySelectorAll('.right-panel__note')].some((node)=>node.textContent.includes('1 个批次缺少有效的 summary.json'))`);

    await run(`window.__reportFixture.holdList();window.dispatchEvent(new Event('focus'))`);
    await wait(`window.__reportFixture.stats().heldList`);
    await run(`window.__panel.open()`);
    await run(`[...document.querySelectorAll('.right-panel__card')].find((button)=>button.textContent.includes('测试报告')).click()`);
    await wait(`document.querySelectorAll('.report-card').length===50&&!document.querySelector('[aria-label="刷新测试报告"]').disabled`);
    await run(`window.__reportFixture.releaseList()`);
    await run(`new Promise((resolve)=>setTimeout(resolve,30))`);
    await check("同项目迟到列表不覆盖最新请求", `!document.getElementById('body').textContent.includes('迟到列表')`);

    // 重新进入面板后让下一次详情延迟，再切换项目。
    await run(`window.__reportFixture.holdDetail();document.querySelectorAll('.report-card__head')[1].click()`);
    await wait(`window.__reportFixture.stats().heldDetail`);
    await run(`(()=>{const select=document.querySelector('.right-panel__select');select.value='b';select.dispatchEvent(new Event('change'));})()`);
    await wait(`document.querySelectorAll('.report-card').length===1`);
    await run(`window.__reportFixture.releaseDetail()`);
    await run(`new Promise((resolve)=>setTimeout(resolve,30))`);
    await check("切换项目后的迟到详情不进入新项目", `document.querySelector('.right-panel__nav-title').textContent.includes('另一项目')&&!document.getElementById('body').textContent.includes('迟到详情')&&document.querySelector('.report-detail')===null`);
    await run(`(()=>{const select=document.querySelector('.right-panel__select');select.value='a';select.dispatchEvent(new Event('change'));})()`);
    await wait(`document.querySelectorAll('.report-card').length===50`);
    await run(`document.querySelectorAll('.report-card__head')[1].click()`);
    await wait(`document.querySelector('.report-detail__actions')!==null`);
    await run(`document.querySelector('.report-detail__actions button').click()`);
    await wait(`document.getElementById('confirm').open`);
    await check("删除确认说明不可恢复和版本引用保护", `(()=>{const message=document.getElementById('right-panel-confirm-message').textContent;return message.includes('整个批次目录')&&message.includes('不可恢复')&&message.includes('仍被用例版本引用');})()`);
    await run(`document.querySelector('#confirm [data-confirm]').click()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('已删除测试报告')`);
    await check("删除后重新读取完整统计，保留接口报告", `document.querySelector('.report-summary').textContent.includes('52')&&document.querySelectorAll('.report-card').length===50&&document.querySelector('.report-card[data-kind="api"]')!==null&&!document.getElementById('body').textContent.includes('迟到详情')`);

    assert.deepEqual(errors, [], "页面不应有 console error");
    console.log(`PASS ${passed} 项检查`);
  } catch (error) {
    console.error("FAIL", error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    if (!process.exitCode) await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    else console.error("保留检查现场：" + temporary);
    app.exit(process.exitCode ?? 0);
  }
}

main();

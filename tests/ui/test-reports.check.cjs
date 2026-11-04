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
    await wait(`document.querySelectorAll('.report-card').length===2`);

    await check("报告视图显示项目与统一目录", `document.querySelector('.right-panel__nav-title').textContent==='测试报告 · 演示项目'&&document.querySelector('.right-panel__select').selectedOptions[0].textContent==='演示项目'&&document.querySelector('.right-panel__root-label').textContent==='qa/*/runs'`);
    await check("顶部显示报告状态统计", `[...document.querySelectorAll('.report-summary__stat')].map((node)=>node.textContent.replace(/\\s+/g,'')).join(',')==='2份报告,1通过,1失败'`);
    await check("类型筛选显示 UI 与接口数量", `[...document.querySelectorAll('.report-filter__button')].map((node)=>node.textContent.replace(/\\s+/g,'')).join(',')==='全部2,UI1,接口1'`);
    await check("报告名称使用模块和日期", `document.querySelector('.report-card[data-kind="api"] .report-card__title').textContent==='采购合同 2026-11-04'&&document.querySelector('.report-card[data-kind="ui"] .report-card__title').textContent==='经营合同 2026-11-04'`);
    await check("报告卡片显示类型、状态、时间与统计", `(()=>{const api=document.querySelector('.report-card[data-kind="api"]');const ui=document.querySelector('.report-card[data-kind="ui"]');return api.querySelector('.report-kind').textContent==='接口'&&api.querySelector('.case-run').textContent==='通过'&&api.querySelector('.report-card__meta').textContent.includes('2 例')&&api.querySelector('.report-card__meta').textContent.includes('通过 2')&&ui.querySelector('.case-run').textContent==='失败'&&ui.querySelector('.report-card__meta').textContent.includes('失败 1');})()`);

    await run(`[...document.querySelectorAll('.report-filter__button')].find((button)=>button.textContent.includes('接口')).click()`);
    await check("筛选接口报告", `document.querySelectorAll('.report-card').length===1&&document.querySelector('.report-card').dataset.kind==='api'`);
    await run(`[...document.querySelectorAll('.report-filter__button')].find((button)=>button.textContent.includes('全部')).click()`);
    await wait(`document.querySelectorAll('.report-card').length===2`);

    await run(`(()=>{const head=document.querySelector('.report-card[data-kind="ui"] .report-card__head');head.focus();head.click();})()`);
    await wait(`document.querySelector('.report-card[data-kind="ui"] .report-card__body').textContent.includes('T2 合同列表加载')`);
    await check("展开报告显示摘要、失败与证据", `(()=>{const card=document.querySelector('.report-card[data-kind="ui"]');const body=card.querySelector('.report-card__body');const details=body.querySelector('.report-cases');return card.querySelector('.report-card__head').getAttribute('aria-expanded')==='true'&&!body.hidden&&body.textContent.includes('结论')&&body.textContent.includes('失败与异常（1）')&&body.textContent.includes('通过率 50%')&&body.textContent.includes('T2 合同列表加载')&&body.textContent.includes('expect(received).toBe(expected)')&&body.textContent.includes('failure.png')&&body.textContent.includes('报告问题')&&body.textContent.includes('附件缺失：failure.png')&&body.textContent.includes('Node 22.19.0')&&body.textContent.includes('已关闭（私有登录态）')&&body.textContent.includes('报告文件：qa/ui/runs/ui-run/summary.json')&&details.open===false&&details.querySelector('summary').textContent.includes('查看全部逐例结果（2）');})()`);
    await check("报告摘要显示模块、完成时间与清理事实", `document.querySelector('.report-card[data-kind="ui"] .report-detail__facts').textContent.includes('合同管理 / 经营合同')&&document.querySelector('.report-card[data-kind="ui"] .report-detail__facts').textContent.includes('已删除')`);
    await check("展开详情后焦点保留在报告标题", `document.activeElement===document.querySelector('.report-card[data-kind="ui"] .report-card__head')`);
    await run(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (process.env.TEST_REPORTS_SCREENSHOT_PATH) {
      await writeFile(process.env.TEST_REPORTS_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }

    await run(`document.querySelector('.report-card[data-kind="ui"] .report-cases > summary').click()`);
    await check("按需展开全部逐例结果", `document.querySelector('.report-card[data-kind="ui"] .report-cases').open===true&&document.querySelector('.report-card[data-kind="ui"] .report-cases').textContent.includes('T1 登录成功')`);
    await run(`document.querySelector('.report-card[data-kind="ui"] .report-card__head').click()`);
    await check("再次点击折叠报告", `document.querySelector('.report-card[data-kind="ui"] .report-card__body').hidden===true&&document.querySelector('.report-card[data-kind="ui"] .report-card__head').getAttribute('aria-expanded')==='false'`);

    await check("无效批次有提示", `document.querySelector('.right-panel__note').textContent.includes('1 个批次缺少有效的 summary.json')`);
    await check("报告面板没有横向溢出", `document.getElementById('body').scrollWidth<=document.getElementById('body').clientWidth`);

    await run(`document.querySelector('.report-card[data-kind="ui"] .report-card__head').click()`);
    await wait(`document.querySelector('.report-card[data-kind="ui"] .report-detail__actions')!==null`);
    await run(`document.querySelector('.report-card[data-kind="ui"] .report-detail__actions .right-panel__action--danger').click()`);
    await wait(`document.getElementById('confirm').open`);
    await check("删除报告需要确认整个批次目录", `document.getElementById('right-panel-confirm-message').textContent.includes('整个批次目录')&&document.getElementById('right-panel-confirm-message').textContent.includes('不可恢复')`);
    await run(`document.querySelector('#confirm [data-confirm]').click()`);
    await wait(`document.querySelectorAll('.report-card').length===1`);
    await check("删除后移除报告卡片并保留其他报告", `document.querySelectorAll('.report-card').length===1&&document.querySelector('.report-card').dataset.kind==='api'&&document.querySelector('.right-panel__status').textContent.includes('已删除测试报告')`);

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

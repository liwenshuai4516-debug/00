const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { readFile, writeFile, rm } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
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
  #body { width: 900px; height: 860px; overflow: auto; box-sizing: border-box; }
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
    width: 960,
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
  const clickText = (selector, text) => run(`(()=>{const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find((item)=>item.textContent.trim()===${JSON.stringify(text)});if(!node)throw Error("找不到按钮: "+${JSON.stringify(text)});node.click();})()`);

  try {
    await wait(`window.__ready===true || window.__error!==undefined`);
    assert.equal(await run(`window.__error ?? null`), null);
    await check("打开侧栏显示工作台卡片", `document.querySelectorAll('.right-panel__card').length===5`);

    await run(`[...document.querySelectorAll('.right-panel__card')].find((button)=>button.textContent.includes('测试数据')).click()`);
    await wait(`document.querySelector('.case-workspace')!==null`);

    await check("测试数据改为目录与用例左右布局", `document.querySelectorAll('.case-workspace__tree,.case-workspace__main').length===2&&document.querySelector('.case-workspace__tree .case-folders')!==null&&document.querySelector('.case-workspace__main .case-catalog')!==null`);
    await check("目录树按模块路径分组并显示数量", `(()=>{const tree=document.querySelector('.case-folders');const count=(folder)=>tree.querySelector('[data-folder="'+folder+'"] .case-folder__count')?.textContent;return Boolean(tree)&&['合同管理','经营合同','系统管理','权限'].every((name)=>tree.textContent.includes(name))&&count('合同管理')==='50'&&count('合同管理/经营合同')==='50'&&count('系统管理')==='2'&&count('系统管理/权限')==='2';})()`);
    await check("默认显示最近更新的 50 条并给出统计", `document.querySelectorAll('.case-row').length===50&&document.querySelector('.case-list-head').textContent.includes('52 条用例')&&document.querySelector('.case-catalog__subtitle').textContent.includes('52 条用例')`);

    await clickText(".case-folder__name", "系统管理");
    await wait(`document.querySelectorAll('.case-row').length===2&&document.querySelector('.case-catalog__title').textContent==='系统管理'`);
    await check("选择父目录后只显示该目录用例并重置分页", `(async()=>{const last=(await window.agent.getTestStats()).lists.at(-1);return document.querySelector('.case-catalog__subtitle').textContent.includes('2 条用例')&&last.folder==='系统管理'&&last.page===1&&last.filter==='all'&&last.sort==='updated';})()`);

    await clickText(".case-folder__name", "经营合同");
    await wait(`document.querySelectorAll('.case-row').length===50&&document.querySelector('.case-catalog__title').textContent==='经营合同'`);
    await check("子目录筛选并显示可返回的面包屑", `(async()=>{const last=(await window.agent.getTestStats()).lists.at(-1);const crumbs=document.querySelector('.case-crumbs');return crumbs.textContent.includes('全部用例')&&crumbs.textContent.includes('合同管理')&&crumbs.textContent.includes('经营合同')&&last.folder==='合同管理/经营合同'&&last.page===1;})()`);

    await run(`document.querySelector('.case-folder[data-folder=""] .case-folder__name').click()`);
    await wait(`document.querySelectorAll('.case-row').length===50&&document.querySelector('.case-list-head').textContent.includes('52 条用例')`);
    await check("返回全部用例并恢复完整统计", `document.querySelector('.case-catalog__subtitle').textContent.includes('51 条正式')&&document.querySelector('.case-tree-stats').textContent.includes('51')`);

    await run(`[...document.querySelectorAll('.case-filter__button')].find((button)=>button.textContent.includes('含候选')).click()`);
    await wait(`document.querySelectorAll('.case-row').length===2`);
    await check("状态筛选传到服务端并重置第一页", `(async()=>{const last=(await window.agent.getTestStats()).lists.at(-1);return last.filter==='candidate'&&last.page===1&&document.querySelectorAll('.case-row').length===2;})()`);
    await run(`[...document.querySelectorAll('.case-filter__button')].find((button)=>button.textContent.startsWith('全部')).click()`);
    await wait(`document.querySelectorAll('.case-row').length===50`);

    await run(`(()=>{const select=document.querySelector('.case-catalog__sort');select.value='title';select.dispatchEvent(new Event('change'));})()`);
    await wait(`document.querySelector('.case-catalog__sort').value==='title'`);
    await check("排序传到服务端并重置第一页", `(async()=>{const last=(await window.agent.getTestStats()).lists.at(-1);return last.sort==='title'&&last.page===1;})()`);
    await run(`(()=>{const select=document.querySelector('.case-catalog__sort');select.value='updated';select.dispatchEvent(new Event('change'));})()`);
    await wait(`document.querySelector('.case-catalog__sort').value==='updated'`);

    await run(`document.querySelector('[data-case-id="contracts"] .case-row__head').click()`);
    await wait(`document.querySelector('[data-case-id="contracts"] .case-detail')!==null`);
    await check("展开详情显示步骤、预期、断言与来源", `(()=>{const body=document.querySelector('[data-case-id="contracts"] .case-row__body');return body.textContent.includes('打开合同列表')&&body.textContent.includes('合同需求第 3 条')&&body.textContent.includes('业务断言')&&body.textContent.includes('前置断言')&&body.textContent.includes('task-source')&&body.querySelectorAll('input,textarea').length===0;})()`);
    await check("详情包含版本选择与回归结果", `document.querySelector('[data-case-id="contracts"] .case-detail__version')!==null&&document.querySelector('[data-case-id="contracts"] .case-row__result').textContent.includes('最近回归 通过')`);
    await run(`(()=>{const select=document.querySelector('[data-case-id="contracts"] .case-detail__version');select.value='0002';select.dispatchEvent(new Event('change'));})()`);
    await wait(`document.querySelector('[data-case-id="contracts"] .case-detail')?.textContent.includes('新候选步骤')`);
    await check("可按需查看候选版本", `document.querySelector('[data-case-id="contracts"] .case-detail__version').value==='0002'&&document.querySelector('[data-case-id="contracts"] .case-detail').textContent.includes('run-candidate')`);

    await clickText("[data-case-id=\"contracts\"] .case-actions .right-panel__button", "生成执行提示");
    await check("执行提示只选正式 case，不使用 grep、all 或自动发送", `window.__insertedPrompt.includes("--project 'a' --cases 'contracts'")&&window.__insertedPrompt.includes('当前列表版本 0001')&&!window.__insertedPrompt.includes('--grep')&&!window.__insertedPrompt.includes('--all')&&document.querySelector('.right-panel__status').textContent.includes('请确认后发送')`);

    await run(`document.querySelector('[data-case-id="candidate"] .case-row__head').click()`);
    await wait(`document.querySelector('[data-case-id="candidate"] .case-detail')!==null`);
    await check("候选用例没有回归执行入口", `![...document.querySelectorAll('[data-case-id="candidate"] .case-actions button')].some((button)=>button.textContent.includes('生成执行提示'))`);

    await run(`document.querySelector('.case-pager button:last-child').click()`);
    await wait(`document.querySelectorAll('.case-row').length===2`);
    await check("翻页后最后两条可见且详情缓存清空", `document.querySelector('.case-pager').textContent.includes('第 2 / 2 页')&&document.querySelectorAll('.case-detail').length===0`);

    await run(`(()=>{const input=document.querySelector('.case-toolbar__input');input.value='仅候选';input.form.requestSubmit();})()`);
    await wait(`document.getElementById('body').getAttribute('aria-busy')==='false'&&document.querySelectorAll('.case-row').length===1`);
    await check("搜索传到服务端并重置第一页", `(async()=>{const last=(await window.agent.getTestStats()).lists.at(-1);return last.page===1&&last.query==='仅候选'&&last.folder===''&&document.querySelector('.case-list-head').textContent.includes('1 条用例');})()`);

    await run(`document.querySelector('[data-case-id="candidate"] .case-row__head').click()`);
    await wait(`document.querySelector('[data-case-id="candidate"] .case-detail')!==null`);
    await clickText("[data-case-id=\"candidate\"] .case-actions .right-panel__button", "删除用例");
    await wait(`document.getElementById('confirm').open`);
    await check("整例删除说明全部版本及历史保留", `document.getElementById('right-panel-confirm-message').textContent.includes('全部版本和脚本')&&document.getElementById('right-panel-confirm-message').textContent.includes('历史任务和运行快照保留')`);
    await run(`document.querySelector('#confirm [data-cancel]').click()`);
    await check("取消删除保留用例", `document.querySelectorAll('.case-row').length===1`);
    await clickText("[data-case-id=\"candidate\"] .case-actions .right-panel__button", "删除用例");
    await wait(`document.getElementById('confirm').open`);
    await run(`document.querySelector('#confirm [data-confirm]').click()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('已删除整个用例')`);
    await check("删除使用 case 编号和列表哈希", `(async()=>{const deletion=(await window.agent.getTestStats()).deletions[0];return deletion.caseId==='candidate'&&deletion.assetHash==='hash-1'&&document.querySelectorAll('.case-row').length===0;})()`);
    await check("不再展示其他 qa/data 测试文件", `document.querySelector('.case-data-file')===null&&document.getElementById('body').textContent.includes('没有匹配的用例')`);

    await run(`(()=>{const input=document.querySelector('.case-toolbar__input');input.value='';input.form.requestSubmit();})()`);
    await wait(`document.querySelectorAll('.case-row').length===50`);

    await clickText(".case-catalog__new", "新建用例");
    await wait(`document.querySelector('.case-editor-dialog')?.open===true`);
    await check("新建用例提供手动用例表单", `document.querySelector('.case-editor-dialog').textContent.includes('手动用例')&&document.querySelector('.case-editor-dialog input[name="title"]')!==null&&document.querySelector('.case-editor-dialog textarea[name="steps"]')!==null`);
    await run(`(()=>{const dialog=document.querySelector('.case-editor-dialog');const form=dialog.querySelector('form');form.elements.title.value='手动 · 合同归档后只读';form.elements.folder.value='合同管理/合同归档';form.elements.role.value='合同管理员';form.elements.priority.value='P0';form.elements.description.value='验证归档后不再提供编辑和删除入口。';form.elements.steps.value='进入合同详情\\n点击归档\\n返回列表检查操作入口';form.elements.expected.value='归档后详情只读，编辑与删除入口隐藏。';form.requestSubmit();})()`);
    await wait(`document.querySelector('.case-editor-dialog')?.open===false&&document.querySelector('[data-case-id="manual-1"]')!==null`);
    await check("手动用例创建后按目录落库并展开详情", `(async()=>{const stats=await window.agent.getTestStats();return stats.manualCreates.length===1&&stats.manualCreates[0].input.folder==='合同管理/合同归档'&&document.querySelector('.case-catalog__title').textContent==='合同归档'&&document.querySelector('[data-case-id="manual-1"] .case-row__status').textContent==='手动'&&document.querySelector('[data-case-id="manual-1"] .case-detail__notice').textContent.includes('尚未生成自动化脚本');})()`);
    await check("手动用例详情显示说明、步骤和预期", `(()=>{const body=document.querySelector('[data-case-id="manual-1"] .case-row__body');return body.textContent.includes('验证归档后不再提供编辑和删除入口。')&&body.textContent.includes('进入合同详情')&&body.textContent.includes('归档后详情只读，编辑与删除入口隐藏。');})()`);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_CATALOG_MANUAL_SCREENSHOT_PATH) await writeFile(process.env.TEST_DATA_CATALOG_MANUAL_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());

    await clickText("[data-case-id=\"manual-1\"] .case-actions .right-panel__button", "编辑用例");
    await wait(`document.querySelector('.case-editor-dialog')?.open===true`);
    await check("编辑手动用例时回填已有字段", `document.querySelector('.case-editor-dialog input[name="title"]').value==='手动 · 合同归档后只读'&&document.querySelector('.case-editor-dialog textarea[name="steps"]').value.includes('进入合同详情')`);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_CATALOG_EDITOR_SCREENSHOT_PATH) await writeFile(process.env.TEST_DATA_CATALOG_EDITOR_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    await run(`(()=>{const form=document.querySelector('.case-editor-dialog form');form.elements.title.value='手动 · 合同归档后只读（已编辑）';form.elements.priority.value='P1';form.requestSubmit();})()`);
    await wait(`document.querySelector('.case-editor-dialog')?.open===false&&document.querySelector('[data-case-id="manual-1"] .case-row__title')?.textContent.includes('已编辑')`);
    await check("编辑手动用例生成新版本并保持手动状态", `(async()=>{const stats=await window.agent.getTestStats();const detail=await window.agent.getTestCase('a','manual-1','0002');return stats.manualUpdates.length===1&&detail.revisions.length===2&&document.querySelector('[data-case-id="manual-1"] .case-row__status').textContent==='手动';})()`);

    await clickText("[data-case-id=\"manual-1\"] .case-actions .right-panel__button", "删除用例");
    await wait(`document.getElementById('confirm').open`);
    await run(`document.querySelector('#confirm [data-confirm]').click()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('已删除整个用例')`);
    await check("手动用例可删除", `document.querySelector('[data-case-id="manual-1"]')===null`);

    await run(`document.querySelector('.case-folder[data-folder=""] .case-folder__name').click()`);
    await wait(`document.querySelectorAll('.case-row').length===50`);
    await run(`document.querySelector('[data-case-id="contracts"] .case-row__head').click()`);
    await wait(`document.querySelector('[data-case-id="contracts"] .case-detail')!==null`);
    await clickText("[data-case-id=\"contracts\"] .case-actions .right-panel__button", "设置目录");
    await wait(`document.querySelector('.case-folder-form__input')!==null`);
    await run(`(()=>{const input=document.querySelector('.case-folder-form__input');input.value='合同管理/风险';input.form.requestSubmit();})()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('已设置目录')`);
    await check("设置目录后目录树与卡片路径更新", `(async()=>{const move=(await window.agent.getTestStats()).moves[0];return move.folder==='合同管理/风险'&&move.caseId==='contracts'&&document.querySelector('[data-folder="合同管理/风险"]')!==null&&document.querySelector('[data-case-id="contracts"]')?.textContent.includes('合同管理 / 风险');})()`);

    await check("面板没有横向溢出", `document.getElementById('body').scrollWidth<=document.getElementById('body').clientWidth`);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH) await writeFile(process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());

    await run(`document.getElementById('body').style.width='424px'`);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check("窄右侧栏自动堆叠且无横向溢出", `getComputedStyle(document.querySelector('.case-workspace')).gridTemplateColumns.split(' ').length===1&&document.querySelector('.case-workspace__tree').getBoundingClientRect().width<=document.getElementById('body').clientWidth&&document.getElementById('body').scrollWidth<=document.getElementById('body').clientWidth`);
    await run(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_CATALOG_NARROW_SCREENSHOT_PATH) await writeFile(process.env.TEST_DATA_CATALOG_NARROW_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());

    await run(`document.getElementById('body').style.width='900px'`);
    await run(`document.querySelector('[data-case-id="contracts"] .case-row__head').click()`);
    await wait(`document.querySelector('[data-case-id="contracts"] .case-detail')!==null`);
    await run(`(()=>{const select=document.querySelector('[data-case-id="contracts"] .case-detail__version');select.value='0002';select.dispatchEvent(new Event('change'));const env=document.querySelector('[aria-label="选择项目环境"]');env.value='b';env.dispatchEvent(new Event('change'));})()`);
    await wait(`document.querySelector('.case-catalog__subtitle')?.textContent.includes('0 条')`);
    await run(`new Promise(resolve=>setTimeout(resolve,150))`);
    await check("换项目后迟到详情不覆盖新列表", `document.querySelectorAll('.case-detail,.case-row').length===0&&document.querySelector('[aria-label="选择项目环境"]').value==='b'`);

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

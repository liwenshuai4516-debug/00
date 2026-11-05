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

    await check("顶部显示项目与模块/子模块/用例/断言计数", `document.querySelector('.right-panel__nav-title').textContent==='测试数据 · 演示项目'&&document.querySelector('.right-panel__select').selectedOptions[0].textContent==='演示项目'&&[...document.querySelectorAll('.case-catalog__stat')].map((node)=>node.textContent.replace(/\\s+/g,'')).join(',')==='1模块,2子模块,3用例,5断言'&&document.querySelector('.case-catalog__policy').textContent==='只读'`);
    await check("按 modulePath 展示两级模块", `document.querySelectorAll('.case-module').length===3&&document.querySelector('.case-module[data-depth="0"] > .case-module__head .case-module__name').textContent==='合同管理'&&[...document.querySelectorAll('.case-module--nested > .case-module__head .case-module__name')].map((node)=>node.textContent).join(',')==='经营合同,采购合同'`);
    await check("测试数据项目筛选使用紧凑宽度", `document.querySelector('.right-panel__select').getBoundingClientRect().width<200`);
    await check("一级模块默认展开，子模块与用例默认折叠", `document.querySelector('.case-module[data-depth="0"] > .case-module__body').hidden===false&&[...document.querySelectorAll('.case-module--nested > .case-module__body')].every((node)=>node.hidden===true)&&[...document.querySelectorAll('.case-card__body')].every((node)=>node.hidden===true)`);
    await run(`document.querySelector('.case-module--nested > .case-module__head').click()`);
    await check("展开子模块后仍保持用例折叠", `document.querySelector('.case-module--nested > .case-module__body').hidden===false&&[...document.querySelectorAll('.case-card__body')].every((node)=>node.hidden===true)`);
    await check("子模块显示页面、角色与汇总条数", `(()=>{const node=document.querySelectorAll('.case-module--nested')[0];return node.querySelector('.case-module__page').textContent.includes('/pms/OperationContract')&&node.querySelector('.case-module__page').textContent.includes('管理员')&&node.querySelector('.case-module__count').textContent==='2 条'&&node.querySelectorAll('.case-card').length===2;})()`);
    await check("模块内用例按优先级排序", `document.querySelector('.case-module--nested .case-card__name').textContent==='T2 权限拒绝时列表为空'&&document.querySelector('.case-module--nested .case-card__priority').textContent==='P0'`);
    await check("折叠行显示断言预览与断言计数", `document.querySelector('.case-module--nested .case-card__assertion-preview').textContent.includes('列表 0 行')&&document.querySelector('.case-module--nested .case-card__meta').textContent.includes('业务 1')&&document.querySelector('.case-module--nested .case-card__meta').textContent.includes('前置 1')`);
    await run(`document.querySelector('.case-module[data-depth="0"] > .case-module__head').click()`);
    await check("折叠一级模块隐藏整棵子树", `document.querySelector('.case-module[data-depth="0"] > .case-module__body').hidden===true&&document.querySelector('.case-module[data-depth="0"] > .case-module__head').getAttribute('aria-expanded')==='false'`);
    await run(`document.querySelector('.case-module[data-depth="0"] > .case-module__head').click()`);
    await check("重新展开一级模块恢复子树与箭头", `document.querySelector('.case-module[data-depth="0"] > .case-module__body').hidden===false&&document.querySelector('.case-module[data-depth="0"] > .case-module__head').getAttribute('aria-expanded')==='true'&&getComputedStyle(document.querySelector('.case-module[data-depth="0"] > .case-module__head .case-module__chevron')).transform!=='none'`);
    await check("展开前不显示断言，展开后按业务/前置分组显示", `(()=>{const card=document.querySelector('.case-module--nested .case-card');const body=card.querySelector('.case-card__body');const before=body.hidden;card.querySelector('.case-card__head').click();const labels=[...body.querySelectorAll('.case-assertions__label')].map((node)=>node.textContent).join(',');return before&&!body.hidden&&labels==='业务断言 1,前置断言 1'&&body.textContent.includes('执行步骤 3')&&body.textContent.includes('打开合同列表')&&body.textContent.includes('列表 0 行')&&body.textContent.includes('需求声明')&&body.textContent.includes('最近运行 失败')&&body.textContent.includes('模块 合同管理 / 经营合同')&&card.querySelector('.case-card__head').getAttribute('aria-expanded')==='true';})()`);
    await check("用例头部两行布局、完整标题与状态条", `(()=>{const card=document.querySelector('.case-module--nested .case-card');const head=card.querySelector('.case-card__head');const top=head.querySelector('.case-card__top');const name=card.querySelector('.case-card__name');return top.contains(card.querySelector('.case-card__priority'))&&top.contains(name)&&top.contains(card.querySelector('.case-card__status'))&&head.querySelector('.case-card__meta').textContent.includes('权限')&&card.dataset.status==='failed'&&getComputedStyle(name).whiteSpace==='normal'&&card.querySelectorAll('.case-context').length===3&&card.querySelector('.case-card__files-block').open===false;})()`);
    await run(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH) {
      await writeFile(process.env.TEST_DATA_CATALOG_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await run(`[...document.querySelectorAll('.case-module--nested .case-card__edit')].find((button)=>button.textContent==='编辑步骤').click()`);
    await check("打开执行步骤编辑器", `document.querySelectorAll('.case-editor__row--step').length===3&&document.querySelector('.case-editor__row--step .case-editor__text').value==='打开合同列表'`);
    await run(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (process.env.TEST_DATA_STEPS_EDITOR_SCREENSHOT_PATH) {
      await writeFile(process.env.TEST_DATA_STEPS_EDITOR_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await run(`(()=>{const input=document.querySelector('.case-editor__row--step .case-editor__text');input.value='打开经营合同列表';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await run(`document.querySelector('.case-editor__button--primary').click()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('执行步骤已保存')`);
    await check("保存步骤后刷新展示", `document.querySelector('.case-module--nested .case-card__body').textContent.includes('打开经营合同列表')&&document.querySelector('.case-editor')===null`);

    await run(`[...document.querySelectorAll('.case-module--nested .case-card__edit')].find((button)=>button.textContent==='编辑断言').click()`);
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
    await check("用例筛选与执行范围控件可用", `document.querySelector('.case-filter__workflow').value==='all'&&[...document.querySelector('.case-filter__workflow').options].some((option)=>option.textContent.includes('待复测'))&&document.querySelector('.case-filter__mode').value==='retest'&&document.querySelector('.case-filter__run').textContent==='生成执行提示'`);
    await run(`(()=>{const card=[...document.querySelectorAll('.case-card')].find((node)=>node.querySelector('.case-card__name').textContent==='T2 权限拒绝时列表为空');const select=card.querySelector('.case-card__workflow');select.value='retest';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('.right-panel__status')?.textContent.includes('用例标记已保存')`);
    await check("单条用例可保存待复测标记", `(()=>{const card=[...document.querySelectorAll('.case-card')].find((node)=>node.querySelector('.case-card__name').textContent==='T2 权限拒绝时列表为空');return card.querySelector('.case-mark')?.textContent==='待复测'&&card.querySelector('.case-card__workflow').value==='retest';})()`);
    await run(`(()=>{const select=document.querySelector('.case-filter__workflow');select.value='retest';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelectorAll('.case-card').length===1`);
    await check("按待复测筛选只显示目标用例", `document.querySelectorAll('.case-card').length===1&&document.querySelector('.case-card__name').textContent==='T2 权限拒绝时列表为空'`);
    await run(`(()=>{const select=document.querySelector('.case-filter__workflow');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));window.__insertedPrompt='';})()`);
    await wait(`document.querySelectorAll('.case-card').length===3`);
    await run(`document.querySelector('.case-filter__run').click()`);
    await wait(`window.__insertedPrompt.includes('--grep')`);
    await check("条件复测提示包含精确测试标题和 caseId", `window.__insertedPrompt.includes('--project a --cases 合同')&&window.__insertedPrompt.includes('--grep')&&window.__insertedPrompt.includes('T2 权限拒绝时列表为空')&&window.__insertedPrompt.includes('不要扩展到其他用例')`);
    await run(`(()=>{const select=document.querySelector('.case-filter__mode');select.value='full';select.dispatchEvent(new Event('change',{bubbles:true}));window.__insertedPrompt='';})()`);
    await wait(`document.querySelector('.case-filter__mode').value==='full'`);
    await run(`document.querySelector('.case-filter__run').click()`);
    await wait(`window.__insertedPrompt.includes('--all')`);
    await check("全量复测提示使用 --all 且与条件复测互斥", `window.__insertedPrompt.includes('--project a --all')&&!window.__insertedPrompt.includes('--grep')&&window.__insertedPrompt.includes('全量 UI 复测')`);
    await run(`(()=>{const select=document.querySelector('.case-filter__mode');select.value='retest';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('.case-filter__mode').value==='retest'`);
    await check("面板没有横向溢出", `document.getElementById('body').scrollWidth<=document.getElementById('body').clientWidth`);

    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='空态';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("搜索按用例名保留祖先与命中子模块", `document.querySelectorAll('.case-module').length===2&&document.querySelectorAll('.case-module--nested').length===1&&document.querySelectorAll('.case-card').length===1&&document.querySelector('.case-module--nested .case-module__name').textContent==='采购合同'&&document.querySelector('.case-card__name').textContent.includes('空态')`);
    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='需求声明';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("搜索命中断言来源", `document.querySelectorAll('.case-card').length===1&&document.querySelector('.case-card__name').textContent==='T2 权限拒绝时列表为空'&&document.querySelector('.case-module--nested .case-module__name').textContent==='经营合同'`);
    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='经营合同';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("搜索命中模块路径显示该分支全部用例", `document.querySelectorAll('.case-module--nested').length===1&&document.querySelectorAll('.case-card').length===2`);
    await run(`(()=>{const input=document.querySelector('.case-catalog__search');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await check("清空搜索恢复全部用例", `document.querySelectorAll('.case-module').length===3&&document.querySelectorAll('.case-card').length===3`);

    await run(`(()=>{const card=[...document.querySelectorAll('.case-card')].find((node)=>node.querySelector('.case-card__name').textContent==='T2 权限拒绝时列表为空');if(card.querySelector('.case-card__body').hidden)card.querySelector('.case-card__head').click();})()`);
    await run(`(()=>{const card=[...document.querySelectorAll('.case-card')].find((node)=>node.querySelector('.case-card__name').textContent==='T2 权限拒绝时列表为空');[...card.querySelectorAll('.case-card__edit')].find((button)=>button.textContent==='删除用例').click();})()`);
    await wait(`document.getElementById('confirm').open`);
    await check("单条删除需要确认同步移除脚本", `document.getElementById('right-panel-confirm-message').textContent.includes('spec 脚本')&&document.getElementById('right-panel-confirm-message').textContent.includes('不可恢复')`);
    await run(`document.querySelector('#confirm [data-confirm]').click()`);
    await wait(`![...document.querySelectorAll('.case-card__name')].some((node)=>node.textContent==='T2 权限拒绝时列表为空')`);
    await check("单条删除后保留同资产其他用例", `document.querySelectorAll('.case-card').length===2&&document.querySelector('.right-panel__status').textContent.includes('已删除 1 条用例')`);

    await run(`(()=>{const names=['T1 列表加载与结构完整','T3 合同编号不存在时展示空态'];for(const card of document.querySelectorAll('.case-card')){const name=card.querySelector('.case-card__name').textContent;if(names.includes(name))card.querySelector('.case-card__select').click();}})()`);
    await check("勾选多条用例显示批量删除入口", `document.querySelector('.case-bulk__count').textContent==='已选 2 条'&&document.querySelector('.case-bulk__delete').textContent==='删除选中（2）'&&!document.querySelector('.case-bulk__delete').disabled`);
    await run(`document.querySelector('.case-bulk__delete').click()`);
    await wait(`document.getElementById('confirm').open`);
    await run(`document.querySelector('#confirm [data-confirm]').click()`);
    await wait(`document.querySelectorAll('.case-card').length===0`);
    await check("批量删除后目录清空并显示空态", `document.querySelector('.case-catalog')===null&&document.querySelector('.right-panel__empty').textContent.includes('暂无标准化用例')`);

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

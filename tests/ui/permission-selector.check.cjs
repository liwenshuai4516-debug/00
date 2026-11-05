const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "permission-selector-ui-"));
  app.setPath("userData", root);
  await app.whenReady();
  const renderer = path.resolve(__dirname, "../../src/renderer");
  const componentUrl = pathToFileURL(path.join(renderer, "components/permission-selector.js")).href;
  const cssUrl = pathToFileURL(path.join(renderer, "styles/permission-selector.css")).href;
  const themeUrl = pathToFileURL(path.join(renderer, "styles/codex-theme.css")).href;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${themeUrl}"><link rel="stylesheet" href="${cssUrl}">
<style>body{margin:0;padding:24px;background:var(--page);color:var(--text);font-family:-apple-system,"PingFang SC",sans-serif}</style>
</head><body>
<div class="composer-tools">
  <div id="permission-selector" class="permission-selector" aria-busy="true">
    <button id="permission-trigger" class="permission-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="permission-menu" disabled>
      <span class="permission-trigger__label" data-permission-trigger-label>读取中</span><span class="permission-trigger__chevron">⌄</span>
    </button>
    <div id="permission-menu" class="permission-menu" role="listbox" aria-label="工具权限" hidden></div>
  </div>
</div>
<script type="module">
  import { createPermissionSelector } from "${componentUrl}";
  const modes = [
    { id: "ask", label: "每次确认", description: "写入和命令每次确认。" },
    { id: "read-only", label: "只读", description: "阻止写入和命令。" },
    { id: "full-access", label: "完全权限", description: "全部直接执行。", risk: true },
  ];
  let mode = "ask";
  const calls = [];
  const api = {
    readPermissionSettings: async () => ({ mode, scope: "session", defaultMode: "ask", options: modes }),
    savePermissionSettings: async (next, scope) => {
      calls.push([next, scope]); mode = next;
      return { mode, scope: scope ?? "session", defaultMode: "ask", options: modes };
    },
  };
  window.apiCalls = calls;
  window.selector = createPermissionSelector(document.getElementById("permission-selector"), api);
  window.__ready = true;
</script></body></html>`;
  await fs.writeFile(path.join(root, "index.html"), html);
  const win = new BrowserWindow({ width: 760, height: 500, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(root, "index.html"));
    const run = (source) => win.webContents.executeJavaScript(source);
    const wait = (expression) => run(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error("等待失败");})()`);
    const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    let passed = 0;
    const check = async (label, expression) => { assert.ok(await run(expression), label); passed += 1; console.log(`PASS ${label}`); };
    await wait("window.__ready===true && !document.getElementById('permission-trigger').disabled");
    await check("默认显示当前模式和三个选项", `document.querySelector('[data-permission-trigger-label]').textContent==='每次确认'&&document.querySelectorAll('.permission-choice').length===3`);
    await click("#permission-trigger");
    await check("打开菜单并聚焦当前选项", `!document.getElementById('permission-menu').hidden&&document.activeElement.getAttribute('data-permission-mode')==='ask'`);
    await click('.permission-choice[data-permission-mode="read-only"]');
    await wait("window.apiCalls.length===1");
    await check("选择只读按当前会话保存", `window.apiCalls[0][0]==='read-only'&&window.apiCalls[0][1]==='session'&&document.querySelector('[data-permission-trigger-label]').textContent==='只读'&&document.getElementById('permission-menu').hidden`);
    await run(`window.dispatchEvent(new CustomEvent('permission-settings-changed',{detail:{mode:'full-access',scope:'session',options:[
      {id:'ask',label:'每次确认',description:'写入和命令每次确认。'},
      {id:'read-only',label:'只读',description:'阻止写入和命令。'},
      {id:'full-access',label:'完全权限',description:'全部直接执行。',risk:true}
    ]}}))`);
    await check("设置页切换后输入框同步高风险状态", `document.querySelector('[data-permission-trigger-label]').textContent==='完全权限'&&document.getElementById('permission-trigger').dataset.state==='risk'`);
    await click("#permission-trigger");
    await run(`document.getElementById('permission-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await check("Escape关闭菜单并回到触发器", `document.getElementById('permission-menu').hidden&&document.activeElement.id==='permission-trigger'`);
    await fs.writeFile("/tmp/permission-selector.png", (await win.webContents.capturePage()).toPNG());
    console.log(`权限选择器 ${passed} 项检查通过。`);
  } finally {
    win.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });

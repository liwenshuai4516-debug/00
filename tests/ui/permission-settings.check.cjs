const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "permission-settings-ui-"));
  app.setPath("userData", root);
  app.setPath("sessionData", root);
  await app.whenReady();
  const renderer = path.resolve(__dirname, "../../src/renderer");
  const componentUrl = pathToFileURL(path.join(renderer, "components/settings/permission-settings.js")).href;
  const themeUrl = pathToFileURL(path.join(renderer, "styles/codex-theme.css")).href;
  const settingsUrl = pathToFileURL(path.join(renderer, "styles/settings.css")).href;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${themeUrl}"><link rel="stylesheet" href="${settingsUrl}">
<style>html,body{margin:0;padding:24px;background:var(--page);color:var(--text);font-family:-apple-system,"PingFang SC",sans-serif}</style>
</head><body>
<section class="general-settings" id="panel">
  <p id="general-settings-intro">通用设置</p>
  <div class="settings-group permission-settings">
    <div class="settings-row">
      <div class="settings-row__text"><span class="settings-row__title">权限</span><span class="settings-row__hint">选择工具调用的确认方式</span></div>
      <select class="settings-select" data-permission-mode-select aria-label="权限模式"></select>
    </div>
    <div class="settings-row">
      <div class="settings-row__text"><span class="settings-row__title">应用范围</span><span class="settings-row__hint">当前会话、当前项目或新会话默认</span></div>
      <select class="settings-select" data-permission-scope aria-label="权限应用范围">
        <option value="session">仅当前会话</option>
        <option value="workspace">当前项目所有会话</option>
        <option value="default">新会话默认</option>
      </select>
    </div>
  </div>
  <p class="permission-note" data-permission-scope-note>权限来源：读取中。</p>
  <p class="permission-warning" data-permission-warning hidden>完全权限会跳过所有确认。</p>
  <p class="permission-note">不是操作系统沙箱。</p>
  <p class="model-form-status" data-permission-status role="status"></p>
</section>
</section>
<script type="module">
  import { createPermissionSettings } from "${componentUrl}";
  let mode = "ask";
  let scope = "session";
  let defaultMode = "ask";
  const calls = [];
  const options = () => [
    { id: "ask", label: "每次确认", description: "写入和命令每次确认。" },
    { id: "read-only", label: "只读", description: "阻止写入和命令。" },
    { id: "full-access", label: "完全权限", description: "全部直接执行。", risk: true },
  ];
  const api = {
    readPermissionSettings: async () => ({ mode, scope, defaultMode, options: options() }),
    savePermissionSettings: async (next, nextScope) => {
      calls.push([next, nextScope]);
      mode = next; scope = nextScope;
      return { mode, scope, defaultMode, options: options() };
    },
  };
  window.apiCalls = calls;
  window.busy = false;
  const component = createPermissionSettings(document.getElementById("panel"), api, (value) => { window.busy = value; component.setBusy(value); });
  window.component = component;
  await component.show();
  window.__ready = true;
</script></body></html>`;
  await fs.writeFile(path.join(root, "index.html"), html);
  const win = new BrowserWindow({ width: 760, height: 700, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(root, "index.html"));
    const run = (source) => win.webContents.executeJavaScript(source);
    const wait = (expression) => run(`(async()=>{for(let i=0;i<300;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error("等待失败");})()`);
    const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    let passed = 0;
    const check = async (label, expression) => { assert.ok(await run(expression), label); passed += 1; console.log(`PASS ${label}`); };
    await wait("window.__ready===true");
    await run("window.component.setBusy(false)");
    await check("默认每次确认并展示三个模式", `document.querySelectorAll('[data-permission-mode-select] option').length===3&&document.querySelector('[data-permission-mode-select]').value==='ask'&&document.querySelector('[data-permission-warning]').hidden&&document.querySelector('[data-permission-scope]').value==='session'&&document.querySelector('[data-permission-scope-note]').textContent.includes('仅当前会话')`);
    if (process.env.PERMISSION_SETTINGS_SCREENSHOT_PATH) {
      await fs.writeFile(process.env.PERMISSION_SETTINGS_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await run(`(()=>{const select=document.querySelector('[data-permission-mode-select]');select.value='read-only';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await run(`new Promise((resolve)=>setTimeout(resolve,200))`);
    await wait("!window.busy&&document.querySelector('[data-permission-mode-select]').value==='read-only'");
    await check("保存只读模式并提示立即生效", `window.apiCalls.at(-1)[0]==='read-only'&&window.apiCalls.at(-1)[1]==='session'&&document.querySelector('[data-permission-status]').textContent.includes('只读')&&document.querySelector('[data-permission-warning]').hidden`);
    await run(`(()=>{const select=document.querySelector('[data-permission-scope]');select.value='workspace';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("!window.busy&&document.querySelector('[data-permission-scope-note]').textContent.includes('当前项目所有会话')");
    await check("切换项目范围保存并提示来源", `window.apiCalls.at(-1)[1]==='workspace'&&document.querySelector('[data-permission-status]').textContent.includes('当前项目所有会话')`);
    await run(`(()=>{const select=document.querySelector('[data-permission-mode-select]');select.value='full-access';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("!window.busy&&document.querySelector('[data-permission-mode-select]').value==='full-access'");
    await check("完全权限显示高风险提示", `window.apiCalls.at(-1)[0]==='full-access'&&!document.querySelector('[data-permission-warning]').hidden`);
    await run("window.component.setBusy(true)");
    await check("忙碌时禁用两个下拉", `document.querySelector('[data-permission-mode-select]').disabled&&document.querySelector('[data-permission-scope]').disabled`);
    await run("window.component.setBusy(false)");
    await check("空闲后恢复选择", `!document.querySelector('[data-permission-mode-select]').disabled&&!document.querySelector('[data-permission-scope]').disabled`);
    await fs.writeFile("/tmp/permission-settings.png", (await win.webContents.capturePage()).toPNG());
    console.log(`权限设置页面 ${passed} 项检查通过。`);
  } finally {
    win.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });

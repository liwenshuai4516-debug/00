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
<section class="general-settings">
  <p id="general-settings-intro">通用设置</p>
  <section class="model-panel-card permission-settings" id="panel">
    <div class="model-card-heading"><h3>权限控制</h3><span class="model-badge" data-permission-state>读取中</span></div>
    <div class="permission-options" data-permission-options role="radiogroup" aria-label="权限模式"></div>
    <p class="permission-warning" data-permission-warning hidden>完全权限会跳过所有确认。</p>
    <p class="permission-note">不是操作系统沙箱。</p>
    <p class="model-form-status" data-permission-status role="status"></p>
  </section>
</section>
<script type="module">
  import { createPermissionSettings } from "${componentUrl}";
  let mode = "ask";
  const calls = [];
  const api = {
    readPermissionSettings: async () => ({
      mode,
      options: [
        { id: "ask", label: "每次确认", description: "写入和命令每次确认。" },
        { id: "read-only", label: "只读", description: "阻止写入和命令。" },
        { id: "full-access", label: "完全权限", description: "全部直接执行。", risk: true },
      ],
    }),
    savePermissionSettings: async (next) => {
      calls.push(next); mode = next;
      return { mode, options: [
        { id: "ask", label: "每次确认", description: "写入和命令每次确认。" },
        { id: "read-only", label: "只读", description: "阻止写入和命令。" },
        { id: "full-access", label: "完全权限", description: "全部直接执行。", risk: true },
      ] };
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
    await check("默认每次确认并展示三个模式", `document.querySelectorAll('[data-permission-options] .permission-option').length===3&&document.querySelector('input[value="ask"]').checked&&document.querySelector('[data-permission-state]').textContent==='每次确认'&&document.querySelector('[data-permission-warning]').hidden`);
    if (process.env.PERMISSION_SETTINGS_SCREENSHOT_PATH) {
      await fs.writeFile(process.env.PERMISSION_SETTINGS_SCREENSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    await run(`(()=>{const input=document.querySelector('input[value="read-only"]');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await run(`new Promise((resolve)=>setTimeout(resolve,200))`);
    await wait("!window.busy&&document.querySelector('[data-permission-state]').textContent==='只读'");
    await check("保存只读模式并提示立即生效", `window.apiCalls.at(-1)==='read-only'&&document.querySelector('[data-permission-status]').textContent.includes('只读')&&document.querySelector('[data-permission-warning]').hidden`);
    await run(`(()=>{const input=document.querySelector('input[value="full-access"]');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("!window.busy&&document.querySelector('[data-permission-state]').textContent==='完全权限'");
    await check("完全权限显示高风险提示", `window.apiCalls.at(-1)==='full-access'&&document.querySelector('[data-permission-state]').dataset.state==='warn'&&!document.querySelector('[data-permission-warning]').hidden&&document.querySelector('.permission-option__risk').textContent==='高风险'`);
    await run("window.component.setBusy(true)");
    await check("忙碌时禁用所有模式", `[...document.querySelectorAll('[data-permission-options] input')].every((input)=>input.disabled)`);
    await run("window.component.setBusy(false)");
    await check("空闲后恢复选择", `[...document.querySelectorAll('[data-permission-options] input')].every((input)=>!input.disabled)`);
    await fs.writeFile("/tmp/permission-settings.png", (await win.webContents.capturePage()).toPNG());
    console.log(`权限设置页面 ${passed} 项检查通过。`);
  } finally {
    win.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });

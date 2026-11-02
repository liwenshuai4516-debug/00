const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

async function main() {
  const root = path.resolve(__dirname, "../..");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "unsent-list-ui-"));
  // 独立验证进程使用临时userData，不加载应用入口、配置、会话或模型。
  mkdirSync(path.join(temporary, "user-data"), { recursive: true });
  app.setPath("userData", path.join(temporary, "user-data"));
  app.commandLine.appendSwitch("disable-http-cache");
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1120, height: 820, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (_details, done) => done({ cancel: true }),
  );
  const css = name => pathToFileURL(path.join(root, "src/renderer/styles", name)).href;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${css("app.css")}">
    <link rel="stylesheet" href="${css("codex-theme.css")}">
    <link rel="stylesheet" href="${css("unsent-session-list.css")}">
    </head><body><div class="app-shell"><aside class="sidebar">
      <h2>项目助手</h2><section id="unsent"></section>
    </aside><main class="chat-main"><header class="chat-header"><h1>未发送列表预览</h1></header>
      <label for="outside">预览输入</label><input id="outside" value="保留输入">
    </main></div></body></html>`;
  const filename = path.join(temporary, "index.html");
  await fs.writeFile(filename, html);
  await window.loadFile(filename);
  // 隐藏窗口模拟页面获得焦点，仍通过原生键盘事件验证按钮与焦点环。
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  const moduleUrl = pathToFileURL(path.join(root, "src/renderer/components/unsent-session-list.js")).href;
  await window.webContents.executeJavaScript(`(async () => {
    const { createUnsentSessionList } = await import(${JSON.stringify(moduleUrl)});
    window.calls = []; window.refreshes = 0;
    window.list = createUnsentSessionList(document.getElementById("unsent"),
      (...args) => { window.calls.push(args); if (window.lockOnOpen) window.list.setBusy(true); },
      () => { window.refreshes += 1; if (window.lockOnRefresh) window.list.showLoading(); });
    window.rows = [
      { id: "a", title: "当前保留输入", workspaceDir: "/test", blockedReason: "" },
      { id: "b", title: "另一条输入", workspaceDir: "/test", blockedReason: "" },
      { id: "c", title: "待确认输入", workspaceDir: "/test", blockedReason: "仍有待确认发送，暂不能重建。" },
    ];
    window.getButton = id => document.querySelector('[data-unsent-id="' + id + '"]');
    window.ensure = (ok, message) => { if (!ok) throw new Error(message); };
  })()`);
  const passed = [];
  const check = async (name, body) => {
    const error = await window.webContents.executeJavaScript(`(() => { try { ${body} } catch (error) { return error.message; } })()`);
    assert.equal(error, undefined, name);
    passed.push(name);
  };
  await check("初始与空列表状态，无读取或恢复副作用", `
    ensure(document.querySelector('[role="status"]').textContent.includes("尚未读取"), "缺少初始状态");
    list.render([], "");
    ensure(document.querySelector('[role="status"]').textContent.includes("暂无未发送"), "缺少空状态");
    ensure(document.querySelector("ul").hidden, "空列表不可聚焦");
    ensure(calls.length === 0 && refreshes === 0, "展示不能调用业务");
  `);
  await check("当前选择、受阻原因与纯文本安全展示", `
    list.render(rows, "a");
    ensure(getButton("a").getAttribute("aria-current") === "true", "当前项未标记");
    ensure(getButton("c").disabled, "受阻项必须禁用");
    ensure(document.querySelector(".unsent-list-reason").textContent.includes("待确认发送"), "原因必须直接可见");
    ensure(getButton("c").getAttribute("aria-label").includes("待确认发送"), "原因缺少可访问名称");
    const hostile = '<img src=x onerror="window.injected=true">';
    list.render([{ id: "safe", title: hostile, blockedReason: hostile }], "");
    ensure(!document.querySelector("#unsent img"), "不得创建HTML");
    ensure(getButton("safe").textContent === hostile, "标题原文被修改");
    ensure(!window.injected, "执行了输入内容");
  `);
  await check("回调只传编号；当前、受阻、忙碌、重复和已移除行均拒绝", `
    list.render(rows, "a");
    const dispatch = button => button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    dispatch(getButton("a")); dispatch(getButton("c"));
    ensure(calls.length === 0, "当前或受阻项不能恢复");
    window.lockOnOpen = true;
    dispatch(getButton("b")); dispatch(getButton("b"));
    ensure(calls.length === 1 && calls[0].length === 1 && calls[0][0] === "b", "仅一次编号回调");
    ensure([...document.querySelectorAll("#unsent button")].every(b => b.disabled), "忙碌时必须禁用");
    list.setBusy(false); window.lockOnOpen = false;
    const old = getButton("b"); list.render([], ""); dispatch(old);
    ensure(calls.length === 1, "旧行事件不应恢复");
  `);
  await check("读取中隐藏旧目录；失败清旧列表，刷新可显式重试", `
    list.render(rows, "a"); window.lockOnRefresh = true;
    document.querySelector(".unsent-list-refresh").click();
    document.querySelector(".unsent-list-refresh").dispatchEvent(new MouseEvent("click"));
    ensure(refreshes === 1, "读取中不能重复刷新");
    ensure(getComputedStyle(document.querySelector("ul")).display === "none", "读取中不得显示旧目录");
    ensure(document.getElementById("unsent").getAttribute("aria-busy") === "true", "缺少忙碌状态");
    list.showError("临时读取失败<img src=x>");
    ensure(document.querySelectorAll(".unsent-list-open").length === 0, "失败应清除旧行");
    ensure(document.querySelector(".unsent-list-refresh").textContent === "重试", "缺少重试");
    ensure(!document.querySelector("#unsent img"), "错误消息必须纯文本");
    document.querySelector(".unsent-list-refresh").click();
    ensure(refreshes === 2, "显式重试未调用");
    list.render(rows, "a"); window.lockOnRefresh = false;
    ensure(!document.querySelector(".unsent-list-refresh").disabled, "读取完成后恢复按钮");
  `);
  await check("重绘保留行焦点，行消失回到刷新，页面外焦点不被夺走", `
    getButton("b").focus(); list.render(rows, "a");
    ensure(document.activeElement === getButton("b"), "未保留行焦点");
    list.render(rows.filter(row => row.id !== "b"), "a");
    ensure(document.activeElement === document.querySelector(".unsent-list-refresh"), "行消失应回到刷新");
    document.getElementById("outside").focus(); list.render(rows, "b");
    ensure(document.activeElement.id === "outside", "不能夺走输入焦点");
    list.setActive("a"); ensure(getButton("a").getAttribute("aria-current") === "true", "当前项切换失败");
  `);
  const key = async keyCode => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === " " || keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode });
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => resolve()))");
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => resolve()))");
  };
  await window.webContents.executeJavaScript('window.calls = []; getButton("b").focus();');
  await key("Enter"); await key(" ");
  assert.deepEqual(await window.webContents.executeJavaScript("window.calls"), [["b"], ["b"]]);
  passed.push("原生按钮支持Enter和Space");
  await check("忙碌解除后受阻项仍禁用，空白标题回显不改原始记录", `
    const before = JSON.stringify(rows);
    list.setBusy(true); list.render(rows, "a"); list.setBusy(false);
    ensure(!getButton("b").disabled && getButton("c").disabled, "受阻状态被忙碌解除覆盖");
    ensure(JSON.stringify(rows) === before, "组件不能修改服务返回记录");
    list.render([{ id: "blank", title: "未发送对话", blockedReason: "" }], "blank");
    ensure(getButton("blank").textContent === "未发送对话", "空白输入标题未保留");
  `);
  for (const [width, height] of [[1120, 820], [760, 720], [375, 760]]) {
    window.setContentSize(width, height);
    await check(`${width}宽度布局、滚动与焦点可见`, `
      list.render([...rows, { id: "long", title: "很长的保留输入".repeat(20), blockedReason: "较长的待确认原因".repeat(10) }], "a");
      const root = document.documentElement, section = document.getElementById("unsent");
      ensure(root.scrollWidth <= innerWidth + 1, "整页横向溢出");
      ensure(section.scrollWidth <= section.clientWidth + 1, "组件横向溢出");
      for (const button of section.querySelectorAll("button")) ensure(button.getBoundingClientRect().height >= 44, "操作目标太小");
      const listBox = document.querySelector("ul");
      ensure(listBox.scrollHeight > listBox.clientHeight, "长列表应独立滚动");
      document.querySelector(".unsent-list-refresh").focus();
    `);
    await key("Tab");
    const focusError = await window.webContents.executeJavaScript(`(() => { try {
      const focused = document.activeElement;
      ensure(focused === document.querySelector("ul"), "键盘应可到达滚动列表");
      ensure(focused.matches(":focus-visible") && parseFloat(getComputedStyle(focused).outlineWidth) >= 2, "缺少可见焦点环");
      const box = focused.getBoundingClientRect();
      ensure(box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, "焦点区域被窗口遮挡");
    } catch (error) { return error.message; } })()`);
    assert.equal(focusError, undefined, `${width}宽度键盘焦点`);
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))");
    const screenshot = await window.webContents.capturePage();
    await fs.writeFile(path.join(temporary, `unsent-list-${width}.png`), screenshot.toPNG());
  }
  await fs.writeFile(path.join(temporary, "report.json"), JSON.stringify({ passed }, null, 2));
  console.log(`通过 ${passed.length} 项组件检查；截图与报告：${temporary}`);
  window.destroy();
}

const timeout = setTimeout(() => { console.error("组件验证超时"); app.exit(1); }, 30000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch(error => {
  clearTimeout(timeout); console.error(error); app.exit(1);
});
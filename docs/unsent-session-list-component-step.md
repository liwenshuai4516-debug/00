# 下一步：未发送侧栏列表组件

状态：手写候选，尚未写入实际应用或实际测试。上一小步IPC和预加载接口已由你完成：实际工作区与精确提交副本均通过两个脚本语法检查及8文件63项测试。

## 目标与取舍

本步继续由你亲手编写，新增一个独立列表组件、一份样式和一个离线检查脚本。沿用当前深灰侧栏及主题变量，使用原生DOM与按钮。

1. 展示同目录未发送条目 → 验证：当前项有标记，受阻原因直接显示，标题及错误均按纯文本展示。
2. 补齐交互状态 → 验证：读取中、空列表、失败重试、忙碌禁用、键盘操作与刷新后的焦点保留。
3. 用临时页面验证 → 验证：1120、760、375三档宽度无横向溢出，长列表独立滚动，可见焦点不被遮挡。

假设服务继续返回 `{ id, title, workspaceDir, blockedReason }[]`，页面后续负责读取和恢复。组件只接收这些记录以及两个回调；实际输入仍由原输入持久化组件管理。列表标题是摘要，不能用来恢复输入原文。

本步先验证组件自身，完成后启动真实应用还不会出现新入口。HTML容器、样式引用及renderer业务接线放到下一小步，以便分别核对输入保存、恢复失败与迟到响应。

## 1. 新建列表组件

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/components/unsent-session-list.js`，完整内容如下：

```javascript
// 只展示主进程给出的列表；读取、保存和恢复由页面回调统一调度。
export function createUnsentSessionList(container, onOpen, onRefresh) {
  let busy = false;
  let loading = false;
  let activeId = "";
  const buttons = new Map();
  container.classList.add("unsent-session-list");
  container.setAttribute("aria-label", "当前工作目录的未发送对话");

  const header = document.createElement("div");
  header.className = "unsent-list-header";
  const heading = document.createElement("h3");
  heading.textContent = "未发送";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "unsent-list-refresh";
  refreshButton.textContent = "刷新";
  refreshButton.setAttribute("aria-label", "刷新当前目录的未发送对话");
  header.append(heading, refreshButton);

  const status = document.createElement("p");
  status.className = "unsent-list-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  status.textContent = "尚未读取未发送输入。";
  const items = document.createElement("ul");
  items.className = "unsent-list-items";
  items.setAttribute("aria-label", "未发送对话");
  items.tabIndex = 0;
  items.hidden = true;
  container.replaceChildren(header, status, items);

  function updateControls() {
    const locked = busy || loading;
    container.setAttribute("aria-busy", String(locked));
    refreshButton.disabled = locked;
    for (const { button, blocked } of buttons.values()) {
      button.disabled = locked || blocked;
    }
  }

  function setBusy(value) {
    busy = value;
    updateControls();
  }

  function setActive(id) {
    activeId = id;
    for (const [sessionId, { button }] of buttons) {
      if (sessionId === id) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }

  function showLoading() {
    loading = true;
    // 先隐藏旧目录列表，迟到结果是否采用由页面负责判断。
    items.hidden = true;
    refreshButton.textContent = "读取中…";
    status.textContent = "正在读取当前目录的未发送输入……";
    updateControls();
  }

  function showError(message) {
    loading = false;
    buttons.clear();
    items.replaceChildren();
    items.hidden = true;
    heading.textContent = "未发送";
    refreshButton.textContent = "重试";
    status.textContent = `读取未完成：${message}`;
    updateControls();
  }

  function render(rows, currentId) {
    const focused = document.activeElement;
    const focusedId = container.contains(focused) && buttons.has(focused?.dataset.unsentId)
      ? focused.dataset.unsentId : undefined;
    loading = false;
    buttons.clear();
    items.replaceChildren();
    items.hidden = rows.length === 0;
    heading.textContent = `未发送（${rows.length}）`;
    status.textContent = rows.length
      ? "当前工作目录中保留的输入。"
      : "当前目录暂无未发送输入。";
    refreshButton.textContent = "刷新";

    for (const row of rows) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "unsent-list-open";
      button.dataset.unsentId = row.id;
      button.textContent = row.title;
      button.title = row.title;
      const blocked = Boolean(row.blockedReason);
      if (blocked) {
        // 禁用原因直接可见，也作为按钮的可访问名称，不能只藏在悬停提示里。
        button.setAttribute("aria-label", `${row.title}；${row.blockedReason}`);
        const reason = document.createElement("p");
        reason.className = "unsent-list-reason";
        reason.textContent = row.blockedReason;
        item.append(button, reason);
      } else item.append(button);
      button.addEventListener("click", () => {
        if (!container.contains(button) || busy || loading || blocked || row.id === activeId) return;
        onOpen(row.id);
      });
      buttons.set(row.id, { button, blocked });
      items.append(item);
    }
    setActive(currentId);
    updateControls();
    // 空闲刷新保留原行焦点；该行消失或被禁用时回到稳定的刷新按钮。
    if (focusedId !== undefined && !busy) {
      const next = buttons.get(focusedId)?.button;
      (next && !next.disabled ? next : refreshButton).focus();
    }
  }

  refreshButton.addEventListener("click", () => {
    if (!busy && !loading) onRefresh();
  });
  updateControls();
  return { render, setActive, setBusy, showLoading, showError };
}
```

组件提供五个方法：render(rows, currentId)展示新结果，setActive(id)更新当前标记，setBusy(value)同步页面忙碌状态，showLoading()隐藏旧目录的结果，showError(message)显示读取失败并保留重试入口。

onOpen只收到编号，onRefresh不带参数。后续页面回调必须立即同步设置忙碌状态，再启动异步操作，并自行捕获错误；本组件不发IPC、不处理输入、不决定采用哪个异步结果。当前项点击不重复恢复；受阻项保持禁用，也不提供绕过待确认发送的入口。

组件由页面创建一次并复用。没有全局事件监听或计时器；本步无需额外销毁接口。

## 2. 新建组件样式

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/styles/unsent-session-list.css`，完整内容如下：

```css
/* 复用当前深色主题变量；本组件不修改历史列表或页面布局。 */
.unsent-session-list {
  min-width: 0;
  padding: 8px 4px;
  border-top: 1px solid var(--border);
}
.unsent-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.unsent-list-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}
.unsent-session-list .unsent-list-refresh {
  min-height: 44px;
  flex: 0 0 auto;
  border-color: transparent;
  color: var(--muted);
}
.unsent-list-status,
.unsent-list-reason {
  margin: 4px 0 8px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.unsent-list-items {
  max-height: min(30vh, 260px);
  margin: 0;
  padding: 4px;
  display: grid;
  gap: 8px;
  overflow-y: auto;
  list-style: none;
}
.unsent-list-items li {
  min-width: 0;
}
.unsent-session-list .unsent-list-open {
  width: 100%;
  min-height: 44px;
  padding: 8px;
  border-color: transparent;
  text-align: left;
  overflow-wrap: anywhere;
  background: transparent;
}
.unsent-session-list .unsent-list-open[aria-current="true"] {
  background: var(--hover);
}
.unsent-list-reason {
  padding-inline: 8px;
}
.unsent-session-list button:disabled {
  cursor: not-allowed;
}
.unsent-session-list :where(button, ul):focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
```

这里复用现有--border、--muted、--hover与--focus等主题变量；隐藏规则沿用app.css中的[hidden]。受阻条目的解释文字保持正常对比度，按钮保留禁用语义和状态。列表限制自身高度并可通过键盘聚焦滚动，不改变页面原有侧栏折叠方式。

## 3. 新建独立Electron检查脚本

如无tests/ui目录，先创建该目录，再新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/ui/unsent-session-list.check.cjs`，完整内容如下：

该脚本启动独立隐藏窗口，使用临时userData与测试页，加载项目实际样式和本组件，不加载业务renderer。回调由测试模拟，HTTP/HTTPS请求禁用。隐藏窗口通过Chromium焦点模拟验证原生键盘操作和可见焦点，不要求打开真实应用。

```javascript
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
```

## 4. 验证

在项目根目录执行：

```bash
node --check src/renderer/components/unsent-session-list.js
node --check tests/ui/unsent-session-list.check.cjs
./node_modules/.bin/electron tests/ui/unsent-session-list.check.cjs
```

预期输出“通过10项组件检查”，并给出临时截图与report.json的位置。打开三张截图确认长标题换行、受阻原因、独立滚动和焦点环。脚本不会修改项目文件或使用真实会话。

本候选已在实际渲染层的临时副本中通过上述检查；三档截图也已人工查看。候选目录为 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-unsent-list-component-3ipl5up8`，最终验证截图及报告位于 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/unsent-list-ui-qt5fVk`。这证明组件候选的离线表现，不代表你尚未编写的实际文件或真实重启流程已通过。

## 下一小步的接线条件

完成后再把容器、样式引用和组件接入实际深色侧栏。页面离开当前会话前须await输入保存；恢复成功先绑定返回编号，再await原bindComposer读取最新原文、版本与快照。恢复失败保留原消息、输入和文件草稿；恢复已成功但后续刷新失败时，不能回到旧编号或回填旧输入。

listUnsentSessions与listProposals、inspectComposerSend共用互斥入口，不能直接Promise.all。页面须在既有输入绑定与草稿读取后顺序读取，并保护会话、目录变化后的迟到响应。

正常关闭前补保存、无历史且待确认发送条目的专用处理入口仍未完成，本步不代表完整重启恢复。

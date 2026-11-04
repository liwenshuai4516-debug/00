const { Menu } = require("electron");

// 侧栏浏览器只允许 http(s) 主文档；webview 不允许弹窗或跳转到本地协议。
function isBrowserUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// webview 是独立 webContents：默认菜单的“开发者工具”只作用于宿主窗口，
// 因此给 guest 单独提供右键菜单（检查元素）与工具栏入口（见 open-browser-devtools）。
function installGuestBrowserPolicy(app) {
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;

    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isBrowserUrl(url)) event.preventDefault();
    });

    contents.on("context-menu", () => {
      const menu = Menu.buildFromTemplate([
        { label: "返回", enabled: contents.canGoBack(), click: () => contents.goBack() },
        { label: "前进", enabled: contents.canGoForward(), click: () => contents.goForward() },
        { label: "重新加载", click: () => contents.reload() },
        { type: "separator" },
        { label: "检查元素", click: () => contents.openDevTools({ mode: "detach" }) },
      ]);
      menu.popup();
    });
  });
}

// 按宿主窗口定位侧栏浏览器的 guest，并打开它自己的开发者工具窗口。
function openBrowserDevToolsForHost(host) {
  const { webContents } = require("electron");
  const guest = webContents.getAllWebContents().find(
    (contents) => contents.getType() === "webview" && contents.hostWebContents === host,
  );
  if (!guest) throw new Error("浏览器页面尚未打开。");
  guest.openDevTools({ mode: "detach" });
  return guest;
}

module.exports = { installGuestBrowserPolicy, isBrowserUrl, openBrowserDevToolsForHost };

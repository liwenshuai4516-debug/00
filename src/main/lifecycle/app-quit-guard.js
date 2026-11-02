// 应用退出也经过每个窗口已有的关闭握手；失败后取消本次退出。
function registerAppQuitGuard(app, BrowserWindow, platform = process.platform) {
  let quitting = false;

  app.on("browser-window-created", (_event, window) => {
    window.once("closed", () => {
      if (!quitting) return;
      // app.quit路径可能不发window-all-closed；等窗口移出列表再继续退出。
      setImmediate(() => {
        if (quitting && BrowserWindow.getAllWindows().length === 0) app.quit();
      });
    });
  });

  app.on("before-quit", event => {
    const windows = BrowserWindow.getAllWindows();
    if (!windows.length) {
      quitting = false;
      return;
    }
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    for (const window of windows) {
      if (!quitting) break;
      if (!window.isDestroyed()) window.close();
    }
  });

  app.on("window-all-closed", () => {
    if (quitting || platform !== "darwin") app.quit();
  });

  return {
    isQuitting: () => quitting,
    cancelQuit() { quitting = false; },
  };
}

module.exports = { registerAppQuitGuard };
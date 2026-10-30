const { app, BrowserWindow } = require("electron");

// 先获取锁，再加载配置、组装服务和注册 IPC。
if (!app.requestSingleInstanceLock()) {
  // 已有实例运行，本次进程退出，不加载业务模块。
  app.quit();
} else {
  const { createWindow } = require("./bootstrap.js");

  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];

    // macOS 关闭全部窗口后，原进程可能仍然运行。
    if (!window) {
      createWindow();
      return;
    }

    if (window.isMinimized()) {
      window.restore();
    }

    window.show();
    window.focus();
  });
}
const { randomUUID } = require("node:crypto");

// 只负责关闭握手；停止生成、等待页面操作和保存输入由页面接线负责。
function registerWindowCloseGuard(window, ipcMain, onBlocked = () => {}) {
  const contents = window.webContents;
  let ready = false;
  let pendingId = null;
  let approved = false;

  function isMainFrame(event) {
    return event.sender === contents && event.senderFrame === contents.mainFrame;
  }

  function sendRequest() {
    if (!ready || !pendingId) return;
    try {
      contents.send("agent:prepare-close", pendingId);
    } catch {
      // 没收到确认就保留窗口；新页面准备好后可重新发起关闭。
      ready = false;
      pendingId = null;
      onBlocked();
      console.error("关闭准备通知未送达，窗口已保留。");
    }
  }

  function onClose(event) {
    if (approved) return;
    event.preventDefault();
    if (pendingId) return;
    pendingId = randomUUID();
    sendRequest();
  }

  function onReady(event) {
    if (!isMainFrame(event) || ready) return;
    ready = true;
    // 页面尚未就绪时点击关闭，也必须等监听与保存逻辑准备完成。
    sendRequest();
  }

  function onResult(event, result) {
    if (
      !isMainFrame(event) || !pendingId ||
      result?.requestId !== pendingId || typeof result.saved !== "boolean"
    ) return;
    pendingId = null;
    if (!result.saved) {
      onBlocked();
      return;
    }
    if (window.isDestroyed()) return;
    // 只放行这次同步close；若被其他监听器取消，下次仍须重新保存。
    approved = true;
    try {
      window.close();
    } finally {
      approved = false;
    }
  }

  function resetPage() {
    if (pendingId) onBlocked();
    ready = false;
    pendingId = null;
  }

  function onNavigation(_event, _url, isInPlace, isMain) {
    if (isMain && !isInPlace) resetPage();
  }

  function cleanup() {
    resetPage();
    window.removeListener("close", onClose);
    ipcMain.removeListener("agent:close-ready", onReady);
    ipcMain.removeListener("agent:close-result", onResult);
    contents.removeListener("did-start-navigation", onNavigation);
    contents.removeListener("render-process-gone", resetPage);
  }

  window.on("close", onClose);
  window.once("closed", cleanup);
  ipcMain.on("agent:close-ready", onReady);
  ipcMain.on("agent:close-result", onResult);
  contents.on("did-start-navigation", onNavigation);
  contents.on("render-process-gone", resetPage);
}

module.exports = { registerWindowCloseGuard };
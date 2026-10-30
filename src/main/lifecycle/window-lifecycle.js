// 连接窗口生命周期与聊天服务。
function registerWindowLifecycle(window, chatService) {
  window.once("closed", () => {
    // 初始化期间阻止后续发送；生成期间调用 SDK abort。
    // 事件监听器不等待 Promise，需要接住异步失败。
    chatService.stop().catch(() => {
      console.error("窗口已关闭，但停止生成未确认成功。");
    });
  });
}

module.exports = { registerWindowLifecycle };
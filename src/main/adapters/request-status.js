// 将 Pi 事件转换为状态文案，不转发供应商原始错误内容。
function getRequestStatus(event) {
  switch (event.type) {
    case "auto_retry_start":
      return (
        `自动重试 ${event.attempt}/${event.maxAttempts}` +
        `（等待间隔 ${Math.ceil(event.delayMs / 1000)} 秒）……`
      );

    case "auto_retry_end":
      return event.success
        ? "模型回复已恢复，正在继续处理……"
        : "自动重试已结束，等待本次请求结果……";

    case "compaction_start":
      return "正在整理对话上下文……";

    case "compaction_end":
      if (event.aborted) {
        return "上下文整理已停止，等待本次请求结果……";
      }

      if (event.errorMessage) {
        return "上下文整理失败，等待本次请求结果……";
      }

      return event.willRetry
        ? "上下文整理结束，正在重新请求模型……"
        : "上下文整理结束，正在继续处理……";

    default:
      return undefined;
  }
}

module.exports = { getRequestStatus };
// Pi 提供上下文估算；这不是请求费用或全部历史消息的总量。
export function formatContextUsage(usage) {
  if (!usage) {
    return "上下文估算：暂不可用";
  }

  const windowSize = usage.contextWindow.toLocaleString("zh-CN");

  // 压缩上下文后可能暂时没有估算结果，不能把未知显示为零。
  if (usage.tokens === null || usage.percent === null) {
    return `上下文估算：等待模型回复后更新（窗口 ${windowSize} tokens）`;
  }

  const tokens = usage.tokens.toLocaleString("zh-CN");
  const percent = usage.percent.toFixed(1);

  return `上下文估算：${tokens} / ${windowSize} tokens（${percent}%）`;
}

// 页面组件只负责显示，实际会话信息由主进程提供。
export function createSessionInfoPanel(element, readInfo) {
  async function refresh() {
    element.textContent = "正在读取当前会话信息……";

    try {
      const info = await readInfo();

      const model = info.modelId
        ? `${info.provider}/${info.modelId}`
        : "未选择模型";

      // 使用普通文本展示，避免目录名等内容被解释为 HTML。
      element.textContent = [
        `当前工作目录：${info.workspaceDir}`,
        `当前模型：${model}`,
        `会话编号：${info.sessionId}`,
        formatContextUsage(info.contextUsage),
      ].join("\n");
    } catch (error) {
      // 信息展示失败在当前区域提示，不向聊天流程抛出异常。
      element.textContent =
        `会话信息读取失败：${error.message}`;
    }
  }

  return { refresh };
}
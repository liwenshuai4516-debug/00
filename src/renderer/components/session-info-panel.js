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
export function createSessionInfoPanel(element, readInfo, { readSessionId = () => undefined, onState = () => {} } = {}) {
  let sequence = 0;
  let disposed = false;
  let dirty = true;
  let scheduledOutputRefresh;

  function loading() {
    element.textContent = "正在读取当前会话信息……";
    onState({ status: "loading" });
  }

  function invalidate() {
    ++sequence;
    dirty = true;
    loading();
  }

  async function refresh({ background = false } = {}) {
    if (disposed) return;
    const token = ++sequence;
    const expectedId = readSessionId();
    dirty = false;
    // 生成期间按事件重读，保留最近一次展示，避免每个工具轮次闪回“读取中”。
    if (!background) loading();

    try {
      const info = await readInfo();
      // 请求序号保护同会话模型切换，编号保护跨会话迟到响应。
      if (disposed || token !== sequence) return;
      if (expectedId !== readSessionId() || (expectedId && info.sessionId !== expectedId)) {
        throw new Error("会话已变化，请重新读取当前会话信息。");
      }

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
      onState({ status: "ready", info });
    } catch (error) {
      if (disposed || token !== sequence) return;
      // 信息展示失败在当前区域提示，不向聊天流程抛出异常。
      element.textContent =
        `会话信息读取失败：${error.message}`;
      onState({ status: "error", error: error.message });
    }
  }

  function acceptOutput(output) {
    if (disposed || (output.requestSessionId ?? output.sessionId) !== readSessionId()) return;
    const assistantBoundary = ["message_start", "message_end"].includes(output.type) && output.message?.role === "assistant";
    if (!assistantBoundary && !["turn_end", "compaction_end"].includes(output.type)) return;
    if (scheduledOutputRefresh) return scheduledOutputRefresh;
    const token = sequence;
    // 同一批事件合并一次读取；不按文本增量读取，也不引入定时轮询。
    scheduledOutputRefresh = Promise.resolve().then(() => {
      scheduledOutputRefresh = undefined;
      if (disposed || token !== sequence) return;
      return refresh({ background: true });
    });
    return scheduledOutputRefresh;
  }

  return {
    refresh, invalidate, acceptOutput,
    refreshIfNeeded() { if (dirty) return refresh(); },
    dispose() { disposed = true; ++sequence; },
  };
}

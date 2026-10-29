// 页面组件只负责显示，实际会话信息由主进程提供。
export function createSessionInfoPanel(element, readInfo) {
  async function refresh() {
    element.textContent = "正在读取当前会话信息……";

    try {
      const info = await readInfo();

      const model = info.modelId
        ? `${info.provider}/${info.modelId}`
        : "未选择模型";

      // 目录名等数据作为普通文本显示，不能被当作 HTML 执行。
      element.textContent = [
        `当前工作目录：${info.workspaceDir}`,
        `当前模型：${model}`,
        `会话编号：${info.sessionId}`,
      ].join("\n");
    } catch (error) {
      // 展示失败不会中断聊天流程，错误在当前区域显示。
      element.textContent =
        `会话信息读取失败：${error.message}`;
    }
  }

  return { refresh };
}
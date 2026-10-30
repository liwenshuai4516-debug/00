const { writeFile } = require("node:fs/promises");

const ROLE_LABELS = {
  user: "我",
  assistant: "Agent",
  tool: "工具",
  status: "状态",
  error: "错误",
};

function createConversationExportService(
  sessionService,
  chooseFile,
  writeText = writeFile,
) {
  async function exportConversation(sender) {
    // 数据来自主进程当前会话，页面不能提供正文或目标路径。
    const history = await sessionService.loadHistory();

    const text = [
      "当前对话（上下文快照）",
      "导出范围：当前上下文的展示文本，可能包含摘要或截断的工具结果。",
      "",
      ...history.flatMap((message) => [
        `【${ROLE_LABELS[message.role] ?? "消息"}】`,
        message.text,
        "",
      ]),
    ].join("\n");

    const result = await chooseFile(sender, {
      title: "导出当前对话",
      buttonLabel: "导出",
      filters: [
        {
          name: "文本文件",
          extensions: ["txt"],
        },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    // 等待写入成功后才通知页面，取消或失败不能报告成功。
    await writeText(result.filePath, text, "utf8");

    return { canceled: false };
  }

  return { exportConversation };
}

module.exports = { createConversationExportService };
const { writeFile } = require("node:fs/promises");
const path = require("node:path");

const ROLE_LABELS = {
  user: "我",
  assistant: "Agent",
  tool: "工具",
  status: "状态",
  error: "错误",
};

const EXPORT_SCOPE = "导出范围：当前上下文的展示文本，可能包含摘要或截断的工具结果。";

function textExport(history) {
  return [
    "当前对话（上下文快照）",
    EXPORT_SCOPE,
    "",
    ...history.flatMap((message) => [
      `【${ROLE_LABELS[message.role] ?? "消息"}】`,
      message.text,
      "",
    ]),
  ].join("\n");
}

function markdownExport(history) {
  return [
    "# 当前对话（上下文快照）",
    "",
    EXPORT_SCOPE,
    "",
    ...history.flatMap((message) => [
      `## ${ROLE_LABELS[message.role] ?? "消息"}`,
      "",
      message.text,
      "",
    ]),
  ].join("\n");
}

function jsonExport(history, info) {
  return `${JSON.stringify({
    exportedAt: new Date().toISOString(),
    sessionId: info?.sessionId ?? null,
    workspaceDir: info?.workspaceDir ?? null,
    model: info?.modelId === undefined ? null : { provider: info.provider, id: info.modelId },
    messages: history.map((message) => ({ role: message.role, text: message.text })),
  }, null, 2)}\n`;
}

function createConversationExportService(
  sessionService,
  chooseFile,
  writeText = writeFile,
) {
  async function exportConversation(sender) {
    // 数据来自主进程当前会话，页面不能提供正文或目标路径。
    const history = await sessionService.loadHistory();

    let info = null;
    try {
      info = await sessionService.getSessionInfo?.() ?? null;
    } catch {
      info = null;
    }

    const result = await chooseFile(sender, {
      title: "导出当前对话",
      buttonLabel: "导出",
      filters: [
        {
          name: "文本文件",
          extensions: ["txt"],
        },
        {
          name: "Markdown",
          extensions: ["md"],
        },
        {
          name: "JSON",
          extensions: ["json"],
        },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    // 按保存文件名决定格式；未知扩展名保持原 txt 行为。
    const extension = path.extname(result.filePath).toLowerCase();
    const text = extension === ".md"
      ? markdownExport(history)
      : extension === ".json"
        ? jsonExport(history, info)
        : textExport(history);

    // 等待写入成功后才通知页面，取消或失败不能报告成功。
    await writeText(result.filePath, text, "utf8");

    return { canceled: false };
  }

  return { exportConversation };
}

module.exports = { createConversationExportService };
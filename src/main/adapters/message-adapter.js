// 只提取文本，不把模型思考、工具参数或图片当成聊天正文。
function getText(content) {
  if (typeof content === "string") return content;

  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// 实时展示和历史恢复使用相同格式。
function formatToolResult(name, content, isError) {
  const status = isError ? "执行失败" : "执行完成";
  const text = getText(content);

  // 仅限制页面展示长度，不修改 Pi 保存或模型收到的结果。
  const preview =
    text.length > 4000
      ? `${text.slice(0, 4000)}\n……结果较长，显示已截断`
      : text;

  return `${name} ${status}\n${preview || "无文本结果"}`;
}

function toHistory(messages) {
  return messages
    .filter((message) =>
      ["user", "assistant", "toolResult"].includes(message.role) ||
      (
        message.role === "custom" &&
        message.customType === "workspace-edit-applied" &&
        message.display === true
      ),
    )
    .map((message) => {
      // 保存记录使用独立角色，不冒充用户或模型消息。
      if (message.role === "custom") {
        return {
          role: "status",
          text: getText(message.content),
        };
      }

      if (message.role === "toolResult") {
        return {
          role: "tool",
          text: formatToolResult(
            message.toolName,
            message.content,
            message.isError,
          ),
        };
      }

      return {
        role: message.role,
        text: getText(message.content),
      };
    })
    .filter((message) => message.text);
}

module.exports = { formatToolResult, toHistory };
const { outputMessage, skillForRead } = require("./output-event-adapter.js");

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

function toHistory(messages, { includeTrace = false, parseSkillBlock, skills = [], cwd } = {}) {
  const calls = new Map();
  return messages
    .filter(
      (message) =>
        ["user", "assistant", "toolResult", "compactionSummary"].includes(
          message.role,
        ) ||
        (message.role === "custom" &&
          message.display === true),
    )
    .map((message) => {
      // 轨迹视图需要真实时间；普通文本导出不额外携带时间字段。
      const stamp = includeTrace && Number.isFinite(message.ts) ? { ts: message.ts } : {};

      // 压缩摘要没有 content 字段，需要单独读取 summary。
      if (message.role === "compactionSummary") {
        return {
          role: "status",
          text: `上下文整理摘要\n${message.summary}`,
          ...stamp,
        };
      }

      // 保存记录使用独立角色，不冒充用户或模型消息。
      if (message.role === "custom") {
        return {
          role: "status",
          text: getText(message.content),
          ...stamp,
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
          ...(includeTrace ? { output: { ...outputMessage(message), skill: calls.get(message.toolCallId) } } : {}),
        };
      }

      if (includeTrace && message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall") calls.set(block.id, skillForRead(block.name, block.arguments, skills, cwd));
        }
        return { role: "assistant", text: getText(message.content), output: outputMessage(message) };
      }
      if (includeTrace && message.role === "user") {
        const expanded = parseSkillBlock?.(getText(message.content));
        if (expanded) return {
          role: "user", text: `/skill:${expanded.name}${expanded.userMessage ? ` ${expanded.userMessage}` : ""}`,
          skill: { name: expanded.name, path: expanded.location, source: "history" },
          ...stamp,
        };
      }
      return {
        role: message.role,
        text: getText(message.content),
        ...(message.role === "user" ? stamp : {}),
      };
    })
    .filter((message) => message.text || message.output);
}

module.exports = { formatToolResult, toHistory };

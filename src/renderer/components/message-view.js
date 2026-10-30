const ROLE_LABELS = {
  user: "我",
  assistant: "Agent",
  tool: "工具",
  status: "状态",
  error: "错误",
};

// 历史消息和实时消息共用组件，所有内容均作为纯文本展示。
export function appendMessage(container, role, text) {
  if (role === "tool") {
    const details = document.createElement("details");
    details.className = "chat-message tool-message";
    details.dataset.role = "tool";

    const summary = document.createElement("summary");
    const body = document.createElement("div");
    body.className = "message-body";

    details.append(summary, body);
    updateToolMessage(body, text);
    container.appendChild(details);

    return body;
  }

  const article = document.createElement("article");
  article.className = "chat-message";
  article.dataset.role = role;

  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = ROLE_LABELS[role] || "消息";

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;

  article.append(label, body);

  if (role === "assistant") {
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "复制";
    copyButton.setAttribute("aria-label", "复制这条 Agent 回复");

    const copyStatus = document.createElement("span");
    copyStatus.setAttribute("role", "status");

    copyButton.addEventListener("click", async () => {
      // 点击时读取正文，避免复制到消息刚创建时的空文本。
      const currentText = body.textContent;

      if (!currentText.trim()) {
        copyStatus.textContent = "暂无可复制的内容。";
        return;
      }

      copyButton.disabled = true;
      copyStatus.textContent = "正在复制……";

      try {
        // 只写入用户主动选择的回复，不读取剪贴板。
        await navigator.clipboard.writeText(currentText);
        copyStatus.textContent = "已复制。";
      } catch {
        copyStatus.textContent = "复制失败，请选中文本手动复制。";
      } finally {
        copyButton.disabled = false;
      }
    });

    actions.append(copyButton, copyStatus);
    article.appendChild(actions);
  }

  container.appendChild(article);

  // 返回正文节点，流式更新不会覆盖消息结构。
  return body;
}
// 更新已有工具记录，保留用户选择的展开状态。
export function updateToolMessage(body, text) {
  const summary = body.parentElement.querySelector("summary");
  const separator = text.indexOf("\n");

  summary.textContent =
    separator === -1 ? text : text.slice(0, separator);

  body.textContent =
    separator === -1
      ? "暂无更多详情。"
      : text.slice(separator + 1);
}
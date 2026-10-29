// 独立预览区域：不替换聊天正文，不恢复草稿，不切换当前会话。
export function mountHistoryPreview(panel, agent) {
  const select = panel.querySelector("select");
  const button = panel.querySelector("button");
  const status = panel.querySelector('[role="status"]');
  const content = panel.querySelector(".history-preview-content");
  let busy = false;

  function setLoading(loading) {
    busy = loading;
    select.disabled = loading;
    button.disabled = loading || !select.value;
    content.setAttribute("aria-busy", String(loading));
  }

  // 展开时重新读取列表，不依赖当前 Agent 是否初始化成功。
  panel.addEventListener("toggle", async () => {
    if (!panel.open || busy) return;

    setLoading(true);
    content.replaceChildren();
    status.textContent = "正在加载历史列表……";

    try {
      const sessions = await agent.listSessions();

      select.replaceChildren(
        new Option("选择要预览的历史对话", ""),
      );

      for (const session of sessions) {
        select.add(
          new Option(session.title.slice(0, 60), session.id),
        );
      }

      status.textContent = sessions.length
        ? "请选择对话并点击查看。"
        : "暂无历史对话。";
    } catch (error) {
      select.replaceChildren(
        new Option("列表加载失败", ""),
      );

      status.textContent =
        `错误：${error.message}；收起后重新展开可重试。`;
    } finally {
      setLoading(false);
    }
  });

  select.addEventListener("change", () => {
    // 清除上次预览，避免误认成新选中的对话。
    content.replaceChildren();
    status.textContent = "请选择对话并点击查看。";
    button.disabled = busy || !select.value;
  });

  button.addEventListener("click", async () => {
    const sessionId = select.value;
    if (!sessionId || busy) return;

    setLoading(true);
    content.replaceChildren();
    status.textContent = "正在读取历史内容……";

    try {
      const result = await agent.previewSession(sessionId);

      const labels = {
        user: "我",
        assistant: "Agent",
        tool: "工具",
        status: "状态",
      };

      for (const message of result.history) {
        const element = document.createElement("p");

        element.style.whiteSpace = "pre-wrap";
        element.style.overflowWrap = "anywhere";

        // 历史内容作为普通文本展示，避免执行其中的 HTML。
        element.textContent =
          `${labels[message.role]}：${message.text}`;

        content.appendChild(element);
      }

      status.textContent = result.history.length
        ? `只读预览：${result.title}`
        : `只读预览：${result.title}；暂无可显示的文本。`;
    } catch (error) {
      status.textContent = `错误：${error.message}`;
    } finally {
      setLoading(false);
    }
  });
}
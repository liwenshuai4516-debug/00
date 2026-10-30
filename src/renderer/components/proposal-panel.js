export function createProposalPanel(
  container,
  loadProposal,
  applyProposal,
  discardProposal,
  setBusy,
  onError,
  onPendingChange,
) {
  function publishCount() {
    // 从当前页面统计，避免另外维护一份容易不同步的计数。
    const count = container.querySelectorAll('[data-pending="true"]').length;

    onPendingChange(count);
  }

  function clear() {
    container.replaceChildren();
    publishCount();
  }

  function add(id) {
    const article = document.createElement("article");
    // 页面标记只用于展示，真实保存状态仍由主进程决定。
    article.dataset.pending = "true";
    const viewButton = document.createElement("button");
    const saveButton = document.createElement("button");
    const discardButton = document.createElement("button");
    const preview = document.createElement("div");
    const status = document.createElement("p");
    let saved = false;

    viewButton.type = "button";
    viewButton.textContent = "查看草稿";
    saveButton.type = "button";
    saveButton.textContent = "确认保存到文件";
    saveButton.hidden = true;

    discardButton.type = "button";
    discardButton.textContent = "放弃草稿（不修改文件）";
    status.setAttribute("role", "status");

    viewButton.addEventListener("click", async () => {
      setBusy(true);
      saveButton.hidden = true;
      status.textContent = "";

      try {
        const proposal = await loadProposal(id);
        const isCreate = proposal.kind === "create-proposal";
        const title = document.createElement("p");
        title.textContent = `文件：${proposal.path}（本次检查通过，尚未保存）`;

        const comparison = document.createElement("div");
        comparison.className = "proposal-comparison";
        comparison.dataset.kind = proposal.kind;

        const scopeHint = document.createElement("p");

        if (isCreate) {
          scopeHint.textContent =
            "将新建此文件，以下为完整内容；保存时仍会检查目标是否被占用。";

          const contentPanel = document.createElement("section");
          contentPanel.className = "proposal-after";

          const contentLabel = document.createElement("h3");
          contentLabel.textContent = "新建文件 · 完整内容";

          const content = document.createElement("pre");
          // 只有空字符串显示占位提示，空格和换行仍按原样展示。
          content.textContent =
            proposal.content === "" ? "（空文件，0 字节）" : proposal.content;

          contentPanel.append(contentLabel, content);
          comparison.append(contentPanel);
        } else {
          scopeHint.textContent = "这里只对照本次替换片段，不是完整文件。";

          const beforePanel = document.createElement("section");
          beforePanel.className = "proposal-before";

          const beforeLabel = document.createElement("h3");
          beforeLabel.textContent = "替换前 · 将移除的片段";

          const before = document.createElement("pre");
          before.textContent = proposal.oldText;

          beforePanel.append(beforeLabel, before);

          const afterPanel = document.createElement("section");
          afterPanel.className = "proposal-after";

          const afterLabel = document.createElement("h3");
          afterLabel.textContent = "替换后 · 将插入的片段";

          const after = document.createElement("pre");
          after.textContent = proposal.newText || "（删除原片段，不插入内容）";

          afterPanel.append(afterLabel, after);
          comparison.append(beforePanel, afterPanel);
        }

        // 两种草稿均使用纯文本展示，HTML 内容不会作为页面元素执行。
        preview.replaceChildren(title, scopeHint, comparison);
        saveButton.hidden = false;
      } catch (error) {
        preview.replaceChildren();
        onError(error);
      } finally {
        setBusy(false);
      }
    });

    saveButton.addEventListener("click", async () => {
      setBusy(true);
      saveButton.disabled = true;

      try {
        const result = await applyProposal(id);
        saved = true;

        // 主进程确认文件已保存后，才从未保存数量中扣除。
        article.dataset.pending = "false";
        publishCount();
        // 已保存记录不能再通过放弃按钮移除。
        discardButton.disabled = true;

        preview.replaceChildren();
        // 会话记录失败时，文件依然已经保存，按钮仍保持“已保存”。
        // 即使会话记录成功，也可能存在草稿状态落盘警告。
        status.textContent =
          result.warning || `已保存：${result.path}。保存记录已加入当前会话。`;

        viewButton.disabled = true;
        saveButton.textContent = "已保存";
      } catch (error) {
        // 失败后重新审阅，不能继续使用页面上的旧检查结果。
        saveButton.hidden = true;
        status.textContent = "保存失败，请重新查看草稿或生成新草稿。";
        onError(error);
      } finally {
        saveButton.disabled = saved;
        setBusy(false);
      }
    });
    discardButton.addEventListener("click", async () => {
      setBusy(true);
      discardButton.disabled = true;
      status.textContent = "正在放弃草稿……";

      try {
        // 主进程确认快照保存成功后，才移除页面入口。
        await discardProposal(id);
        article.remove();

        // 放弃落盘成功后，才移除页面入口并更新数量。
        publishCount();
      } catch (error) {
        status.textContent = "放弃失败，草稿仍保留，可以重试。";

        onError(error);
      } finally {
        discardButton.disabled = false;
        setBusy(false);
      }
    });
    article.append(viewButton, preview, saveButton, discardButton, status);
    container.appendChild(article);
    publishCount();
  }

  return { add, clear };
}

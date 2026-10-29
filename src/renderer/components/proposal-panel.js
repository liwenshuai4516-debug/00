export function createProposalPanel(
  container,
  loadProposal,
  applyProposal,
  setBusy,
  onError,
) {
  function clear() {
    container.replaceChildren();
  }

  function add(id) {
    const article = document.createElement("article");
    const viewButton = document.createElement("button");
    const saveButton = document.createElement("button");
    const preview = document.createElement("div");
    const status = document.createElement("p");
    let saved = false;

    viewButton.type = "button";
    viewButton.textContent = "查看草稿";
    saveButton.type = "button";
    saveButton.textContent = "确认保存到文件";
    saveButton.hidden = true;

    viewButton.addEventListener("click", async () => {
      setBusy(true);
      saveButton.hidden = true;
      status.textContent = "";

      try {
        const proposal = await loadProposal(id);
        const title = document.createElement("p");
        title.textContent = `文件：${proposal.path}（本次检查通过，尚未保存）`;

        const beforeLabel = document.createElement("p");
        beforeLabel.textContent = "替换前：";
        const before = document.createElement("pre");
        before.textContent = proposal.oldText;

        const afterLabel = document.createElement("p");
        afterLabel.textContent = "替换后：";
        const after = document.createElement("pre");
        after.textContent = proposal.newText || "（删除以上原文）";

        // 代码只作为文本展示；审阅通过后才显示确认保存入口。
        preview.replaceChildren(title, beforeLabel, before, afterLabel, after);
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
        // 页面只提交编号，主进程重新取草稿并验证文件基线。
        const result = await applyProposal(id);
        saved = true;
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

    article.append(viewButton, preview, saveButton, status);
    container.appendChild(article);
  }

  return { add, clear };
}

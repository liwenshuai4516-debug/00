// 项目入口与状态独立管理；项目清单交给下方会话分组统一展示。
export function createProjectPanel(panel, agent, setPageBusy, onOpenProject, onProjectsChange, renameDialog) {
  const addButton = panel.querySelector("#add-project-button");
  const retryButton = panel.querySelector("#reload-projects-button");
  const status = panel.querySelector('[role="status"]');
  let busy = false;
  let loading = false;
  let projects = [];
  let renaming = null;
  let pendingCheck = null;
  const form = renameDialog.querySelector("form");
  const nameInput = form.elements.name;
  const renameStatus = renameDialog.querySelector('[role="status"]');
  const saveButton = form.querySelector('[type="submit"]');
  const cancelButton = form.querySelector("[data-cancel]");
  const checkButton = form.querySelector("[data-check]");

  function setStatus(text, failed = false) {
    status.textContent = text;
    // 常规进度仅供辅助阅读播报，错误在入口下方展示并保留重试。
    status.classList.toggle("sr-only", !failed);
  }

  function updateControls() {
    addButton.disabled = busy || loading;
    retryButton.disabled = busy || loading;
    panel.setAttribute("aria-busy", String(busy || loading));
    nameInput.disabled = busy || loading || Boolean(pendingCheck);
    saveButton.disabled = nameInput.disabled;
    cancelButton.disabled = busy || loading;
    checkButton.disabled = busy || loading;
    renameDialog.setAttribute("aria-busy", String(busy || loading));
  }

  function setBusy(value) {
    busy = value;
    updateControls();
  }

  async function open(project) {
    if (busy || loading) return;
    setPageBusy(true);
    setStatus(`正在打开项目：${project.name}……`);
    try {
      // 页面只提交编号；目录解析与恢复继续由原有主进程接口完成。
      await onOpenProject(project.id);
      setStatus(`已打开项目：${project.name}`);
    } catch (error) {
      setStatus(`打开失败：${error.message}`, true);
    } finally {
      setPageBusy(false);
    }
  }

  async function refresh() {
    loading = true;
    updateControls();
    setStatus("正在读取项目……");
    try {
      projects = await agent.listProjects();
      onProjectsChange(projects);
      retryButton.hidden = true;
      setStatus("");
      return true;
    } catch (error) {
      // 失败保留上次清单，不把错误伪装成空项目列表。
      retryButton.hidden = false;
      setStatus(`项目读取失败：${error.message}`, true);
      return false;
    } finally {
      loading = false;
      updateControls();
    }
  }

  function rename(project) {
    if (busy || loading || renameDialog.open) return;
    renaming = project;
    pendingCheck = null;
    checkButton.hidden = true;
    renameStatus.textContent = "";
    nameInput.removeAttribute("aria-invalid");
    nameInput.value = project.name;
    updateControls();
    renameDialog.showModal();
    nameInput.focus();
    nameInput.select();
  }

  function finishRename(saved) {
    // 先使用已确认结果更新名称；列表重读失败也不回退到旧名称。
    projects = projects.map(project => project.id === saved.id ? saved : project);
    onProjectsChange(projects);
    pendingCheck = null;
    renameDialog.close();
  }

  async function checkRename() {
    const target = pendingCheck;
    const refreshed = await refresh();
    if (!refreshed) {
      renameStatus.textContent = "保存结果尚未确认，请核对保存结果后再继续。";
      checkButton.hidden = false;
      return false;
    }
    pendingCheck = null;
    checkButton.hidden = true;
    const actual = projects.find(project => project.id === target.id);
    if (actual?.name === target.name) {
      finishRename(actual);
      setStatus(`已重命名项目：${actual.name}`);
      return true;
    }
    return false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || loading || pendingCheck || !renaming) return;
    const name = nameInput.value.trim();
    if (!name || name.length > 40) {
      renameStatus.textContent = "项目名称请输入 1～40 个字符。";
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.focus();
      return;
    }
    setPageBusy(true);
    renameStatus.textContent = "正在保存……";
    try {
      const saved = await agent.renameProject(renaming.id, name);
      finishRename(saved);
      const refreshed = await refresh();
      setStatus(refreshed ? `已重命名项目：${saved.name}` : "项目名称已保存；列表读取失败，请重新读取。", !refreshed);
    } catch (error) {
      // 返回丢失时只读核对，不自动重复写入。
      pendingCheck = { id: renaming.id, name };
      if (!(await checkRename()) && !pendingCheck) {
        renameStatus.textContent = `重命名未完成：${error.message}`;
      }
    } finally {
      setPageBusy(false);
      if (renameDialog.open) (pendingCheck ? checkButton : nameInput).focus();
      else focusRenameButton();
    }
  });

  checkButton.addEventListener("click", async () => {
    if (busy || loading || !pendingCheck) return;
    setPageBusy(true);
    try {
      if (!(await checkRename()) && !pendingCheck) renameStatus.textContent = "未确认保存为该名称，可检查后重新保存。";
    } finally {
      setPageBusy(false);
      if (renameDialog.open) (pendingCheck ? checkButton : nameInput).focus();
      else focusRenameButton();
    }
  });

  function focusRenameButton() {
    // 刷新会重建分组按钮，按编号找回焦点。
    const button = [...document.querySelectorAll(".project-rename-toggle")]
      .find(item => item.dataset.projectId === renaming?.id);
    (button ?? addButton).focus();
  }

  cancelButton.addEventListener("click", () => { if (!busy && !loading) renameDialog.close(); });
  renameDialog.addEventListener("cancel", (event) => { if (busy || loading) event.preventDefault(); });
  renameDialog.addEventListener("close", () => { if (!busy) focusRenameButton(); });
  nameInput.addEventListener("input", () => {
    nameInput.removeAttribute("aria-invalid");
    renameStatus.textContent = "";
  });
  renameDialog.addEventListener("keydown", (event) => {
    if (event.isComposing && ["Enter", "Escape"].includes(event.key)) event.preventDefault();
  });

  addButton.addEventListener("click", async () => {
    if (addButton.disabled) return;
    setPageBusy(true);
    setStatus("正在选择项目目录……");
    try {
      const result = await agent.addProject();
      if (result.canceled) {
        setStatus("已取消添加。");
        return;
      }
      const refreshed = await refresh();
      setStatus(refreshed
        ? `已添加项目：${result.project.name}`
        : `项目已添加；${status.textContent}，请重新读取。`, !refreshed);
    } catch (error) {
      setStatus(`添加失败：${error.message}`, true);
    } finally {
      setPageBusy(false);
      addButton.focus();
    }
  });

  retryButton.addEventListener("click", () => {
    if (!retryButton.disabled) void refresh();
  });

  return { setBusy, refresh, open, rename };
}

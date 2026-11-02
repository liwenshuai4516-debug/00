// 项目入口与状态独立管理；项目清单交给下方会话分组统一展示。
export function createProjectPanel(panel, agent, setPageBusy, onOpenProject, onProjectsChange) {
  const addButton = panel.querySelector("#add-project-button");
  const retryButton = panel.querySelector("#reload-projects-button");
  const status = panel.querySelector('[role="status"]');
  let busy = false;
  let loading = false;

  function setStatus(text, failed = false) {
    status.textContent = text;
    // 常规进度仅供辅助阅读播报，错误在入口下方展示并保留重试。
    status.classList.toggle("sr-only", !failed);
  }

  function updateControls() {
    addButton.disabled = busy || loading;
    retryButton.disabled = busy || loading;
    panel.setAttribute("aria-busy", String(busy || loading));
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
      const projects = await agent.listProjects();
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

  return { setBusy, refresh, open };
}

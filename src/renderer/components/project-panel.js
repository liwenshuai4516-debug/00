// 已登记项目独立展示；添加项目不替换当前对话。
export function createProjectPanel(panel, agent, setPageBusy, onOpenProject) {
  const list = panel.querySelector("ul");
  const addButton = panel.querySelector("#add-project-button");
  const retryButton = panel.querySelector("#reload-projects-button");
  const status = panel.querySelector('[role="status"]');
  let busy = false;
  let loading = false;

  function updateControls() {
    addButton.disabled = busy || loading;
    retryButton.disabled = busy || loading;
    for (const button of list.querySelectorAll("button")) {
      button.disabled = busy || loading;
    }
    panel.setAttribute("aria-busy", String(busy || loading));
  }

  function setBusy(value) {
    busy = value;
    updateControls();
  }

  function render(projects) {
    list.replaceChildren();

    for (const project of projects) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "registered-project-open";
      button.title = project.workspaceDir;

      const name = document.createElement("strong");
      name.className = "registered-project-name";
      name.textContent = project.name;
      name.title = project.name;

      const location = document.createElement("span");
      location.className = "registered-project-path";
      location.textContent = project.workspaceDir;
      location.title = project.workspaceDir;

      button.append(name, location);
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        setPageBusy(true);
        status.textContent = `正在打开项目：${project.name}……`;
        let opened = false;

        try {
          // 页面只提交编号；目录解析与恢复由主进程完成。
          await onOpenProject(project.id);
          opened = true;
          status.textContent = `已打开项目：${project.name}`;
        } catch (error) {
          // 打开失败保留原消息、输入和文件草稿，在项目区提示。
          status.textContent = `打开失败：${error.message}`;
        } finally {
          setPageBusy(false);
          if (!opened) button.focus();
        }
      });

      item.appendChild(button);
      list.appendChild(item);
    }

    if (!projects.length) {
      const empty = document.createElement("li");
      empty.className = "registered-project-empty";
      empty.textContent = "还没有添加项目。";
      list.appendChild(empty);
    }
  }

  async function refresh() {
    loading = true;
    updateControls();
    status.textContent = "正在读取项目……";

    try {
      const projects = await agent.listProjects();
      render(projects);
      retryButton.hidden = true;
      status.textContent = "";
      return true;
    } catch (error) {
      // 保留上次成功读取的清单，失败不能伪装成空列表。
      retryButton.hidden = false;
      status.textContent = `项目读取失败：${error.message}`;
      return false;
    } finally {
      loading = false;
      updateControls();
    }
  }

  addButton.addEventListener("click", async () => {
    if (addButton.disabled) return;
    setPageBusy(true);
    status.textContent = "正在选择项目目录……";

    try {
      const result = await agent.addProject();

      if (result.canceled) {
        status.textContent = "已取消添加。";
        return;
      }

      const refreshed = await refresh();
      status.textContent = refreshed
        ? `已添加项目：${result.project.name}`
        : `项目已添加；${status.textContent}，请重新读取。`;
    } catch (error) {
      status.textContent = `添加失败：${error.message}`;
    } finally {
      setPageBusy(false);
      addButton.focus();
    }
  });

  retryButton.addEventListener("click", () => {
    if (!retryButton.disabled) refresh();
  });

  return { setBusy, refresh };
}
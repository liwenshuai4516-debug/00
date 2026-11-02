// 系统窗口与会话服务由启动入口注入；页面只提交项目编号。
function createProjectService(projectStore, chooseDirectory, sessionService) {
  function listProjects() {
    return projectStore.list();
  }

  async function addProject(sender) {
    const selection = await chooseDirectory(sender, {
      title: "添加项目",
      buttonLabel: "添加项目",
      properties: ["openDirectory"],
    });

    if (selection.canceled || !selection.filePaths?.[0]) {
      return { canceled: true };
    }

    // 等待登记落盘成功后，才向页面返回成功。
    const project = await projectStore.add(selection.filePaths[0]);
    return { canceled: false, project };
  }

  async function openProject(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("请选择项目。");
    }

    // 每次从主进程存储查找目录，不接受页面传来的路径。
    const projects = await projectStore.list();
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("未找到该项目，请重新读取项目列表。");
    }

    return sessionService.openWorkspace(project.workspaceDir);
  }

  function renameProject(projectId, name) {
    // 只更新项目元信息，校验与落盘沿用存储层，不触碰当前会话。
    return projectStore.rename(projectId, name);
  }

  return { listProjects, addProject, openProject, renameProject };
}

module.exports = { createProjectService };

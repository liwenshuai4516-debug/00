// 系统窗口由启动入口注入；这里只负责项目登记，不切换会话。
function createProjectService(projectStore, chooseDirectory) {
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

  return { listProjects, addProject };
}

module.exports = { createProjectService };
// 选择窗口由启动入口提供，业务服务不直接依赖 Electron。
function createWorkspaceSelectionService(sessionService, chooseDirectory) {
  async function selectWorkspace(sender) {
    // 不先加载旧会话，旧目录失效时也可以重新选择。
    const selection = await chooseDirectory(sender, {
      title: "选择工作目录",
      buttonLabel: "选择并新建对话",
      properties: ["openDirectory"],
    });

    if (selection.canceled || !selection.filePaths?.[0]) {
      return { canceled: true };
    }

    // 只有系统窗口返回的目录才能进入切换服务。
    const result = await sessionService.switchWorkspace(selection.filePaths[0]);
    return { canceled: false, ...result };
  }

  return { selectWorkspace };
}

module.exports = { createWorkspaceSelectionService };
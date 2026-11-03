function registerModelIpc(ipcMain, providers, sessions, runIdleOperation) {
  // 路径只由主进程的 Pi 官方目录决定，不接受页面指定文件。
  ipcMain.handle("agent:read-model-configuration", () => providers.readConfiguration());
  ipcMain.handle("agent:open-models-configuration", () => providers.openConfiguration());
  ipcMain.handle("agent:reload-models", () => runIdleOperation(() => sessions.reloadModels()));
  ipcMain.handle("agent:set-default-model", () => runIdleOperation(() => sessions.setDefaultModel()));
  ipcMain.handle("agent:set-thinking-level", (_event, level) => runIdleOperation(() => sessions.setThinkingLevel(level)));
}

module.exports = { registerModelIpc };

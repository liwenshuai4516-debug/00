function registerModelIpc(ipcMain, providers, sessions, runIdleOperation) {
  // 路径只由主进程的 Pi 官方目录决定，不接受页面指定文件。
  ipcMain.handle("agent:read-model-configuration", () => providers.readConfiguration());
  ipcMain.handle("agent:open-models-configuration", () => providers.openConfiguration());
  ipcMain.handle("agent:reload-models", () => runIdleOperation(() => sessions.reloadModels()));

  // 结构化读取官方 models.json；不返回 apiKey、headers 等凭据内容。
  ipcMain.handle("agent:read-model-catalog", () => providers.readCatalog());

  // 写入后立即让运行时重读配置；重读失败只作为提示返回，不回滚已经保存的文件。
  async function reloadAfterWrite(result) {
    try {
      await sessions.reloadModels();
      return result;
    } catch (error) {
      return { ...result, warning: `配置已保存，但重新读取失败：${error.message}` };
    }
  }

  ipcMain.handle("agent:save-model", (_event, input) =>
    runIdleOperation(async () => reloadAfterWrite(await providers.saveModel(input))),
  );

  ipcMain.handle("agent:delete-model", (_event, providerId, modelId) =>
    runIdleOperation(async () => reloadAfterWrite(await providers.deleteModel(providerId, modelId))),
  );

  ipcMain.handle("agent:save-provider", (_event, input) =>
    runIdleOperation(async () => reloadAfterWrite(await providers.saveProvider(input))),
  );

  ipcMain.handle("agent:delete-provider", (_event, providerId) =>
    runIdleOperation(async () => reloadAfterWrite(await providers.deleteProvider(providerId))),
  );

  // 只接受供应商与模型编号，实际使用哪份配置由主进程解析。
  ipcMain.handle("agent:set-default-model", (_event, provider, modelId) =>
    runIdleOperation(() =>
      sessions.setDefaultModel(
        typeof provider === "string" ? provider : undefined,
        typeof modelId === "string" ? modelId : undefined,
      ),
    ),
  );
  ipcMain.handle("agent:set-thinking-level", (_event, level) => runIdleOperation(() => sessions.setThinkingLevel(level)));
}

module.exports = { registerModelIpc };

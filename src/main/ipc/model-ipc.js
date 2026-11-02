function registerModelIpc(ipcMain, service, sessions, runIdleOperation) {
  const profileInput = input => ({
    name: input?.name, kind: input?.kind, provider: input?.provider, modelId: input?.modelId,
    baseUrl: input?.baseUrl, authMode: input?.authMode, apiKey: input?.apiKey, api: input?.api,
    contextWindow: input?.contextWindow, maxTokens: input?.maxTokens, replaceId: input?.replaceId,
    reasoning: input?.reasoning, vision: input?.vision,
  });
  const probeInput = input => ({ baseUrl: input?.baseUrl, apiKey: input?.apiKey, api: input?.api,
    profileId: input?.profileId, provider: input?.provider });
  const idle = (name, action) => ipcMain.handle(`agent:${name}`, (_event, ...args) => runIdleOperation(() => action(...args)));
  ipcMain.handle("agent:read-model-settings", () => service.read());
  ipcMain.handle("agent:list-settings-models", (_event, provider) => service.listModels(provider));
  idle("save-model-settings", input => service.save(profileInput(input)));
  idle("set-default-model-profile", id => service.setDefault(id));
  idle("clear-default-model-profile", () => service.clearDefault());
  idle("hide-model-profile", id => service.hide(id));
  idle("clone-model-profile", (id, name) => service.clone(id, name));
  idle("fetch-model-catalog", input => service.fetchCatalog(probeInput(input)));
  idle("test-model-connection", input => service.testConnection(probeInput(input)));
  idle("refresh-profile-models", id => service.refreshProfile(id));
  idle("refresh-builtin-models", provider => service.refreshBuiltin(provider));
  idle("append-builtin-model", (provider, input) => service.appendBuiltin(provider, profileInput(input)));
  ipcMain.handle("agent:list-model-profiles", () => sessions.listModelProfiles());
  idle("switch-model-profile", id => sessions.switchModelProfile(id));
  idle("set-thinking-level", level => sessions.setThinkingLevel(level));
  ipcMain.handle("agent:provider-auth", (_event, provider) => service.providerAuth(provider));
  async function changeAuth(action) {
    const result = await action();
    await sessions.refreshModelAuth?.();
    return result;
  }
  idle("add-provider-key", (provider, name, key) => changeAuth(() => service.addKey(provider, name, key)));
  idle("activate-provider-key", (provider, id) => changeAuth(() => service.activateKey(provider, id)));
  idle("remove-provider-key", (provider, id) => changeAuth(() => service.removeKey(provider, id)));
  idle("provider-oauth-start", provider => service.oauth.start(provider));
  // 登录提示和取消不占用会话互斥，避免无法结束正在等待输入的流程。
  ipcMain.handle("agent:provider-oauth-reply", (_event, flowId, promptId, value) => service.oauth.reply(flowId, promptId, value));
  ipcMain.handle("agent:provider-oauth-cancel", (_event, id) => service.oauth.cancel(id));
  ipcMain.handle("agent:list-provider-oauth-flows", () => service.oauth.list());
  ipcMain.handle("agent:open-provider-oauth-link", (_event, id) => service.openOAuthLink(id));
  idle("provider-oauth-logout", provider => changeAuth(() => service.logout(provider)));
  idle("enrich-models", (ids, hints) => service.enrichment.start(ids, hints));
  ipcMain.handle("agent:cancel-model-enrichment", (_event, id) => service.enrichment.cancel(id));
  ipcMain.handle("agent:list-model-enrichments", () => service.enrichment.list());
  const watchers = new Map();
  ipcMain.handle("agent:watch-model-settings", event => {
    const sender = event.sender;
    if (watchers.has(sender.id)) return;
    const send = (type, value) => { if (!sender.isDestroyed()) sender.send("agent:model-settings-event", { type, value }); };
    const unsubscribers = [service.oauth.subscribe(value => send("oauth", value)), service.enrichment.subscribe(value => send("enrichment", value))];
    const unsubscribe = () => { unsubscribers.forEach(fn => fn()); watchers.delete(sender.id); sender.removeListener("destroyed", unsubscribe); };
    watchers.set(sender.id, unsubscribe);
    sender.once("destroyed", unsubscribe);
  });
  ipcMain.handle("agent:unwatch-model-settings", event => watchers.get(event.sender.id)?.());
}

module.exports = { registerModelIpc };

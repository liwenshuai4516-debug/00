const { contextBridge, ipcRenderer } = require("electron");
const agent = {};
for (const name of [
  "listUnsentSessions", "loadHistory", "currentSession", "listSessions", "getSessionInfo", "listProposals", "listProjects",
  "listModels", "switchModel", "readModelConfiguration", "openModelsConfiguration", "reloadModels",
  "readModelCatalog", "saveModel", "deleteModel", "setDefaultModel", "setThinkingLevel", "loadComposerDraft", "saveComposerDraft", "inspectComposerSend",
  "addProject", "openProject", "openSession", "sendMessage", "stop", "newChat",
  "listProjectEnvironments", "saveProjectEnvironment", "deleteProjectEnvironment",
  "listTestData", "deleteTestData",
]) {
  agent[name] = (...args) => ipcRenderer.invoke("sidebar-check", name, args);
}
for (const name of ["onTextDelta", "onRequestStatus", "onToolEvent"]) agent[name] = () => () => {};
agent.onDraftConsumed = (callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on("sidebar-consumed", listener);
  return () => ipcRenderer.removeListener("sidebar-consumed", listener);
};
// 本专项不发关闭请求；关闭协议由window-close-page.check.cjs独立验证。
agent.closeReady = () => {};
agent.onPrepareClose = () => () => {};
agent.reportCloseResult = () => {};

contextBridge.exposeInMainWorld("agent", agent);

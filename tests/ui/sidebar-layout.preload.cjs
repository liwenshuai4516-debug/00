const { contextBridge, ipcRenderer } = require("electron");
const agent = {};
for (const name of [
  "loadHistory", "currentSession", "listSessions", "getSessionInfo", "listProposals", "listProjects",
  "listModelProfiles", "switchModelProfile", "loadComposerDraft", "saveComposerDraft", "inspectComposerSend",
  "addProject", "openProject", "openSession", "sendMessage", "stop", "newChat",
]) {
  agent[name] = (...args) => ipcRenderer.invoke("sidebar-check", name, args);
}
for (const name of ["onTextDelta", "onRequestStatus", "onToolEvent"]) agent[name] = () => () => {};
agent.onDraftConsumed = (callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on("sidebar-consumed", listener);
  return () => ipcRenderer.removeListener("sidebar-consumed", listener);
};
contextBridge.exposeInMainWorld("agent", agent);

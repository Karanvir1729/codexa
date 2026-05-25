const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistant", {
  enable: () => ipcRenderer.invoke("assistant:enable"),
  listSessions: () => ipcRenderer.invoke("assistant:list-sessions"),
  loadSession: (sessionId) => ipcRenderer.invoke("assistant:load-session", sessionId),
  newSession: (input) => ipcRenderer.invoke("assistant:new-session", input),
  send: (input) => ipcRenderer.invoke("assistant:send", input),
  systemStatus: () => ipcRenderer.invoke("assistant:system-status"),
  linkCodex: () => ipcRenderer.invoke("assistant:link-codex"),
  openPermission: (key) => ipcRenderer.invoke("assistant:open-permission", key),
  openCodex: () => ipcRenderer.invoke("assistant:open-codex"),
  openLogs: () => ipcRenderer.invoke("assistant:open-logs"),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("assistant:event", listener);
    return () => ipcRenderer.removeListener("assistant:event", listener);
  },
});

const { contextBridge, ipcRenderer } = require("electron");

function readConfig() {
  const prefix = "--codexa-config=";
  const arg = process.argv.find((item) => item.startsWith(prefix));
  if (!arg) return {};
  try {
    return JSON.parse(Buffer.from(arg.slice(prefix.length), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

contextBridge.exposeInMainWorld("codexaDesktop", {
  config: readConfig(),
  openExternal: (url) => ipcRenderer.invoke("codexa:open-external", url),
});

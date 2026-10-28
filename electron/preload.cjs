const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cc", {
  // This run's secret for the server: sent on the WebSocket (?key=) and as X-App-Key on every POST. Only the app page gets it.
  appKey: () => ipcRenderer.invoke("cc:app-key"),
  pickFolder: () => ipcRenderer.invoke("cc:pick-folder"),
  openObsidian: (url) => ipcRenderer.invoke("cc:open-obsidian", url),
  // The page's own minimize, maximize/restore and close buttons (the window has no native ones).
  minimizeWindow: () => ipcRenderer.invoke("cc:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("cc:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("cc:window-close"),
  isWindowMaximized: () => ipcRenderer.invoke("cc:window-is-maximized"),
  // Only the true/false reaches the page, never the IPC event.
  onWindowMaximized: (callback) => { ipcRenderer.on("cc:window-maximized", (_event, maximized) => callback(maximized === true)); },
  // Closing the app asks the page first: it answers "close", "hold" (its warning is showing) or "keep" (Keep open).
  onCloseRequested: (callback) => { ipcRenderer.on("cc:close-requested", () => callback()); },
  answerClose: (answer) => ipcRenderer.invoke("cc:close-answer", answer),
});

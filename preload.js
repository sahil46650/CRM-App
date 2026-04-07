const { contextBridge, ipcRenderer } = require("electron");

/* =========================
   SCREENSHOT API
========================= */
contextBridge.exposeInMainWorld("ssAPI", {
  start: (data) => ipcRenderer.invoke("ss:start", data),
  stop: () => ipcRenderer.invoke("ss:stop")
});

/* =========================
   AUTH STORAGE API (Electron Only)
========================= */
contextBridge.exposeInMainWorld("authAPI", {
  save: (data) => ipcRenderer.invoke("auth:save", data),
  get: () => ipcRenderer.invoke("auth:get"),
  clear: () => ipcRenderer.invoke("auth:clear")
});

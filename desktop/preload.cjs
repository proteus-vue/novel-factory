/**
 * 预加载桥：向渲染进程暴露受控的桌面 API（contextIsolation 下安全）。
 * 前端通过 window.Desktop.* 调用；非 Electron 环境该对象不存在，app.js 已做降级。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("Desktop", {
  isElectron: true,
  info: () => ipcRenderer.invoke("desktop:info"),
  openDataDir: () => ipcRenderer.invoke("desktop:open-data-dir"),
  chooseImport: () => ipcRenderer.invoke("desktop:choose-import"),
  saveExport: (name, content) => ipcRenderer.invoke("desktop:save-export", name, content),
  notify: (title, body) => ipcRenderer.invoke("desktop:notify", title, body),
  restartServer: () => ipcRenderer.invoke("desktop:restart-server"),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  // 主进程主动推送
  onAction: (cb) => ipcRenderer.on("desktop:action", (_e, action) => cb(action)),
  onImportBackup: (cb) => ipcRenderer.on("desktop:import-backup", (_e, data) => cb(data)),
});

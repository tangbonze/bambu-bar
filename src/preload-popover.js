// 弹出面板的预加载脚本：只暴露必要的能力（contextIsolation 下不给渲染层 node）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bambu', {
  getSnapshot: () => ipcRenderer.invoke('state:snapshot'),
  getStrings: () => ipcRenderer.invoke('ui:strings'),
  ready: () => ipcRenderer.invoke('ui:ready'),
  setHeight: (h) => ipcRenderer.invoke('ui:height', h),
  onState: (cb) => {
    ipcRenderer.on('state:update', (_e, snap) => cb(snap));
  },
  onLocale: (cb) => {
    ipcRenderer.on('ui:locale', (_e, s) => cb(s));
  },
  refreshAll: () => ipcRenderer.invoke('app:refreshAll'),
  refreshOne: (serial) => ipcRenderer.invoke('app:refreshOne', serial),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  setHidden: (serial, hidden) => ipcRenderer.invoke('printer:hide', serial, hidden),
  rename: (serial, name) => ipcRenderer.invoke('printer:rename', serial, name),
  openSettings: (section) => ipcRenderer.invoke('app:openSettings', section),
  diagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  quit: () => ipcRenderer.invoke('app:quit'),
  hidePanel: () => ipcRenderer.send('popover:hide'),
});

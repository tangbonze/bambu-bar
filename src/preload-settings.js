// 设置窗的预加载脚本。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bambuSettings', {
  getSettings: () => ipcRenderer.invoke('settings:state'),
  getStrings: () => ipcRenderer.invoke('ui:strings'),
  setPref: (key, value) => ipcRenderer.invoke('settings:setPref', key, value),
  onPrintersChanged: (cb) => ipcRenderer.on('settings:printersChanged', (_e, snap) => cb(snap)),
  onNavigate: (cb) => ipcRenderer.on('settings:navigate', (_e, section) => cb(section)),

  // 云端登录
  browserLogin: (region) => ipcRenderer.invoke('bambu:browserLogin', region),
  login: (region, account, password) => ipcRenderer.invoke('bambu:login', region, account, password),
  verify: (region, account, password, tfaKey, code) =>
    ipcRenderer.invoke('bambu:verify', region, account, password, tfaKey, code),
  requestSmsCode: (region, phone) => ipcRenderer.invoke('bambu:requestSmsCode', region, phone),
  loginWithCode: (region, account, code, tfaKey) => ipcRenderer.invoke('bambu:loginWithCode', region, account, code, tfaKey),
  completeCloudLogin: () => ipcRenderer.invoke('bambu:completeCloudLogin'),
  logout: () => ipcRenderer.invoke('bambu:logout'),

  // 打印机管理
  addLan: (payload) => ipcRenderer.invoke('lan:add', payload),
  removeLan: (serial) => ipcRenderer.invoke('lan:remove', serial),
  rename: (serial, name) => ipcRenderer.invoke('printer:rename', serial, name),
  setHidden: (serial, hidden) => ipcRenderer.invoke('printer:hide', serial, hidden),

  copy: (text) => ipcRenderer.invoke('app:copy', text),
  diagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  revealData: () => ipcRenderer.invoke('app:revealData'),
  close: () => ipcRenderer.invoke('window:closeSettings'),
});

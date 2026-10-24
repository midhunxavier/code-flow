const { contextBridge, ipcRenderer } = require('electron');

const origin = process.argv.find(argument => argument.startsWith('--codeflow-origin='))?.slice('--codeflow-origin='.length);
if (process.isMainFrame && location.origin === origin) {
  contextBridge.exposeInMainWorld('codeflowDesktop', {
    getUpdateState: () => ipcRenderer.invoke('codeflow:updates:state'),
    checkForUpdates: () => ipcRenderer.invoke('codeflow:updates:check'),
    downloadUpdate: () => ipcRenderer.invoke('codeflow:updates:download'),
    openUpdateInstaller: () => ipcRenderer.invoke('codeflow:updates:installer'),
    installUpdate: () => ipcRenderer.invoke('codeflow:updates:install'),
    onUpdateState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('codeflow:updates:changed', listener);
      return () => ipcRenderer.removeListener('codeflow:updates:changed', listener);
    },
  });
}

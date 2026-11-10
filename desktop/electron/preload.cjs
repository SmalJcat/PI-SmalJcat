const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`pi:${name}`, ...args);
contextBridge.exposeInMainWorld('pi', {
  bootstrap: () => invoke('bootstrap'),
  connect: options => invoke('connect', options),
  snapshot: () => invoke('snapshot'),
  sessions: cwd => invoke('sessions', cwd),
  chooseWorkspace: () => invoke('choose-workspace'),
  chooseExecutable: () => invoke('choose-executable'),
  command: (type, data) => invoke('command', type, data),
  stop: () => invoke('stop'),
  respond: response => invoke('dialog', response),
  files: relative => invoke('files', relative),
  preview: relative => invoke('preview', relative),
  changes: () => invoke('changes'),
  diff: relative => invoke('diff', relative),
  attachments: paths => invoke('attachments', paths),
  chooseAttachments: () => invoke('choose-attachments'),
  pathForFile: file => webUtils.getPathForFile(file),
  revealWorkspace: cwd => invoke('reveal-workspace', cwd),
  revealConfig: () => invoke('reveal-config'),
  openLink: url => invoke('open-link', url),
  exportSession: () => invoke('export'),
  diagnostics: () => invoke('diagnostics'),
  window: action => invoke('window', action),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('pi:event', listener);
    return () => ipcRenderer.removeListener('pi:event', listener);
  },
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  setIgnoreMouseEvents: (ignore, opts) => ipcRenderer.send('set-ignore-mouse-events', ignore, opts),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onCountUpdate: (fn) => ipcRenderer.on('count-update', (_, data) => fn(data)),
  onLastPhrase: (fn) => ipcRenderer.on('last-phrase', (_, data) => fn(data)),
  onVolumeUpdate: (fn) => ipcRenderer.on('volume-update', (_, data) => fn(data)),
});

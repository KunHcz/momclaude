const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  slipperSlap: () => ipcRenderer.send('slipper-slap'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  onSpawnSlipper: (fn) => ipcRenderer.on('spawn-slipper', () => fn()),
  onDropSlipper: (fn) => ipcRenderer.on('drop-slipper', () => fn()),
});

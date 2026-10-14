// The page's host (src/host.js): a save that asks where, the kits shipped
// with the app, and a download for the rest.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('packagerHost', {
  kind: 'desktop',
  kitsBase: 'kits/',
  save: (bytes, name) => ipcRenderer.invoke('save', name, bytes),
  // A kit from the engine's releases (src/releases.js), fetched by the main process.
  download: (url) => ipcRenderer.invoke('download', url)
})

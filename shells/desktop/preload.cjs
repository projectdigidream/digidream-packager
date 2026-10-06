// The page's host (src/host.js): a save that asks where, and the kits shipped
// with the app.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('packagerHost', {
  kind: 'desktop',
  kitsBase: 'kits/',
  save: (bytes, name) => ipcRenderer.invoke('save', name, bytes)
})

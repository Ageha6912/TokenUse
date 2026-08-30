import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('tokenuse', {
  onSnapshot: (cb: (s: { tokens: number; cost: number | null; unknown: number; requests: number }) => void) => {
    ipcRenderer.on('snapshot', (_e, s) => cb(s))
  },
  hideFloating: () => ipcRenderer.send('hide-floating'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  dragFloatingStart: () => ipcRenderer.send('floating-drag-start'),
  dragFloatingEnd: () => ipcRenderer.send('floating-drag-end'),
})

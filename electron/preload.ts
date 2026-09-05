import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('tokenuse', {
  onSnapshot: (cb: (s: {
    tokens: number
    cost: number | null
    unknown: number
    requests: number
    monthTokens: number
    monthCost: number | null
    monthUnknown: number
  }) => void) => {
    ipcRenderer.on('snapshot', (_e, s) => cb(s))
  },
  // 展开状态以主进程回发为准（点击别处自动收起时渲染层也要同步）
  onExpandedChanged: (cb: (expanded: boolean) => void) => {
    ipcRenderer.on('expanded-changed', (_e, v) => cb(v))
  },
  setExpanded: (v: boolean) => ipcRenderer.send('floating-set-expanded', v),
  hideFloating: () => ipcRenderer.send('hide-floating'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  dragFloatingStart: () => ipcRenderer.send('floating-drag-start'),
  dragFloatingEnd: () => ipcRenderer.send('floating-drag-end'),
})

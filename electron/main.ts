import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Menu, MenuItemConstructorOptions, Tray, ipcMain, nativeImage, screen } from 'electron'
import { startServer, ServerHandle } from '../src/server/index.js'
import type { Snapshot } from '../src/core/types.js'

let tray: Tray | null = null
let dash: BrowserWindow | null = null
let floating: BrowserWindow | null = null
let handle: ServerHandle | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.setName('TokenUse')
app.setAppUserModelId('com.tokenuse.app')

const fmtN = (n: number): string => {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(Math.round(n))
}

function createDashboard() {
  if (dash && !dash.isDestroyed()) {
    if (dash.isMinimized()) dash.restore()
    dash.show()
    dash.focus()
    return
  }
  dash = new BrowserWindow({
    width: 1320,
    height: 880,
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    title: 'TokenUse',
    webPreferences: { contextIsolation: true },
  })
  const port = handle?.settings.port ?? 8510
  void dash.loadURL(`http://127.0.0.1:${port}`)
  dash.on('close', e => {
    if (!quitting) {
      e.preventDefault()
      dash?.hide()
    }
  })
  dash.on('closed', () => {
    dash = null
  })
}

const FLOAT_MIN_W = 140
const FLOAT_MIN_H = 20

// 当前悬浮条尺寸：初始取自设置，缩放时实时更新，拖动/约束均以此为准
let floatingSize = { w: 320, h: 36 }

function createFloating() {
  const s = handle?.settings
  floatingSize = {
    w: Math.round(Math.min(2000, Math.max(FLOAT_MIN_W, Number(s?.floatingW) || 320))),
    h: Math.round(Math.min(200, Math.max(FLOAT_MIN_H, Number(s?.floatingH) || 36))),
  }
  floating = new BrowserWindow({
    width: floatingSize.w,
    height: floatingSize.h,
    useContentSize: true,
    frame: false,
    transparent: true,
    resizable: false,
    thickFrame: false, // 关键：移除 WS_THICKFRAME，否则透明窗口四周有隐形缩放热区，拖动会误触系统缩放
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })
  floating.setAlwaysOnTop(true, 'screen-saver')
  const wa = screen.getPrimaryDisplay().workArea
  floating.setBounds({
    x: wa.x + wa.width - floatingSize.w - 14,
    y: wa.y + wa.height - floatingSize.h - 14,
    width: floatingSize.w,
    height: floatingSize.h,
  })
  void floating.loadFile(path.join(app.getAppPath(), 'electron', 'floating.html'))
}

// 把悬浮条约束回光标所在显示器的工作区，防止拖动/自适应宽度把它推出屏幕
// 注意：这里用 setBounds 显式钉住尺寸——setPosition 在分数 DPI 下每次调用会让尺寸漂移 +1px
function clampFloatingToWorkArea() {
  if (!floating || floating.isDestroyed()) return
  const [x, y] = floating.getPosition()
  const display = screen.getDisplayNearestPoint({ x: x + Math.floor(floatingSize.w / 2), y: y + Math.floor(floatingSize.h / 2) })
  const wa = display.workArea
  const nx = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - floatingSize.w - 8))
  const ny = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - floatingSize.h - 8))
  if (nx !== x || ny !== y) floating.setBounds({ x: nx, y: ny, width: floatingSize.w, height: floatingSize.h })
}

function applyFloating() {
  if (!floating || floating.isDestroyed()) return
  if (handle?.settings.floatingBar) {
    if (floating.isMinimized()) floating.restore()
    floating.showInactive()
    clampFloatingToWorkArea()
  } else {
    floating.hide()
  }
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '打开仪表盘', click: () => createDashboard() },
    { type: 'separator' },
    {
      label: '显示悬浮条',
      type: 'checkbox',
      checked: handle?.settings.floatingBar ?? true,
      click: mi => {
        handle?.updateSettings({ floatingBar: mi.checked })
        applyFloating()
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: mi => {
        handle?.updateSettings({ autostart: mi.checked })
        app.setLoginItemSettings({ openAtLogin: mi.checked })
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function onSnap(snap: Snapshot) {
  const t = snap.today
  const tip = `TokenUse 今日 ${fmtN(t.tokens)} tok · ${t.cost == null ? '¥—' : '¥' + t.cost.toFixed(2)}`
  try {
    tray?.setToolTip(tip)
  } catch {
    /* 托盘可能尚未创建 */
  }
  if (floating && !floating.isDestroyed()) {
    floating.webContents.send('snapshot', {
      tokens: t.tokens,
      cost: t.cost,
      unknown: t.costUnknown,
      requests: t.requests,
    })
  }
}

app.whenReady().then(async () => {
  const rootDir = app.getAppPath()
  const userData = app.getPath('userData')

  // 迁移：开发期数据（项目内 data/）→ 用户数据目录（打包后的唯一可写位置）
  try {
    const legacy = path.join(rootDir, 'data')
    if (!fs.existsSync(path.join(userData, 'settings.json')) && fs.existsSync(path.join(legacy, 'settings.json'))) {
      fs.mkdirSync(userData, { recursive: true })
      for (const f of ['settings.json', 'prices.json', 'remote-prices.json']) {
        const src = path.join(legacy, f)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userData, f))
      }
    }
  } catch {
    /* 迁移失败不影响启动，走默认配置 */
  }

  try {
    handle = await startServer({ rootDir, dataDir: userData })
    handle.setOnChange(onSnap)
  } catch (e) {
    console.error('[TokenUse] 本地服务启动失败:', (e as Error).stack ?? (e as Error).message)
  }

  function stopFloatingDrag() {
    if (dragTimer) {
      clearInterval(dragTimer)
      dragTimer = null
    }
  }

  function stopFloatingResize() {
    if (resizeTimer) {
      clearInterval(resizeTimer)
      resizeTimer = null
    }
    resizeCtx = null
  }

  ipcMain.on('hide-floating', () => {
    stopFloatingDrag()
    stopFloatingResize()
    handle?.updateSettings({ floatingBar: false })
    applyFloating()
  })
  ipcMain.on('open-dashboard', () => {
    stopFloatingDrag()
    stopFloatingResize()
    createDashboard()
  })

  // 拖动：按下时记录光标与窗口的偏移，主进程每 16ms 读真实光标位置绝对定位——严格跟手
  let dragTimer: NodeJS.Timeout | null = null
  let dragOffset = { x: 0, y: 0 }

  ipcMain.on('floating-drag-start', () => {
    if (!floating || floating.isDestroyed()) return
    stopFloatingResize()
    const cursor = screen.getCursorScreenPoint()
    const [wx, wy] = floating.getPosition()
    dragOffset = { x: cursor.x - wx, y: cursor.y - wy }
    stopFloatingDrag()
    dragTimer = setInterval(() => {
      if (!floating || floating.isDestroyed()) return
      const c = screen.getCursorScreenPoint()
      floating.setBounds({
        x: c.x - dragOffset.x,
        y: c.y - dragOffset.y,
        width: floatingSize.w,
        height: floatingSize.h,
      })
      clampFloatingToWorkArea()
    }, 16)
  })
  ipcMain.on('floating-drag-end', stopFloatingDrag)

  // 缩放：与拖动同思路，渲染层报告抓住的边/角，主进程每 16ms 按真实光标位移重算边界。
  // 抓西/北边时锚定对侧边，保证另一侧视觉上不动。
  type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
  let resizeTimer: NodeJS.Timeout | null = null
  let resizeCtx: { edge: ResizeEdge; bounds: { x: number; y: number; width: number; height: number }; cursor: { x: number; y: number } } | null = null

  ipcMain.on('floating-resize-start', (_e, edge: ResizeEdge) => {
    if (!floating || floating.isDestroyed()) return
    stopFloatingDrag()
    stopFloatingResize()
    resizeCtx = {
      edge,
      bounds: floating.getBounds(),
      cursor: screen.getCursorScreenPoint(),
    }
    resizeTimer = setInterval(() => {
      if (!floating || floating.isDestroyed() || !resizeCtx) return
      const c = screen.getCursorScreenPoint()
      const { edge, bounds, cursor } = resizeCtx
      const dx = c.x - cursor.x
      const dy = c.y - cursor.y
      let { x, y, width, height } = bounds
      if (edge.includes('e')) width = bounds.width + dx
      if (edge.includes('s')) height = bounds.height + dy
      if (edge.includes('w')) width = bounds.width - dx
      if (edge.includes('n')) height = bounds.height - dy
      // 尺寸约束：下限防挤爆内容，上限不超出所在显示器工作区
      const wa = screen.getDisplayNearestPoint({ x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) }).workArea
      width = Math.max(FLOAT_MIN_W, Math.min(width, wa.width - 16))
      height = Math.max(FLOAT_MIN_H, Math.min(height, wa.height - 16))
      if (edge.includes('w')) x = bounds.x + bounds.width - width
      if (edge.includes('n')) y = bounds.y + bounds.height - height
      floatingSize = { w: width, h: height }
      floating.setBounds({ x, y, width, height })
      clampFloatingToWorkArea()
    }, 16)
  })
  ipcMain.on('floating-resize-end', () => {
    stopFloatingResize()
    handle?.updateSettings({ floatingW: floatingSize.w, floatingH: floatingSize.h })
  })

  const icon = nativeImage.createFromPath(path.join(rootDir, 'assets', 'icon.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('TokenUse 启动中…')
  tray.on('click', () => createDashboard())
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))

  createFloating()
  applyFloating()
  createDashboard()

  if (handle) onSnap(handle.store.snapshot())
  // 同步 settings.json 里的 autostart 到系统登录项
  if (handle) app.setLoginItemSettings({ openAtLogin: handle.settings.autostart })
})

app.on('second-instance', () => createDashboard())
app.on('window-all-closed', () => {
  /* 托盘常驻，不退出 */
})
app.on('before-quit', () => {
  quitting = true
})
app.on('quit', () => {
  void handle?.close()
})

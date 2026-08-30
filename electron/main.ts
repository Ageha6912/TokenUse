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

const fmtN = (n: number): string => {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(Math.round(n))
}

function createDashboard() {
  if (dash && !dash.isDestroyed()) {
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

function createFloating() {
  floating = new BrowserWindow({
    width: 400,
    height: 56,
    frame: false,
    transparent: true,
    resizable: false,
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
  floating.setPosition(wa.x + wa.width - 412, wa.y + wa.height - 68)
  void floating.loadFile(path.join(app.getAppPath(), 'electron', 'floating.html'))
}

function applyFloating() {
  if (!floating || floating.isDestroyed()) return
  if (handle?.settings.floatingBar) floating.showInactive()
  else floating.hide()
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
  app.setAppUserModelId('com.tokenuse.app')
  const rootDir = app.getAppPath()
  try {
    handle = await startServer({ rootDir })
    handle.setOnChange(onSnap)
  } catch (e) {
    console.error('[TokenUse] 本地服务启动失败（端口被占用？）:', (e as Error).message)
  }

  ipcMain.on('hide-floating', () => {
    handle?.updateSettings({ floatingBar: false })
    applyFloating()
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

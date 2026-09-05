import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Menu, MenuItemConstructorOptions, Tray, ipcMain, nativeImage, screen } from 'electron'
import { startServer, ServerHandle } from '../src/server/index.js'
import type { Snapshot } from '../src/core/types.js'
import { ICON_SIZE, defaultIconRect, expandedRect, clampIcon, clampExpanded, type Rect } from './floating-geometry'

let tray: Tray | null = null
let dash: BrowserWindow | null = null
let floating: BrowserWindow | null = null
let handle: ServerHandle | null = null
let quitting = false

// 测试/便携：用环境变量覆盖用户数据目录（settings.json / prices.json 所在处）。
// Windows 下 %APPDATA% 对 Chromium 的 app.getPath 不生效（走系统 API 而非环境变量），必须有显式入口。
// 注意要在单实例锁之前设置——锁按 userData 路径区分实例。
if (process.env.TOKENUSE_DATA_DIR) app.setPath('userData', path.resolve(process.env.TOKENUSE_DATA_DIR))

// 悬浮图标（收起态）左上角位置，尺寸恒为 ICON_SIZE×ICON_SIZE；展开面板由它推导
let iconPos: Rect = { x: 0, y: 0, width: ICON_SIZE, height: ICON_SIZE }
let floatingExpanded = false

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

// 悬浮窗口尺寸由收起/展开状态决定：收起=一枚图标（默认钉在桌面右上角），展开=向下的小面板
function applyFloatingBounds() {
  if (!floating || floating.isDestroyed()) return
  const wa = screen.getDisplayNearestPoint({ x: iconPos.x + ICON_SIZE / 2, y: iconPos.y + ICON_SIZE / 2 }).workArea
  if (floatingExpanded) {
    floating.setBounds(clampExpanded(expandedRect(iconPos), wa))
  } else {
    // 拖动/收起都会经过这里：顺把图标钳回工作区并记住钳后的位置
    const r = clampIcon(iconPos, wa)
    iconPos = r
    floating.setBounds(r)
  }
}

function setFloatingExpanded(v: boolean) {
  if (!floating || floating.isDestroyed()) return
  if (floatingExpanded === v) return
  floatingExpanded = v
  applyFloatingBounds()
  floating.webContents.send('expanded-changed', floatingExpanded)
}

function createFloating() {
  iconPos = defaultIconRect(screen.getPrimaryDisplay().workArea)
  floating = new BrowserWindow({
    width: ICON_SIZE,
    height: ICON_SIZE,
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
  applyFloatingBounds()
  // 展开状态下点击别处（窗口失焦）自动收起
  floating.on('blur', () => setFloatingExpanded(false))
  void floating.loadFile(path.join(app.getAppPath(), 'electron', 'floating.html'))
}

function applyFloating() {
  if (!floating || floating.isDestroyed()) return
  if (handle?.settings.floatingBar) {
    if (floating.isMinimized()) floating.restore()
    floating.showInactive()
    applyFloatingBounds()
  } else {
    setFloatingExpanded(false)
    floating.hide()
  }
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '打开仪表盘', click: () => createDashboard() },
    { type: 'separator' },
    {
      label: '显示悬浮图标',
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
      monthTokens: snap.month.tokens,
      monthCost: snap.month.cost,
      monthUnknown: snap.month.costUnknown,
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

  // 拖动：按下时记录光标与图标的偏移，主进程每 16ms 读真实光标位置绝对定位——严格跟手。
  // 仅收起态可拖动；展开态点击图标即收起（渲染层负责区分点击与拖拽）。
  let dragTimer: NodeJS.Timeout | null = null
  let dragOffset = { x: 0, y: 0 }

  function stopFloatingDrag() {
    if (dragTimer) {
      clearInterval(dragTimer)
      dragTimer = null
    }
  }

  ipcMain.on('hide-floating', () => {
    stopFloatingDrag()
    setFloatingExpanded(false)
    handle?.updateSettings({ floatingBar: false })
    applyFloating()
  })
  ipcMain.on('open-dashboard', () => {
    stopFloatingDrag()
    createDashboard()
  })
  ipcMain.on('floating-set-expanded', (_e, v: unknown) => {
    setFloatingExpanded(!!v)
  })

  ipcMain.on('floating-drag-start', () => {
    if (!floating || floating.isDestroyed() || floatingExpanded) return
    const cursor = screen.getCursorScreenPoint()
    dragOffset = { x: cursor.x - iconPos.x, y: cursor.y - iconPos.y }
    stopFloatingDrag()
    dragTimer = setInterval(() => {
      if (!floating || floating.isDestroyed()) return
      const c = screen.getCursorScreenPoint()
      iconPos = { x: c.x - dragOffset.x, y: c.y - dragOffset.y, width: ICON_SIZE, height: ICON_SIZE }
      applyFloatingBounds()
    }, 16)
  })
  ipcMain.on('floating-drag-end', stopFloatingDrag)

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

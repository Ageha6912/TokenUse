// 用 Electron 离屏渲染把 assets/icon.svg 栅格化成 assets/icon.png
// 运行：node_modules\electron\dist\electron.exe scripts/gen-icon.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join, dirname } = require('node:path')

const root = join(dirname(__dirname))
const svgPath = join(root, 'assets', 'icon.svg')
const pngPath = join(root, 'assets', 'icon.png')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  })
  await win.loadURL('file://' + svgPath)
  await new Promise(r => setTimeout(r, 400))
  const image = win.webContents.capturePage()
  const png = (await image).toPNG()
  writeFileSync(pngPath, png)
  console.log('[gen-icon] 写出', pngPath, png.length, 'bytes')
  app.quit()
})

import os from 'node:os'
import path from 'node:path'
import { startServer } from './index.js'

// 独立运行模式：只起监测服务，不开 Electron 壳。npm run server
// 数据目录与 Electron 应用保持一致（%APPDATA%/TokenUse）
const dataDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TokenUse')
  : path.join(os.homedir(), '.config', 'TokenUse')
const root = path.resolve(__dirname, '..', '..')

startServer({ rootDir: root, dataDir }).catch(err => {
  console.error('[TokenUse] 启动失败:', (err as Error).message)
  process.exit(1)
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

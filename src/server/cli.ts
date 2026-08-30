import path from 'node:path'
import { startServer } from './index.js'

// 独立运行模式：只起监测服务，不开 Electron 壳。npm run server
const root = path.resolve(__dirname, '..', '..')
startServer({ rootDir: root }).catch(err => {
  console.error('[TokenUse] 启动失败:', (err as Error).message)
  process.exit(1)
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

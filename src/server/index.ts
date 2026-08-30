import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Pricing } from '../core/pricing.js'
import { Store, loadSettings, saveSettings } from '../core/store.js'
import type { Billing, PriceMap, Settings, Snapshot } from '../core/types.js'
import { WebSocket, WebSocketServer } from 'ws'

export interface ServerHandle {
  store: Store
  readonly settings: Settings
  setOnChange(cb: (snap: Snapshot) => void): void
  updateSettings(patch: Partial<Settings>): Settings
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

export async function startServer(opts: { rootDir: string; dataDir?: string; webDir?: string }): Promise<ServerHandle> {
  const dataDir = opts.dataDir ?? path.join(opts.rootDir, 'data')
  const webDir = opts.webDir ?? path.join(opts.rootDir, 'web')
  const iconPath = path.join(opts.rootDir, 'assets', 'icon.png')

  let settings = loadSettings(dataDir)
  const pricing = new Pricing(dataDir)
  const store = new Store(settings, pricing)
  store.pollAll()
  let cached = store.snapshot()

  let onChange: ((s: Snapshot) => void) | null = null
  const clients = new Set<WebSocket>()

  function broadcast() {
    cached = store.snapshot()
    const payload = JSON.stringify(cached)
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) {
        try {
          c.send(payload)
        } catch {
          /* 忽略单个客户端发送失败 */
        }
      }
    }
    onChange?.(cached)
  }

  let timer: NodeJS.Timeout | null = null
  function rearm() {
    if (timer) clearInterval(timer)
    const sec = Math.min(600, Math.max(1, Math.round(settings.pollIntervalSec)))
    timer = setInterval(() => {
      try {
        if (store.pollAll()) broadcast()
      } catch (e) {
        console.error('[poll]', e)
      }
    }, sec * 1000)
  }
  rearm()

  const server = http.createServer((req, res) => {
    void route(req, res)
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    if (!req.url || !req.url.split('?')[0].endsWith('/ws')) {
      ws.close()
      return
    }
    clients.add(ws)
    ws.send(JSON.stringify(cached))
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  function sendFile(res: http.ServerResponse, file: string) {
    try {
      const data = fs.readFileSync(file)
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      res.end(data)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }
  }

  function json(res: http.ServerResponse, obj: unknown, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  function readJson(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > 5 * 1024 * 1024) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const p = (req.url ?? '/').split('?')[0]
    try {
      if (p === '/' || p === '/index.html') return sendFile(res, path.join(webDir, 'index.html'))
      if (p === '/app.js') return sendFile(res, path.join(webDir, 'app.js'))
      if (p === '/style.css') return sendFile(res, path.join(webDir, 'style.css'))
      if (p === '/icon.png') return sendFile(res, iconPath)
      if (p === '/api/health') return json(res, { ok: true, updatedAt: cached.updatedAt })
      if (p === '/api/state') return json(res, cached)
      if (p === '/api/settings' && req.method === 'GET') return json(res, settings)
      if (p === '/api/settings' && req.method === 'POST') {
        const body = (await readJson(req)) as Partial<Settings>
        settings = applySettings(store, dataDir, settings, body)
        rearm()
        broadcast()
        return json(res, settings)
      }
      if (p === '/api/prices' && req.method === 'GET') {
        return json(res, { overrides: pricing.overrides, remoteCount: Object.keys(pricing.remote).length })
      }
      if (p === '/api/prices' && req.method === 'POST') {
        const body = (await readJson(req)) as { prices: PriceMap }
        const clean: PriceMap = {}
        for (const [k, v] of Object.entries(body.prices ?? {})) {
          const key = k.toLowerCase().trim()
          if (!key || key.startsWith('_') || !v) continue
          if (typeof v.input !== 'number' || typeof v.output !== 'number') continue
          clean[key] = {
            input: v.input,
            output: v.output,
            ...(typeof v.cacheRead === 'number' ? { cacheRead: v.cacheRead } : {}),
            ...(typeof v.cacheWrite === 'number' ? { cacheWrite: v.cacheWrite } : {}),
            currency: v.currency === 'USD' ? 'USD' : 'CNY',
            ...(v.note ? { note: String(v.note) } : {}),
          }
        }
        pricing.saveOverrides(clean)
        broadcast()
        return json(res, { ok: true, count: Object.keys(clean).length })
      }
      if (p === '/api/prices/refresh-remote' && req.method === 'POST') {
        try {
          const n = await pricing.refreshRemote()
          broadcast()
          return json(res, { ok: true, count: n })
        } catch (e) {
          return json(res, { ok: false, error: (e as Error).message }, 502)
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (e) {
      json(res, { error: (e as Error).message }, 500)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(settings.port, '127.0.0.1', () => resolve())
  })
  server.on('error', e => console.error('[http]', e))
  console.log(`[TokenUse] 仪表盘: http://127.0.0.1:${settings.port}`)

  return {
    store,
    get settings() {
      return settings
    },
    setOnChange(cb) {
      onChange = cb
    },
    updateSettings(patch) {
      settings = applySettings(store, dataDir, settings, patch)
      rearm()
      broadcast()
      return settings
    },
    async close() {
      if (timer) clearInterval(timer)
      for (const c of clients) {
        try {
          c.close()
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>(r => server.close(() => r()))
    },
  }
}

function applySettings(store: Store, dataDir: string, cur: Settings, patch: Partial<Settings>): Settings {
  const s: Settings = { ...cur, ...patch, providers: { ...cur.providers, ...(patch.providers ?? {}) } }
  s.pollIntervalSec = Math.min(600, Math.max(1, Math.round(Number(s.pollIntervalSec) || 3)))
  s.usdCny = Math.max(0.1, Number(s.usdCny) || 7.2)
  s.port = Math.min(65535, Math.max(1024, Math.round(Number(s.port) || 8510)))
  const pb: Record<string, Billing> = {}
  for (const [k, v] of Object.entries(s.providers)) if (v === 'plan' || v === 'metered') pb[k] = v
  s.providers = pb
  s.defaultBilling = s.defaultBilling === 'plan' ? 'plan' : 'metered'
  s.floatingBar = !!s.floatingBar
  s.autostart = !!s.autostart
  store.settings = s
  saveSettings(dataDir, s)
  return s
}

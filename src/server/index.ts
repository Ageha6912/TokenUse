import fs from 'node:fs'
import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Pricing } from '../core/pricing.js'
import { Store, loadSettings, saveSettings } from '../core/store.js'
import type { Billing, LanAccess, PriceMap, Settings, Snapshot } from '../core/types.js'
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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

  // ---------- 访问控制：本机请求豁免；局域网请求须持有令牌 ----------
  function isLocal(req: { socket: { remoteAddress?: string } }): boolean {
    const a = req.socket.remoteAddress ?? ''
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }

  function authorized(req: http.IncomingMessage): boolean {
    if (isLocal(req)) return true
    if (!settings.lanAccess.enabled) return false
    const got = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? ''
    const expect = settings.lanAccess.token
    if (!expect || !got) return false
    // 常量时间比较，避免响应时间侧信道
    const ha = crypto.createHash('sha256').update(got).digest()
    const hb = crypto.createHash('sha256').update(expect).digest()
    return crypto.timingSafeEqual(ha, hb)
  }

  function lanIPv4s(): { name: string; address: string }[] {
    const out: { name: string; address: string }[] = []
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
      for (const i of infos ?? []) {
        if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address })
      }
    }
    return out.sort((a, b) => lanRank(a.address) - lanRank(b.address) || a.address.localeCompare(b.address))
  }

  // 机器上常有 VMware / VPN / TUN 等虚拟网卡。按「手机最可能连上」排序：
  // 私网非 .1（真实 Wi-Fi/以太网客户端）> 私网 .1（VMware host-only 等网关型）> 其余（VPN/TUN 网段）
  function lanRank(address: string): number {
    const o = address.split('.').map(Number)
    if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return 3
    const priv = (o[0] === 192 && o[1] === 168) || o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
    if (!priv) return 3
    return o[3] === 1 ? 2 : 0
  }

  async function lanInfo() {
    const token = settings.lanAccess.token
    return {
      enabled: settings.lanAccess.enabled,
      port: settings.port,
      token,
      urls: lanIPv4s().map(n => ({ name: n.name, url: `http://${n.address}:${settings.port}/?token=${token}` })),
    }
  }

  // ws 升级请求先过令牌校验，未授权直接断开
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws, req) => {
    clients.add(ws)
    ws.send(JSON.stringify(cached))
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url ?? '/').split('?')[0]
    if (!p.endsWith('/ws') || !authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
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
    // 静态壳文件（HTML/JS/CSS/图标）不含数据，公开访问；数据接口一律校验令牌。
    // 否则手机带 ?token= 打开首页后，子资源请求不携带令牌会被 401 拦下，页面裸奔。
    try {
      if (p === '/' || p === '/index.html') return sendFile(res, path.join(webDir, 'index.html'))
      if (p === '/app.js') return sendFile(res, path.join(webDir, 'app.js'))
      if (p === '/style.css') return sendFile(res, path.join(webDir, 'style.css'))
      if (p === '/icon.png') return sendFile(res, iconPath)
      if (p === '/manifest.webmanifest') return sendFile(res, path.join(webDir, 'manifest.webmanifest'))
      if (p === '/sw.js') return sendFile(res, path.join(webDir, 'sw.js'))
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('unauthorized')
        return
      }
      if (p === '/api/health') return json(res, { ok: true, updatedAt: cached.updatedAt })
      // 令牌等敏感信息只发给本机；局域网客户端不需要它
      if (p === '/api/lan-info') {
        if (!isLocal(req)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        return json(res, await lanInfo())
      }
      if (p === '/api/state') return json(res, cached)
      if (p === '/api/settings' && req.method === 'GET') return json(res, settings)
      if (p === '/api/settings' && req.method === 'POST') {
        const body = (await readJson(req)) as Partial<Settings>
        settings = applySettings(store, dataDir, settings, body)
        rearm()
        broadcast()
        json(res, settings)
        // 先让本次响应送达，再切换绑定（重绑会断开包括当前连接在内的所有连接）
        setTimeout(() => void ensureBinding(), 100)
        return
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

  let boundHost = ''
  const desiredHost = () => (settings.lanAccess.enabled ? '0.0.0.0' : '127.0.0.1')

  function listenOn(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onErr = (e: Error) => reject(e)
      server.once('error', onErr)
      server.listen(settings.port, host, () => {
        server.removeListener('error', onErr)
        resolve()
      })
    })
  }

  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  // 绑定地址随「局域网访问」开关即时生效；已有连接会被断开，前端自动重连。
  // 换绑必须串行，且 listen 失败（端口 TIME_WAIT 未释放等）要重试并回退原地址——
  // 否则 close 之后 listen 失败会让 HTTP 服务永久停摆，只能重启应用。
  let binding: Promise<void> = Promise.resolve()

  function ensureBinding(): Promise<void> {
    binding = binding.then(() => doEnsureBinding()).catch(() => {})
    return binding
  }

  async function doEnsureBinding() {
    const want = desiredHost()
    if (want === boundHost && server.listening) return
    const prev = boundHost
    if (server.listening) {
      // close 的完成回调要等所有连接结束；WebSocket 是长连接永远不会自己断，
      // 必须先主动杀掉全部连接，否则 close 永远挂起、服务假死
      for (const c of clients) {
        try {
          c.terminate()
        } catch {
          /* already dead */
        }
      }
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
    }
    for (let i = 0; i < 5; i++) {
      try {
        await listenOn(want)
        boundHost = want
        logUrls()
        return
      } catch (e) {
        console.error(`[http] 换绑 ${want}:${settings.port} 第 ${i + 1} 次失败:`, (e as Error).message)
        await sleep(300) // 端口释放可能有延迟，稍候重试
      }
    }
    if (prev && prev !== want) {
      try {
        await listenOn(prev)
        boundHost = prev
        console.error(`[http] 切换到 ${want}:${settings.port} 失败，已回退到 ${prev}，局域网共享未生效`)
      } catch (e) {
        console.error('[http] 回退绑定也失败，HTTP 服务已停止:', (e as Error).message)
      }
    }
  }

  async function logUrls() {
    console.log(`[TokenUse] 仪表盘: http://127.0.0.1:${settings.port}`)
    if (settings.lanAccess.enabled) {
      for (const n of lanIPv4s()) {
        console.log(`[TokenUse] 局域网: http://${n.address}:${settings.port}/?token=${settings.lanAccess.token}（${n.name}）`)
      }
    }
  }

  server.on('error', e => console.error('[http]', e))
  await listenOn(desiredHost())
  boundHost = desiredHost()
  logUrls()

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
      setTimeout(() => void ensureBinding(), 100)
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
  s.floatingW = Math.round(Math.min(2000, Math.max(140, Number(s.floatingW) || 320)))
  s.floatingH = Math.round(Math.min(200, Math.max(20, Number(s.floatingH) || 36)))
  s.autostart = !!s.autostart
  const la = (s.lanAccess ?? {}) as Partial<LanAccess>
  s.lanAccess = { enabled: !!la.enabled, token: typeof la.token === 'string' ? la.token : '' }
  if (!s.lanAccess.token) s.lanAccess.token = crypto.randomBytes(16).toString('hex')
  store.settings = s
  saveSettings(dataDir, s)
  return s
}

// TokenUse PWA 应用壳：只缓存静态壳文件，数据（/api、/ws）永远走网络
const CACHE = 'tokenuse-shell-v5'
const SHELL = ['/', '/style.css', '/app.js', '/icon.png', '/manifest.webmanifest']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches
      .keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/api') || url.pathname === '/ws') return
  if (e.request.method !== 'GET') return
  e.respondWith(
    caches
      // 首页带着 ?token=… 打开，命中缓存时忽略查询串
      .match(e.request, { ignoreSearch: url.pathname === '/' })
      .then(hit => {
        if (hit) return hit
        return fetch(e.request)
          .then(res => {
            const copy = res.clone()
            caches.open(CACHE).then(c => c.put(e.request, copy))
            return res
          })
          .catch(() => caches.match('/'))
      }),
  )
})

// 生成应用图标 assets/icon.png（64x64：深色圆角底 + 青色仪表环），纯 zlib 手写 PNG，无依赖
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const S = 64
const px = new Uint8Array(S * S * 4)

function put(x, y, r, g, b, a = 255) {
  const i = (y * S + x) * 4
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
}

function inRoundedRect(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.max(x0 + rad, Math.min(x, x1 - rad))
  const cy = Math.max(y0 + rad, Math.min(y, y1 - rad))
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2 || (x >= x0 + rad && x <= x1 - rad) || (y >= y0 + rad && y <= y1 - rad)
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRoundedRect(x, y, 1, 1, S - 2, S - 2, 14)) continue
    put(x, y, 11, 18, 32) // 深底 #0B1220
    const dx = x - 32, dy = y - 32
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (Math.abs(dist - 17) <= 2.4) put(x, y, 34, 211, 238) // 青色环 #22D3EE
    else if (dist <= 13.5 && dy >= -1) {
      // 环内下半：仪表填充，越靠下越实
      const t = dy / 13.5
      const alpha = Math.floor(90 + 165 * t)
      put(x, y, 34, 211, 238, alpha)
    }
    if (Math.abs(dx) <= 8 && Math.abs(dy + 4) <= 1.4 && dist <= 14) put(x, y, 230, 245, 255) // 刻度线
  }
}

// PNG 编码
const crcTable = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png')
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, png)
console.log('icon written:', out)

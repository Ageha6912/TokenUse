// 主题交接不变量：暖金亮色主题（背景/配色参考 motrix-next）落地后的防回退检查
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = process.env.TOKENUSE_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

test('style.css 为暖金亮色主题：无旧暗底/冷色残留，token 齐全', () => {
  const css = read('web/style.css')
  // 历史配色不允许回流：暗夜蓝、上一版冷灰画布、teal 强调色
  for (const banned of ['#0b1220', '#111a2c', '#f4f6f8', '#0d9488']) {
    assert.ok(!css.includes(banned), `旧色 ${banned} 仍存在于 style.css`)
  }
  // 暖金主题 token（与 motrix-next 一致）
  for (const token of ['--bg: #f1ede5', '--panel: #f9f7f2', '--accent: #b07f0a', '--text: #1b1917']) {
    assert.ok(css.includes(token), `缺少设计 token：${token}`)
  }
  // 背景签名：琥珀光晕 + 26px 点阵网格 + 渐隐遮罩
  assert.ok(css.includes('radial-gradient(46% 42% at 42% 0%'), '缺少琥珀光晕背景层')
  assert.ok(css.includes('background-size: 26px 26px'), '缺少点阵网格层')
  assert.ok(css.includes('mask-image'), '点阵缺少向下渐隐遮罩')
  // 动效基建
  assert.ok(css.includes('@keyframes rise'), '缺少入场动画 rise')
  assert.ok(css.includes('prefers-reduced-motion'), '缺少减少动效适配')
  assert.ok(css.includes('tabular-nums'), '数值列需 tabular-nums')
})

test('index.html / manifest 主题色与暖金画布一致', () => {
  const html = read('web/index.html')
  const manifest = read('web/manifest.webmanifest')
  for (const f of [html, manifest]) {
    assert.ok(f.includes('#f1ede5'), '主题色应为暖金 #f1ede5')
    assert.ok(!f.includes('#0b1220') && !f.includes('#f4f6f8'), '仍残留旧主题色')
  }
})

test('sw.js 缓存版本随前端改动递增（v5）', () => {
  const sw = read('web/sw.js')
  assert.ok(sw.includes('tokenuse-shell-v5'), 'sw.js CACHE 必须 >= v5，否则用户端拿不到新样式')
  // 数据永远走网络，不允许缓存 API/WS
  assert.ok(sw.includes("startsWith('/api')"), 'sw 必须放行 /api')
})

test('app.ts 从 format.ts 导入且含数字滚动 / 滚动入场 / 四色图表体系', () => {
  const app = read('web/app.ts')
  assert.ok(app.includes("from './format'"), 'app.ts 应复用 format.ts 纯函数')
  assert.ok(app.includes('tweenNumber'), '缺少卡片数字滚动动画')
  assert.ok(app.includes('setupReveal'), '缺少滚动入场')
  assert.ok(app.includes('matchMedia'), '动效必须检查 prefers-reduced-motion')
  // 图表换色：暗色与冷色残留不允许
  for (const banned of ['#16203a', '#1e2a44', '#0d9488', '#3b82f6', '#22d3ee']) {
    assert.ok(!app.includes(banned), `app.ts 仍残留旧图表色 ${banned}`)
  }
  // 四色体系：实时活动金 / 每日趋势黛紫+玫瑰 / 项目消耗绿
  for (const c of ["'#f0b429'", "'#665298'", "'#d14e66'", "'#2f9e6e'"]) {
    assert.ok(app.includes(c), `app.ts 缺少体系色 ${c}`)
  }
})

test('卡片四色顶线与点缀色就位（防审美疲劳的多色编码）', () => {
  const css = read('web/style.css')
  assert.ok(css.includes('卡片四色顶线'), '缺少卡片四色顶线')
  for (const c of ['var(--violet)', 'var(--rose)', 'var(--green)']) {
    assert.ok(css.includes(c), `卡片顶线缺少 ${c}`)
  }
  assert.ok(css.includes('#c-today-tok') && css.includes('#c-req'), '卡片数值点缀色缺失')
})

test('图标为暖金配色：SVG 源文件存在且 PNG 已重绘', () => {
  const svg = read('assets/icon.svg')
  assert.ok(svg.includes('#f0b429'), 'icon.svg 应使用暖金主色')
  assert.ok(!svg.includes('#22d3ee'), 'icon.svg 仍残留旧青色')
  const png = readFileSync(join(root, 'assets', 'icon.png'))
  assert.ok(png.length > 1000 && png.length < 200_000, 'icon.png 尺寸异常')
})

test('format.ts 导出与 app.ts 引用对齐（编译期外的兜底检查）', () => {
  const fmt = read('web/format.ts')
  for (const fn of ['fmtTokens', 'fmtAxisTokens', 'fmtCost', 'costLabel', 'totalTok', 'totalsSub', 'shortPath', 'easeOutCubic']) {
    assert.ok(new RegExp(`export (function|const) ${fn}`).test(fmt), `format.ts 缺少导出 ${fn}`)
  }
})

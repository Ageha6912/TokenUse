// 悬浮图标几何计算的单测。先经 npm run build 产出 dist/electron/floating-geometry.js（CJS），此处默认导入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import geo from '../dist/electron/floating-geometry.js'

const { ICON_SIZE, PANEL_W, PANEL_H, SCREEN_MARGIN, DEFAULT_INSET, defaultIconRect, expandedRect, clampIcon, clampExpanded } = geo

// 1920×1080、任务栏在底部的典型工作区
const WA = { x: 0, y: 0, width: 1920, height: 1040 }
// 副屏（位于主屏右侧、任务栏在顶部）之类带原点偏移的工作区
const WA2 = { x: 1920, y: 0, width: 1080, height: 1000 }

function icon(x, y) {
  return { x, y, width: ICON_SIZE, height: ICON_SIZE }
}

test('收起态默认钉在工作区右上角，向内缩', () => {
  const r = defaultIconRect(WA)
  assert.equal(r.width, ICON_SIZE)
  assert.equal(r.height, ICON_SIZE)
  assert.equal(r.x, WA.width - ICON_SIZE - DEFAULT_INSET)
  assert.equal(r.y, DEFAULT_INSET)

  const r2 = defaultIconRect(WA2)
  assert.equal(r2.x, WA2.x + WA2.width - ICON_SIZE - DEFAULT_INSET)
  assert.equal(r2.y, WA2.y + DEFAULT_INSET)
})

test('展开框以图标右上角为锚，向左向下展开', () => {
  const ic = icon(1800, 20)
  const e = expandedRect(ic)
  assert.equal(e.x + e.width, ic.x + ICON_SIZE) // 右缘 = 图标右缘
  assert.equal(e.y, ic.y) // 顶缘 = 图标顶缘（向下展开）
  assert.equal(e.width, PANEL_W)
  assert.equal(e.height, PANEL_H)
})

test('clampIcon 把跑出屏幕的图标钳回工作区', () => {
  const right = clampIcon(icon(5000, -500), WA)
  assert.equal(right.x, WA.width - ICON_SIZE - SCREEN_MARGIN)
  assert.equal(right.y, SCREEN_MARGIN)

  const left = clampIcon(icon(-100, 9000), WA)
  assert.equal(left.x, SCREEN_MARGIN)
  assert.equal(left.y, WA.height - ICON_SIZE - SCREEN_MARGIN)

  const d2 = clampIcon(icon(0, 0), WA2) // 带原点偏移的工作区
  assert.equal(d2.x, WA2.x + SCREEN_MARGIN)
  assert.equal(d2.y, WA2.y + SCREEN_MARGIN)
})

test('clampIcon 不移动屏内的图标', () => {
  const ic = icon(100, 200)
  assert.deepEqual(clampIcon(ic, WA), ic)
})

test('clampExpanded 保证展开框完整可见：左缘被推回、底部放不下时上移', () => {
  // 图标贴左缘：展开框会伸出左边界，必须整框推回
  const atLeft = clampExpanded(expandedRect(icon(SCREEN_MARGIN, 100)), WA)
  assert.equal(atLeft.x, SCREEN_MARGIN)
  assert.equal(atLeft.x + atLeft.width, SCREEN_MARGIN + PANEL_W) // 右缘随之越过图标右缘，整框可见优先

  // 图标贴近屏幕底缘：展开框放不下，顶缘上移
  const atBottom = clampExpanded(expandedRect(icon(800, WA.height - ICON_SIZE - 2)), WA)
  assert.equal(atBottom.y + atBottom.height, WA.height - SCREEN_MARGIN)

  // 屏内正常位置：展开框原样保留
  const ok = clampExpanded(expandedRect(icon(1600, 100)), WA)
  assert.deepEqual(ok, expandedRect(icon(1600, 100)))
})

test('尺寸常量彼此一致，展开框宽于图标（确实是向下展开的小方框）', () => {
  assert.ok(PANEL_W > ICON_SIZE)
  assert.ok(PANEL_H > ICON_SIZE)
  assert.equal(typeof SCREEN_MARGIN, 'number')
})

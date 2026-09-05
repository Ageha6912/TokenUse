import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  costLabel,
  easeOutCubic,
  esc,
  fmtAxisTokens,
  fmtCost,
  fmtTime,
  fmtTokens,
  pad,
  shortPath,
  totalTok,
  totalsSub,
} from '../web/format'

test('pad 补零', () => {
  assert.equal(pad(3), '03')
  assert.equal(pad(23), '23')
})

test('esc 转义 HTML 特殊字符', () => {
  assert.equal(esc('<b class="x">&\''), '&lt;b class=&quot;x&quot;&gt;&amp;&#39;')
  assert.equal(esc('plain'), 'plain')
})

test('fmtTokens 中文单位分级', () => {
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(9999), '9,999')
  assert.equal(fmtTokens(10000), '1.0 万')
  assert.equal(fmtTokens(13204300), '1320.4 万')
  assert.equal(fmtTokens(1.5e8), '1.50 亿')
})

test('fmtAxisTokens 去尾零与空格', () => {
  assert.equal(fmtAxisTokens(10000), '1万')
  assert.equal(fmtAxisTokens(2.5e8), '2.5亿')
  assert.equal(fmtAxisTokens(500), '500')
})

test('fmtCost 空值显示破折号', () => {
  assert.equal(fmtCost(null), '—')
  assert.equal(fmtCost(undefined), '—')
  assert.equal(fmtCost(12.345), '¥12.35')
})

test('costLabel 未定价追加 +', () => {
  assert.equal(costLabel(null), '—')
  assert.equal(costLabel(1.005), '¥1.00') // 浮点 1.005 实为 1.00499…
  assert.equal(costLabel(1.25), '¥1.25')
  assert.equal(costLabel(1.0, 3), '¥1.00+')
})

test('fmtTime 当天只显示时分秒', () => {
  const d = new Date()
  assert.match(fmtTime(d.getTime()), /^\d{2}:\d{2}:\d{2}$/)
  const other = new Date(d.getTime() - 86_400_000)
  assert.match(fmtTime(other.getTime()), /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

test('shortPath 取最后一段且兼容反斜杠', () => {
  assert.equal(shortPath('E:\\TokenUse\\web\\app.ts'), 'app.ts')
  assert.equal(shortPath('/home/user/proj/src'), 'src')
  assert.equal(shortPath(''), '—')
})

test('totalTok 汇总四类 token', () => {
  assert.equal(
    totalTok({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
    10,
  )
})

test('totalsSub 组合副标题', () => {
  assert.equal(totalsSub({}), '—')
  assert.equal(totalsSub({ planCost: 1.5, meteredCost: 2, costUnknown: 1 }), '套餐内 ¥1.50 · 按量 ¥2.00 · 1 条未定价')
  assert.equal(totalsSub({ costUnknown: 2 }), '2 条未定价')
})

test('easeOutCubic 边界与单调性', () => {
  assert.equal(easeOutCubic(0), 0)
  assert.equal(easeOutCubic(1), 1)
  assert.equal(easeOutCubic(-1), 0)
  assert.equal(easeOutCubic(2), 1)
  assert.ok(easeOutCubic(0.5) > 0.5)
  assert.ok(easeOutCubic(0.8) < easeOutCubic(0.9))
})

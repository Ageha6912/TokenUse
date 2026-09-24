// 分布三板块纯函数单测：热力行裁剪 / 时段占比 / 直方→密度曲线 / 槽中心
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { binCenters, densityCurve, heatSegmentShares, trimHeatRows, type HeatRow } from '../web/distribution'

const row = (day: string, hours: number[]): HeatRow => ({ day, label: day, hours })

test('trimHeatRows 裁掉头部全零日，保留中间/尾部的空档', () => {
  const rows = [
    row('09-01', new Array(24).fill(0)),
    row('09-02', new Array(24).fill(0)),
    row('09-03', [0, 5, ...new Array(22).fill(0)]),
    row('09-04', new Array(24).fill(0)), // 中间的空日要保留（真实休息日）
    row('09-05', [1, ...new Array(23).fill(0)]),
  ]
  const trimmed = trimHeatRows(rows)
  assert.equal(trimmed.length, 3)
  assert.equal(trimmed[0].day, '09-03')
  assert.deepEqual(trimmed.map(r => r.day), ['09-03', '09-04', '09-05'])
})

test('trimHeatRows 全零输入 → 空数组；空输入 → 空数组', () => {
  assert.deepEqual(trimHeatRows([row('09-01', new Array(24).fill(0))]), [])
  assert.deepEqual(trimHeatRows([]), [])
})

test('heatSegmentShares 四段占比合计 100，且口径按小时槽归位', () => {
  const rows = [row('09-03', new Array(24).fill(100))] // 每小时等量 → 每段 25%
  const shares = heatSegmentShares(rows)
  assert.deepEqual(shares.map(s => s.pct), [25, 25, 25, 25])
  assert.deepEqual(shares.map(s => s.label), ['凌晨 0-6', '上午 6-12', '下午 12-18', '晚上 18-24'])
  // 只在 23 时有量 → 全部落进「晚上 18-24」
  const night = [row('09-03', new Array(24).fill(0))]
  night[0].hours[23] = 500
  assert.equal(heatSegmentShares(night)[3].pct, 100)
})

test('heatSegmentShares 无数据 → null 而不是 NaN', () => {
  assert.deepEqual(heatSegmentShares([row('09-03', new Array(24).fill(0))]).map(s => s.pct), [null, null, null, null])
})

test('densityCurve 峰值归一、平滑不放大、空直方安全', () => {
  // 单峰直方：峰值应为 1，且两侧单调衰减
  const bins = [0, 0, 1, 5, 20, 8, 2, 0, 0]
  const curve = densityCurve(bins)
  assert.equal(curve.length, bins.length)
  const peak = Math.max(...curve)
  assert.ok(Math.abs(peak - 1) < 1e-9, '峰值应归一为 1')
  assert.ok(curve[4] > curve[3] && curve[3] > curve[2], '峰左侧应平滑衰减')
  // 平滑不应把零区抬高成山
  assert.ok(curve[0] < 0.2 && curve[8] < 0.2)
  // 全零直方不产生 NaN
  assert.ok(densityCurve(new Array(6).fill(0)).every(v => v === 0))
  assert.deepEqual(densityCurve([]), [])
})

test('binCenters 落在每个对数槽的几何中心', () => {
  const centers = binCenters(100, 3e7, 28)
  assert.equal(centers.length, 28)
  // 第一个中心 = 10^(2 + 0.5/28*span)
  const lo = Math.log10(100)
  const span = Math.log10(3e7) - lo
  assert.ok(Math.abs(centers[0] - 10 ** (lo + (0.5 / 28) * span)) / centers[0] < 1e-12)
  assert.ok(centers[0] > 100 && centers[27] < 3e7, '中心不越过槽界')
  // 单调递增
  for (let i = 1; i < centers.length; i++) assert.ok(centers[i] > centers[i - 1])
})

// 新三板块的纯计算：热力行裁剪、时段占比、分布直方 → 平滑密度曲线
// 不依赖 DOM / ECharts，便于单测（tests/distribution.test.ts）

export interface HeatRow {
  day: string
  label: string
  hours: number[]
}

export const SEGMENTS: { label: string; from: number; to: number }[] = [
  { label: '凌晨 0-6', from: 0, to: 6 },
  { label: '上午 6-12', from: 6, to: 12 },
  { label: '下午 12-18', from: 12, to: 18 },
  { label: '晚上 18-24', from: 18, to: 24 },
]

/** 裁掉头部全零日（无任何记录的旧日期不占行）；全空 → 空数组 */
export function trimHeatRows(rows: HeatRow[]): HeatRow[] {
  let i = 0
  while (i < rows.length && rows[i].hours.every(v => v === 0)) i++
  return rows.slice(i)
}

/** 四个时段的 tokens 占比（0-100，一位小数由展示层处理）；无数据 → null */
export function heatSegmentShares(rows: HeatRow[]): { label: string; pct: number | null }[] {
  const sums = SEGMENTS.map(seg => {
    let s = 0
    for (const row of rows) for (let h = seg.from; h < seg.to; h++) s += row.hours[h]
    return s
  })
  const total = sums.reduce((a, b) => a + b, 0)
  return SEGMENTS.map((seg, i) => ({
    label: seg.label,
    pct: total > 0 ? Math.round((sums[i] / total) * 1000) / 10 : null,
  }))
}

/**
 * 直方（等宽 log10 槽）→ 峰值归一的平滑密度曲线（每槽一个值，0..1）。
 * 三次 [1,4,6,4,1]/16 核两次卷积：比一次更平缓的肩部，适合脊线观感。
 */
export function densityCurve(bins: number[]): number[] {
  const n = bins.length
  if (n === 0) return []
  const total = bins.reduce((a, b) => a + b, 0)
  if (total === 0) return bins.map(() => 0)
  const kernel = [1, 4, 6, 4, 1]
  const at = (arr: number[], i: number) => arr[Math.min(n - 1, Math.max(0, i))]
  let cur = [...bins]
  for (let pass = 0; pass < 2; pass++) {
    const next = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let k = 0; k < 5; k++) acc += at(cur, i + k - 2) * kernel[k]
      next[i] = acc / 16
    }
    cur = next
  }
  const max = cur.reduce((m, v) => Math.max(m, v), 0)
  return max > 0 ? cur.map(v => v / max) : cur.map(() => 0)
}

/** 槽中心（token 空间）：与 store 的 binLo/binHi/binCount 约定一致 */
export function binCenters(binLo: number, binHi: number, binCount: number): number[] {
  const lo = Math.log10(binLo)
  const span = Math.log10(binHi) - lo
  return Array.from({ length: binCount }, (_, i) => 10 ** (lo + ((i + 0.5) / binCount) * span))
}

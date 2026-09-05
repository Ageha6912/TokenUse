// 纯格式化 / 计算助手：不碰 DOM、不碰网络，供 app.ts 与单元测试共用

export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

export function fmtTokens(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return n.toLocaleString('zh-CN')
}

// 轴标签用：去尾零、去空格，短文本避免相邻刻度重叠
export function fmtAxisTokens(n: number): string {
  if (n >= 1e8) return +(n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return +(n / 1e4).toFixed(1) + '万'
  return n.toLocaleString('zh-CN')
}

export function fmtCost(c: number | null | undefined): string {
  return c == null ? '—' : '¥' + c.toFixed(2)
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return sameDay ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`
}

export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p || '—'
}

export interface TokenSum {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export const totalTok = (r: TokenSum) =>
  r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens

export interface TotalsLike {
  planCost?: number | null
  meteredCost?: number | null
  costUnknown?: number
}

export function totalsSub(t: TotalsLike): string {
  const parts: string[] = []
  if (t.planCost != null) parts.push(`套餐内 ¥${t.planCost.toFixed(2)}`)
  if (t.meteredCost != null) parts.push(`按量 ¥${t.meteredCost.toFixed(2)}`)
  if (t.costUnknown) parts.push(`${t.costUnknown} 条未定价`)
  return parts.join(' · ') || '—'
}

export function costLabel(c: number | null, unknown?: number): string {
  return c == null ? '—' : '¥' + c.toFixed(2) + (unknown ? '+' : '')
}

// 数字滚动动画的缓动：t∈[0,1]，先快后慢
export function easeOutCubic(t: number): number {
  const x = Math.min(Math.max(t, 0), 1)
  return 1 - Math.pow(1 - x, 3)
}

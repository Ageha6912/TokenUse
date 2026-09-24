export interface UsageRecord {
  id: string
  source: string // 'zcode' | 'codex' | 'opencode' | 'cursor' | 'mimocode' | ...
  ts: number // epoch ms，请求完成时间
  project: string // 项目目录
  sessionId: string
  model: string
  provider: string
  agent: string
  inputTokens: number // 不含缓存
  outputTokens: number // 含 reasoning
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export function totalTokens(r: Pick<UsageRecord, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens
}

export type Billing = 'metered' | 'plan'

// 手机端局域网访问：开启后服务绑定 0.0.0.0，非本机请求须带 token（回环请求永远豁免）
export interface LanAccess {
  enabled: boolean
  token: string
}

export interface Settings {
  port: number
  pollIntervalSec: number
  usdCny: number
  defaultBilling: Billing
  providers: Record<string, Billing>
  floatingBar: boolean
  autostart: boolean
  lanAccess: LanAccess
}

export const DEFAULT_SETTINGS: Settings = {
  port: 8510,
  pollIntervalSec: 3,
  usdCny: 7.2,
  defaultBilling: 'metered',
  providers: {
    'builtin:zai-start-plan': 'plan',
    'builtin:zai': 'metered',
    xiaomi: 'plan',
  },
  floatingBar: true,
  autostart: false,
  lanAccess: { enabled: false, token: '' },
}

export interface ModelPrice {
  input: number // 每 1M token
  output: number
  cacheRead?: number
  cacheWrite?: number
  currency: 'CNY' | 'USD'
  note?: string
}

export type PriceMap = Record<string, ModelPrice>

export interface Totals {
  tokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  cost: number | null // 等效成本（含套餐内）；null = 没有任何一条可计价
  meteredCost: number | null
  planCost: number | null
  costUnknown: number // 无法计价的请求数
}

export interface Bucket {
  key: string
  tokens: number
  cost: number | null
  requests: number
  costUnknown: number
}

export interface Snapshot {
  updatedAt: number
  today: Totals
  month: Totals
  all: Totals
  byModelMonth: Bucket[]
  byProjectMonth: Bucket[]
  daily: { date: string; tokens: number; cost: number | null }[]
  monthly: { month: string; label: string; tokens: number; cost: number | null }[]
  timeline: { minute: string; tokens: number }[]
  recent: WireRecord[]
  records: WireRecord[]
  projects: string[]
  models: string[]
  providers: { id: string; billing: Billing }[]
  sources: { id: string; ok: boolean; records: number; lastPollAt: number | null }[]
  // 日×小时热力图：近 14 天（day 升序，已裁掉头部全零日；hours 为 24 槽 tokens）
  hourHeatmap: { day: string; label: string; hours: number[] }[]
  // 单次请求大小分布：全量历史，按请求数 top 8 模型；bins 为对数直方（binLo..binHi 等宽 log10 槽）
  reqSize: {
    binLo: number
    binHi: number
    binCount: number
    overall: { count: number; p50: number }
    models: { model: string; count: number; p50: number; p90: number; bins: number[] }[]
  }
  // 0-24 时分布 × 模型：近 30 天，tokens 降序，末位为「其他」
  hourByModel: { model: string; hours: number[] }[]
}

export interface SourcePollResult {
  records: UsageRecord[]
  reset: boolean
}

export interface SourcePlugin {
  id: string
  ok: boolean
  lastPollAt: number | null
  poll(): SourcePollResult
}

// 快照里下发给前端的记录：附带折算后的成本（null = 无法计价）
export type WireRecord = UsageRecord & { cost: number | null }

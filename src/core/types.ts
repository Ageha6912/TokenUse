export interface UsageRecord {
  id: string
  source: string // 'zcode' | 'codex' | ...
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

export interface Settings {
  port: number
  pollIntervalSec: number
  usdCny: number
  defaultBilling: Billing
  providers: Record<string, Billing>
  floatingBar: boolean
  floatingW: number // 悬浮条宽度（自由缩放后记忆）
  floatingH: number // 悬浮条高度
  autostart: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  port: 8510,
  pollIntervalSec: 3,
  usdCny: 7.2,
  defaultBilling: 'metered',
  providers: {
    'builtin:zai-start-plan': 'plan',
    'builtin:zai': 'metered',
  },
  floatingBar: true,
  floatingW: 320,
  floatingH: 36,
  autostart: false,
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
  timeline: { minute: string; tokens: number }[]
  recent: WireRecord[]
  records: WireRecord[]
  projects: string[]
  models: string[]
  providers: { id: string; billing: Billing }[]
  sources: { id: string; ok: boolean; records: number; lastPollAt: number | null }[]
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

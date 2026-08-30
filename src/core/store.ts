import fs from 'node:fs'
import path from 'node:path'
import { Pricing } from './pricing.js'
import { CodexSource } from '../sources/codex.js'
import { ZcodeSource } from '../sources/zcode.js'
import {
  Billing,
  Bucket,
  DEFAULT_SETTINGS,
  Settings,
  Snapshot,
  SourcePlugin,
  SourcePollResult,
  Totals,
  UsageRecord,
  totalTokens,
} from './types.js'

export function loadSettings(dataDir: string): Settings {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'settings.json')
  let s: Settings = { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers } }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>
    s = { ...s, ...j, providers: { ...s.providers, ...(j.providers ?? {}) } }
  } catch {
    /* 无文件或坏 JSON → 用默认值 */
  }
  fs.writeFileSync(file, JSON.stringify(s, null, 2), 'utf8')
  return s
}

export function saveSettings(dataDir: string, s: Settings) {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(s, null, 2), 'utf8')
}

interface Acc {
  tokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  cost: number | null
  metered: number | null
  plan: number | null
  unknown: number
}

const newAcc = (): Acc => ({
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
  cost: null,
  metered: null,
  plan: null,
  unknown: 0,
})

function accAdd(a: Acc, r: UsageRecord, t: number, cost: number | null, billing: Billing) {
  a.tokens += t
  a.inputTokens += r.inputTokens
  a.outputTokens += r.outputTokens
  a.reasoningTokens += r.reasoningTokens
  a.cacheReadTokens += r.cacheReadTokens
  a.cacheWriteTokens += r.cacheWriteTokens
  a.requests++
  if (cost == null) {
    a.unknown++
  } else {
    a.cost = (a.cost ?? 0) + cost
    if (billing === 'plan') a.plan = (a.plan ?? 0) + cost
    else a.metered = (a.metered ?? 0) + cost
  }
}

function toTotals(a: Acc): Totals {
  return {
    tokens: a.tokens,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    reasoningTokens: a.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens,
    requests: a.requests,
    cost: a.cost,
    meteredCost: a.metered,
    planCost: a.plan,
    costUnknown: a.unknown,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

function dateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function buckets(map: Map<string, Acc>, cap: number): Bucket[] {
  return [...map.entries()]
    .map(([key, a]) => ({ key, tokens: a.tokens, cost: a.cost, requests: a.requests, costUnknown: a.unknown }))
    .sort((x, y) => y.tokens - x.tokens)
    .slice(0, cap)
}

export class Store {
  records = new Map<string, UsageRecord>()
  sources: SourcePlugin[] = [new ZcodeSource(), new CodexSource()]
  private sorted: UsageRecord[] = []
  private sig = ''

  constructor(public settings: Settings, public pricing: Pricing) {}

  pollAll(): boolean {
    let changed = false
    for (const src of this.sources) {
      let res: SourcePollResult
      try {
        res = src.poll()
      } catch {
        src.ok = false
        continue
      }
      if (res.reset) {
        for (const [id, r] of this.records) if (r.source === src.id) this.records.delete(id)
        changed = true
      }
      for (const r of res.records) {
        if (!this.records.has(r.id)) changed = true
        this.records.set(r.id, r)
      }
    }
    if (changed || this.sorted.length !== this.records.size) {
      this.sorted = [...this.records.values()].sort((a, b) => a.ts - b.ts)
      const last = this.sorted[this.sorted.length - 1]
      this.sig = `${this.records.size}:${last ? last.ts : 0}`
      return true
    }
    return false
  }

  billingOf(provider: string): Billing {
    return this.settings.providers[provider] ?? this.settings.defaultBilling
  }

  private wire(r: UsageRecord) {
    return { ...r, cost: this.pricing.costOf(r, this.settings.usdCny) }
  }

  snapshot(): Snapshot {
    const now = Date.now()
    const d = new Date(now)
    const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()

    const today = newAcc()
    const month = newAcc()
    const all = newAcc()
    const dailyAgg = new Map<string, { tokens: number; cost: number; unknown: number }>()
    const modelAgg = new Map<string, Acc>()
    const projAgg = new Map<string, Acc>()
    const minuteMs = 60_000
    const curMin = Math.floor(now / minuteMs)
    const tlAgg = new Map<number, number>()
    const projects = new Set<string>()
    const models = new Set<string>()
    const providers = new Set<string>()

    for (const r of this.sorted) {
      const t = totalTokens(r)
      const cost = this.pricing.costOf(r, this.settings.usdCny)
      const billing = this.billingOf(r.provider)
      accAdd(all, r, t, cost, billing)
      projects.add(r.project)
      models.add(r.model)
      providers.add(r.provider)
      if (r.ts >= todayStart) accAdd(today, r, t, cost, billing)
      if (r.ts >= monthStart) {
        accAdd(month, r, t, cost, billing)
        const ma = modelAgg.get(r.model) ?? newAcc()
        accAdd(ma, r, t, cost, billing)
        modelAgg.set(r.model, ma)
        const pa = projAgg.get(r.project) ?? newAcc()
        accAdd(pa, r, t, cost, billing)
        projAgg.set(r.project, pa)
      }
      const dk = dateKey(r.ts)
      const da = dailyAgg.get(dk) ?? { tokens: 0, cost: 0, unknown: 0 }
      da.tokens += t
      if (cost == null) da.unknown++
      else da.cost += cost
      dailyAgg.set(dk, da)
      if (r.ts >= (curMin - 59) * minuteMs) {
        const idx = Math.floor(r.ts / minuteMs)
        tlAgg.set(idx, (tlAgg.get(idx) ?? 0) + t)
      }
    }

    const daily: { date: string; tokens: number; cost: number | null }[] = []
    for (let i = 29; i >= 0; i--) {
      const key = dateKey(todayStart - i * 86_400_000)
      const a = dailyAgg.get(key)
      daily.push({
        date: key.slice(5),
        tokens: a?.tokens ?? 0,
        cost: a && (a.cost > 0 || a.unknown === 0) ? a.cost : null,
      })
    }

    const timeline: { minute: string; tokens: number }[] = []
    for (let i = 59; i >= 0; i--) {
      const idx = curMin - i
      const dt = new Date(idx * minuteMs)
      timeline.push({ minute: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`, tokens: tlAgg.get(idx) ?? 0 })
    }

    const counts = new Map<string, number>()
    for (const r of this.records.values()) counts.set(r.source, (counts.get(r.source) ?? 0) + 1)

    return {
      updatedAt: now,
      today: toTotals(today),
      month: toTotals(month),
      all: toTotals(all),
      byModelMonth: buckets(modelAgg, 12),
      byProjectMonth: buckets(projAgg, 10),
      daily,
      timeline,
      recent: this.sorted.slice(-60).reverse().map(r => this.wire(r)),
      records: this.sorted.slice(-2000).reverse().map(r => this.wire(r)),
      projects: [...projects].sort(),
      models: [...models].sort(),
      providers: [...providers]
        .map(p => ({ id: p, billing: this.billingOf(p) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      sources: this.sources.map(s => ({
        id: s.id,
        ok: s.ok,
        records: counts.get(s.id) ?? 0,
        lastPollAt: s.lastPollAt,
      })),
    }
  }
}

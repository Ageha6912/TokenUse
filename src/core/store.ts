import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { Pricing } from './pricing.js'
import { CodexSource } from '../sources/codex.js'
import { CursorSource } from '../sources/cursor.js'
import { MimocodeSource } from '../sources/mimocode.js'
import { OpencodeSource } from '../sources/opencode.js'
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
  let s: Settings = { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers }, lanAccess: { ...DEFAULT_SETTINGS.lanAccess } }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>
    s = { ...s, ...j, providers: { ...s.providers, ...(j.providers ?? {}) }, lanAccess: { ...s.lanAccess, ...(j.lanAccess ?? {}) } }
  } catch {
    /* 无文件或坏 JSON → 用默认值 */
  }
  // 令牌缺失则预生成一个，开启局域网访问时立即可用
  if (!s.lanAccess.token) s.lanAccess.token = crypto.randomBytes(16).toString('hex')
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
  sources: SourcePlugin[] = [new ZcodeSource(), new CodexSource(), new OpencodeSource(), new CursorSource(), new MimocodeSource()]
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

    // 新板块窗口：热力图近 14 天；小时×模型近 30 天；大小分布看全量历史
    const heatStart = todayStart - 13 * 86_400_000
    const hourModelStart = todayStart - 29 * 86_400_000

    const today = newAcc()
    const month = newAcc()
    const all = newAcc()
    const dailyAgg = new Map<string, { tokens: number; cost: number; unknown: number }>()
    const monthlyAgg = new Map<string, { tokens: number; cost: number; unknown: number }>()
    const modelAgg = new Map<string, Acc>()
    const projAgg = new Map<string, Acc>()
    const minuteMs = 60_000
    const curMin = Math.floor(now / minuteMs)
    const tlAgg = new Map<number, number>()
    const projects = new Set<string>()
    const models = new Set<string>()
    const providers = new Set<string>()
    const heatAgg = new Map<string, number[]>()
    const distAgg = new Map<string, number[]>()
    const hourModelAgg = new Map<string, number[]>()

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
      const rd = new Date(r.ts)
      const dk = `${rd.getFullYear()}-${pad(rd.getMonth() + 1)}-${pad(rd.getDate())}`
      const da = dailyAgg.get(dk) ?? { tokens: 0, cost: 0, unknown: 0 }
      da.tokens += t
      if (cost == null) da.unknown++
      else da.cost += cost
      dailyAgg.set(dk, da)
      const mk = dk.slice(0, 7)
      const ma2 = monthlyAgg.get(mk) ?? { tokens: 0, cost: 0, unknown: 0 }
      ma2.tokens += t
      if (cost == null) ma2.unknown++
      else ma2.cost += cost
      monthlyAgg.set(mk, ma2)
      if (r.ts >= (curMin - 59) * minuteMs) {
        const idx = Math.floor(r.ts / minuteMs)
        tlAgg.set(idx, (tlAgg.get(idx) ?? 0) + t)
      }
      if (r.ts >= heatStart) {
        const slots = heatAgg.get(dk) ?? new Array<number>(24).fill(0)
        slots[rd.getHours()] += t
        heatAgg.set(dk, slots)
      }
      const samples = distAgg.get(r.model) ?? []
      samples.push(t)
      distAgg.set(r.model, samples)
      if (r.ts >= hourModelStart) {
        const slots = hourModelAgg.get(r.model) ?? new Array<number>(24).fill(0)
        slots[rd.getHours()] += t
        hourModelAgg.set(r.model, slots)
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

    const monthly: { month: string; label: string; tokens: number; cost: number | null }[] = []
    for (let i = 11; i >= 0; i--) {
      const md = new Date(d.getFullYear(), d.getMonth() - i, 1)
      const key = `${md.getFullYear()}-${pad(md.getMonth() + 1)}`
      const a = monthlyAgg.get(key)
      monthly.push({
        month: key,
        label: `${md.getMonth() + 1}月`,
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

    // ---------- 日×小时热力图（近 14 天，裁掉头部全零日） ----------
    const hourHeatmap: Snapshot['hourHeatmap'] = []
    for (let i = 13; i >= 0; i--) {
      const dayTs = todayStart - i * 86_400_000
      const rd = new Date(dayTs)
      const day = `${rd.getFullYear()}-${pad(rd.getMonth() + 1)}-${pad(rd.getDate())}`
      const hours = heatAgg.get(day) ?? new Array<number>(24).fill(0)
      hourHeatmap.push({ day, label: `${rd.getMonth() + 1}-${rd.getDate()}`, hours })
    }
    while (hourHeatmap.length && hourHeatmap[0].hours.every(v => v === 0)) hourHeatmap.shift()

    // ---------- 单次请求大小分布（全量；top 8 按请求数） ----------
    const BIN_COUNT = 28
    const BIN_LO = 100 // 10^2
    const BIN_HI = 3e7 // ≈10^7.48
    const span = Math.log10(BIN_HI) - Math.log10(BIN_LO)
    const binOf = (v: number) =>
      Math.min(BIN_COUNT - 1, Math.max(0, Math.floor((Math.log10(Math.max(1, v)) - Math.log10(BIN_LO)) / span * BIN_COUNT)))
    const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
    const allSamples: number[] = []
    const distModels: Snapshot['reqSize']['models'] = []
    for (const [model, samples] of distAgg) {
      for (const v of samples) allSamples.push(v)
    }
    allSamples.sort((a, b) => a - b)
    for (const [model, samples] of [...distAgg.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
      const sorted = [...samples].sort((a, b) => a - b)
      const bins = new Array<number>(BIN_COUNT).fill(0)
      for (const v of samples) bins[binOf(v)]++
      distModels.push({ model, count: samples.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), bins })
    }
    const reqSize: Snapshot['reqSize'] = {
      binLo: BIN_LO,
      binHi: BIN_HI,
      binCount: BIN_COUNT,
      overall: { count: allSamples.length, p50: allSamples.length ? percentile(allSamples, 0.5) : 0 },
      models: distModels,
    }

    // ---------- 0-24 时 × 模型（近 30 天，tokens 降序，末位「其他」） ----------
    const hourModels: { model: string; hours: number[]; total: number }[] = []
    for (const [model, hours] of hourModelAgg) {
      hourModels.push({ model, hours, total: hours.reduce((s, v) => s + v, 0) })
    }
    hourModels.sort((a, b) => b.total - a.total)
    const hourByModel: Snapshot['hourByModel'] = hourModels.slice(0, 8).map(({ model, hours }) => ({ model, hours }))
    if (hourModels.length > 8) {
      const rest = new Array<number>(24).fill(0)
      for (const { hours } of hourModels.slice(8)) for (let h = 0; h < 24; h++) rest[h] += hours[h]
      hourByModel.push({ model: '其他', hours: rest })
    }

    return {
      updatedAt: now,
      today: toTotals(today),
      month: toTotals(month),
      all: toTotals(all),
      byModelMonth: buckets(modelAgg, 12),
      byProjectMonth: buckets(projAgg, 10),
      daily,
      monthly,
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
      hourHeatmap,
      reqSize,
      hourByModel,
    }
  }
}

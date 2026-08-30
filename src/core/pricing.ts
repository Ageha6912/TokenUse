import fs from 'node:fs'
import path from 'node:path'
import type { ModelPrice, PriceMap, UsageRecord } from './types.js'

// 初始快照价（每 1M token）。仅为让金额列开箱即有参考值，请在设置中按真实账单修改。
const DEFAULT_PRICES: PriceMap = {
  'glm-5.3-flash': { input: 0.8, output: 2, cacheRead: 0.16, currency: 'CNY', note: '初始快照价，请按账单核对' },
  'glm-5-turbo': { input: 2, output: 8, cacheRead: 0.4, currency: 'CNY', note: '初始快照价，请按账单核对' },
  'deepseek-v4-flash': { input: 1, output: 4, cacheRead: 0.2, currency: 'CNY', note: '初始快照价，请按账单核对' },
  'deepseek-v4-pro': { input: 2, output: 8, cacheRead: 0.4, currency: 'CNY', note: '初始快照价，请按账单核对' },
  'gpt-5.6-luna': { input: 1.25, output: 10, cacheRead: 0.125, currency: 'USD', note: '初始快照价，请按账单核对' },
}

const PRICES_NOTE =
  '每 1M token 的价格。cacheRead/cacheWrite 可省略（缺省时缓存按输入价折算）。currency: CNY 或 USD。可手动编辑，或在设置里从 LiteLLM 价格库更新。'

export class Pricing {
  overrides: PriceMap = {}
  remote: PriceMap = {}
  private memo = new Map<string, ModelPrice | null>()

  constructor(private dataDir: string) {
    this.load()
  }

  private reload() {
    this.memo.clear()
    const file = path.join(this.dataDir, 'prices.json')
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as PriceMap & { _note?: string }
      delete j._note
      this.overrides = j
    } catch {
      this.overrides = {}
    }
    try {
      this.remote = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'remote-prices.json'), 'utf8')) as PriceMap
    } catch {
      this.remote = {}
    }
  }

  private load() {
    const file = path.join(this.dataDir, 'prices.json')
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ _note: PRICES_NOTE, ...DEFAULT_PRICES }, null, 2), 'utf8')
    }
    this.reload()
  }

  lookup(model: string): ModelPrice | null {
    const key = model.toLowerCase().trim()
    if (this.memo.has(key)) return this.memo.get(key) ?? null
    let hit: ModelPrice | null = null
    for (const src of [this.overrides, this.remote]) {
      const p = src[key]
      if (p && typeof p.input === 'number' && typeof p.output === 'number') {
        hit = p
        break
      }
    }
    this.memo.set(key, hit)
    return hit
  }

  // 折算为 CNY；无法计价返回 null
  costOf(r: UsageRecord, usdCny: number): number | null {
    const p = this.lookup(r.model)
    if (!p) return null
    let c = (r.inputTokens / 1e6) * p.input + (r.outputTokens / 1e6) * p.output
    c += (r.cacheReadTokens / 1e6) * (p.cacheRead ?? p.input)
    c += (r.cacheWriteTokens / 1e6) * (p.cacheWrite ?? p.input)
    if (p.currency === 'USD') c *= usdCny
    return c
  }

  saveOverrides(prices: PriceMap) {
    fs.writeFileSync(path.join(this.dataDir, 'prices.json'), JSON.stringify({ _note: PRICES_NOTE, ...prices }, null, 2), 'utf8')
    this.reload()
  }

  // 从 LiteLLM 价格库拉取（USD/token → USD/1M token）
  async refreshRemote(): Promise<number> {
    const res = await fetch('https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json', {
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as Record<string, Record<string, unknown>>
    const out: PriceMap = {}
    for (const [k, v] of Object.entries(j)) {
      if (k.startsWith('_') || typeof v !== 'object' || v === null) continue
      const inp = Number(v.input_cost_per_token)
      const outp = Number(v.output_cost_per_token)
      if (!Number.isFinite(inp) || !Number.isFinite(outp)) continue
      const cr = Number(v.cache_read_input_token_cost)
      const cw = Number(v.cache_creation_input_token_cost)
      const p: ModelPrice = { input: inp * 1e6, output: outp * 1e6, currency: 'USD', note: 'litellm' }
      if (Number.isFinite(cr)) p.cacheRead = cr * 1e6
      if (Number.isFinite(cw)) p.cacheWrite = cw * 1e6
      out[k.toLowerCase()] = p
    }
    fs.writeFileSync(path.join(this.dataDir, 'remote-prices.json'), JSON.stringify(out), 'utf8')
    this.reload()
    return Object.keys(out).length
  }
}

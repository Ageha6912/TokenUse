import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SourcePlugin, SourcePollResult, UsageRecord } from '../core/types.js'

const ID_PREFIX = 'mimocode:'

function defaultDbPath(): string {
  // 测试允许用环境变量指向临时库
  const override = process.env.MIMOCODE_DB_PATH
  if (override) return override
  const home = process.env.MIMOCODE_HOME
  if (home) return path.join(home, 'mimocode.db')
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'mimocode', 'mimocode.db')
}

// MiMo / MiMoCode 数据源：只读挂载本地引擎库（Windows 默认 %USERPROFILE%\.local\share\mimocode\mimocode.db）。
// MiMoCode 是 OpenCode 分叉，message/session 表结构与 tokens 字段口径一致；
// MiMo Desktop 同样写这份库（AppData 下的 mimocode 目录多为链接/运行时配置）。
// 增量策略与 OpencodeSource 同构：rowid 游标 + 流式占位 pending 回查。
export class MimocodeSource implements SourcePlugin {
  readonly id = 'mimocode'
  ok = false
  lastPollAt: number | null = null

  private dbPath = defaultDbPath()
  private db: DatabaseSync | null = null
  private lastStamp = ''
  private lastRowId = 0
  private pending = new Set<string>()
  private pageLimit = 20000
  private failedLogged = false

  /** 测试用：覆盖默认库路径 */
  setDbPathForTest(p: string) {
    this.dbPath = p
    this.close()
    this.lastStamp = ''
    this.lastRowId = 0
    this.pending.clear()
  }

  /** 测试用：缩小单页拉取上限，验证分页续拉 */
  setPageLimitForTest(n: number) {
    this.pageLimit = n
  }

  private stamp(): string | null {
    try {
      const st = fs.statSync(this.dbPath)
      let walM = 0
      let walS = 0
      try {
        const wst = fs.statSync(this.dbPath + '-wal')
        walM = wst.mtimeMs
        walS = wst.size
      } catch {
        /* 无 WAL 文件（引擎未运行或已 checkpoint） */
      }
      return `${Math.round(st.mtimeMs)}:${st.size}:${Math.round(walM)}:${walS}`
    } catch {
      return null
    }
  }

  /** 测试/外部清理：释放只读句柄（Windows 下不释放无法删除库文件） */
  close() {
    try {
      this.db?.close()
    } catch {
      /* ignore */
    }
    this.db = null
  }

  poll(): SourcePollResult {
    // 每次 poll 都重新解析默认路径，支持 XDG / MIMOCODE_HOME / MIMOCODE_DB_PATH 在运行时被改写
    this.dbPath = defaultDbPath()
    this.lastPollAt = Date.now()
    const s = this.stamp()
    if (s === null) {
      this.ok = false
      this.close()
      return { records: [], reset: false }
    }
    if (s === this.lastStamp) return { records: [], reset: false }

    try {
      if (!this.db) this.db = new DatabaseSync(this.dbPath, { readOnly: true })

      const maxRow = (this.db.prepare('SELECT max(rowid) AS m FROM message').all() as { m: number }[])[0]?.m ?? 0
      let reset = false
      if (maxRow < this.lastRowId) {
        this.lastRowId = 0
        this.pending.clear()
        reset = true
      }
      if (this.lastRowId === 0) reset = true

      const select =
        'SELECT m.rowid AS rid, m.id AS mid, m.session_id AS sid, m.data AS mdata, s.directory AS sdir FROM message m LEFT JOIN session s ON s.id = m.session_id'
      const out: UsageRecord[] = []
      const newRows = this.db
        .prepare(`${select} WHERE m.rowid > ? ORDER BY m.rowid LIMIT ?`)
        .all(this.lastRowId, this.pageLimit) as Row[]
      this.collect(newRows, out)
      this.recheckPending(select, out)

      this.ok = true
      this.failedLogged = false
      // 一页拉满说明游标后面还有存货：不记指纹，下轮即便文件无变化也继续翻页
      if (newRows.length < this.pageLimit) this.lastStamp = s
      return { records: out, reset }
    } catch (err) {
      if (!this.failedLogged) {
        console.error('[mimocode] 读取失败，下轮重试:', (err as Error).message)
        this.failedLogged = true
      }
      this.ok = false
      this.close()
      return { records: [], reset: false }
    }
  }

  private recheckPending(select: string, out: UsageRecord[]) {
    const ids = [...this.pending]
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const back = this.db!
        .prepare(`${select} WHERE m.id IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk) as Row[]
      this.collect(back, out)
      const seen = new Set(back.map(r => String(r.mid ?? '')))
      for (const id of chunk) if (!seen.has(id)) this.pending.delete(id)
    }
  }

  private collect(rows: Row[], out: UsageRecord[]) {
    for (const row of rows) {
      const rid = Number(row.rid ?? 0)
      if (rid > this.lastRowId) this.lastRowId = rid
      const r = parseRow(row)
      if (r === null) continue
      if (r === 'pending') {
        this.pending.add(String(row.mid ?? ''))
        continue
      }
      out.push(r)
      this.pending.delete(r.id.slice(ID_PREFIX.length))
    }
  }
}

interface Row {
  rid?: unknown
  mid?: unknown
  sid?: unknown
  mdata?: unknown
  sdir?: unknown
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// null = 跳过（user / 坏 JSON / 零 token）；'pending' = assistant 流式占位，等原行更新为完成态后补采
export function parseRow(row: Row): UsageRecord | 'pending' | null {
  let d: Record<string, any>
  try {
    d = JSON.parse(String(row.mdata ?? '{}'))
  } catch {
    return null
  }
  if (d.role !== 'assistant') return null
  const completed = d.time?.completed ?? null
  if (completed == null) return 'pending'
  const t = d.tokens ?? {}
  const cache = t.cache ?? {}
  const inputTokens = num(t.input)
  const outputTokens = num(t.output)
  const reasoningTokens = num(t.reasoning)
  const cacheReadTokens = num(cache.read)
  const cacheWriteTokens = num(cache.write)
  const total = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  if (total <= 0) return null
  const cwd = d.path?.cwd != null ? String(d.path.cwd) : ''
  return {
    id: ID_PREFIX + String(row.mid ?? ''),
    source: 'mimocode',
    ts: Number(completed ?? d.time?.created ?? Date.now()),
    project: String(row.sdir ?? cwd ?? '') || '(未知项目)',
    sessionId: String(row.sid ?? ''),
    model: String(d.modelID ?? 'unknown'),
    provider: String(d.providerID ?? ''),
    agent: String(d.agent ?? d.mode ?? ''),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

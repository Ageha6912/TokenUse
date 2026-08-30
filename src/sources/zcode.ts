import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SourcePlugin, SourcePollResult, UsageRecord } from '../core/types.js'

// ZCode 数据源：只读挂载 ~/.zcode/cli/db/db.sqlite 的 model_usage / session 表。
// 注意：写入先进 WAL，主库 mtime 不一定变，所以监听 db 与 db-wal 两者。
export class ZcodeSource implements SourcePlugin {
  readonly id = 'zcode'
  ok = false
  lastPollAt: number | null = null

  private dbPath = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  private db: DatabaseSync | null = null
  private lastRowId = 0
  private lastStamp = ''
  private sessions = new Map<string, string>()
  private failedLogged = false

  private stamp(): string | null {
    try {
      const st = fs.statSync(this.dbPath)
      let walM = 0
      try {
        walM = fs.statSync(this.dbPath + '-wal').mtimeMs
      } catch {
        /* 无 WAL 文件 */
      }
      return `${Math.round(st.mtimeMs)}:${st.size}:${Math.round(walM)}`
    } catch {
      return null
    }
  }

  private close() {
    try {
      this.db?.close()
    } catch {
      /* ignore */
    }
    this.db = null
  }

  poll(): SourcePollResult {
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

      this.sessions.clear()
      for (const row of this.db.prepare('SELECT id, directory FROM session').all() as { id: string; directory: string }[]) {
        this.sessions.set(row.id, row.directory ?? '')
      }

      const maxRow = (this.db.prepare('SELECT max(rowid) AS m FROM model_usage').all() as { m: number }[])[0]?.m ?? 0
      let reset = false
      if (maxRow < this.lastRowId) {
        // 库被重建/清理过，重新全量同步
        this.lastRowId = 0
        reset = true
      }
      if (this.lastRowId === 0) reset = true

      const rows = this.db
        .prepare('SELECT rowid AS rid, * FROM model_usage WHERE rowid > ? ORDER BY rowid LIMIT 20000')
        .all(this.lastRowId) as Record<string, unknown>[]

      const out: UsageRecord[] = []
      for (const r of rows) {
        const rec: UsageRecord = {
          id: 'zcode:' + String(r.id ?? r.rid),
          source: this.id,
          ts: Number(r.completed_at ?? r.started_at ?? Date.now()),
          project: this.sessions.get(String(r.session_id ?? '')) ?? '(未知项目)',
          sessionId: String(r.session_id ?? ''),
          model: String(r.model_id ?? '?'),
          provider: String(r.provider_id ?? ''),
          agent: String(r.agent ?? ''),
          inputTokens: Number(r.input_tokens ?? 0),
          outputTokens: Number(r.output_tokens ?? 0),
          reasoningTokens: Number(r.reasoning_tokens ?? 0),
          cacheReadTokens: Number(r.cache_read_input_tokens ?? 0),
          cacheWriteTokens: Number(r.cache_creation_input_tokens ?? 0),
        }
        const t = rec.inputTokens + rec.outputTokens + rec.cacheReadTokens + rec.cacheWriteTokens
        if (t <= 0) continue
        out.push(rec)
      }
      const lastRid = rows.length ? Number((rows[rows.length - 1] as { rid: number }).rid) : this.lastRowId
      this.lastRowId = Math.max(this.lastRowId, lastRid)
      this.ok = true
      this.failedLogged = false
      this.lastStamp = s
      return { records: out, reset }
    } catch (err) {
      if (!this.failedLogged) {
        console.error('[zcode] 读取失败，下轮重试:', (err as Error).message)
        this.failedLogged = true
      }
      this.ok = false
      this.close()
      return { records: [], reset: false }
    }
  }
}

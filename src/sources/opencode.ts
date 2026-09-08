import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SourcePlugin, SourcePollResult, UsageRecord } from '../core/types.js'

function defaultDbPath(): string {
  // 测试允许用环境变量指向临时库
  const override = process.env.OPENCODE_DB_PATH
  if (override) return override
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'opencode', 'opencode.db')
}

// OpenCode 数据源：只读挂载 ~/.local/share/opencode/opencode.db（Windows 下为 %USERPROFILE%\.local\share\opencode\opencode.db）。
// 新版 OpenCode 用 SQLite（表 message / session），不再是旧版 storage/*.json 文件。
// 每条 role=assistant 且已完成（time.completed 存在）的 message 即一次模型请求，
// 其 data.tokens = { input, output, reasoning, cache: { read, write } }，口径与 ZCode/Codex 一致。
export class OpencodeSource implements SourcePlugin {
  readonly id = 'opencode'
  ok = false
  lastPollAt: number | null = null

  private dbPath = defaultDbPath()
  private db: DatabaseSync | null = null
  private lastStamp = ''
  private failedLogged = false

  /** 测试用：覆盖默认库路径 */
  setDbPathForTest(p: string) {
    this.dbPath = p
    this.close()
    this.lastStamp = ''
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
        /* 无 WAL 文件（OpenCode 未运行或已 checkpoint） */
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
    // 每次 poll 都重新解析默认路径，支持 XDG / OPENCODE_DB_PATH 在运行时被改写（单测场景）
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
      const rows = this.db
        .prepare('SELECT m.id AS mid, m.session_id AS sid, m.data AS mdata, s.directory AS sdir FROM message m LEFT JOIN session s ON s.id = m.session_id')
        .all() as { mid: unknown; sid: unknown; mdata: unknown; sdir: unknown }[]

      const out: UsageRecord[] = []
      for (const row of rows) {
        const rec = parseRow(row)
        if (rec) out.push(rec)
      }
      this.ok = true
      this.failedLogged = false
      this.lastStamp = s
      return { records: out, reset: false }
    } catch (err) {
      if (!this.failedLogged) {
        console.error('[opencode] 读取失败，下轮重试:', (err as Error).message)
        this.failedLogged = true
      }
      this.ok = false
      this.close()
      return { records: [], reset: false }
    }
  }
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function parseRow(row: { mid: unknown; sid: unknown; mdata: unknown; sdir: unknown }): UsageRecord | null {
  let d: Record<string, any>
  try {
    d = JSON.parse(String(row.mdata ?? '{}'))
  } catch {
    return null
  }
  if (d.role !== 'assistant') return null
  // 流式占位消息（尚未完成）tokens 全 0，跳过；完成后同一 id 会再次出现并被采集
  const completed = d.time?.completed ?? null
  if (completed == null) return null
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
    id: 'opencode:' + String(row.mid ?? ''),
    source: 'opencode',
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

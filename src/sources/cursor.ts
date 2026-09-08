import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SourcePlugin, SourcePollResult, UsageRecord } from '../core/types.js'

type JsonObject = Record<string, any>

interface KvRow {
  key?: unknown
  value?: unknown
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function asJson(value: unknown): JsonObject | null {
  try {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed as JsonObject : null
  } catch {
    return null
  }
}

function timeMs(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < 1e12 ? n * 1000 : n
}

function dbPath(): string {
  return process.env.CURSOR_GLOBAL_DB_PATH ??
    path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function workspaceRoot(): string {
  return process.env.CURSOR_WORKSPACE_STORAGE ??
    path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'workspaceStorage')
}

function stamp(file: string): string | null {
  try {
    const st = fs.statSync(file)
    let wal = ''
    let shm = ''
    try {
      const w = fs.statSync(file + '-wal')
      wal = `${Math.round(w.mtimeMs)}:${w.size}`
    } catch { /* no WAL */ }
    try {
      const s = fs.statSync(file + '-shm')
      shm = `${Math.round(s.mtimeMs)}:${s.size}`
    } catch { /* no SHM */ }
    return `${Math.round(st.mtimeMs)}:${st.size}:${wal}:${shm}`
  } catch {
    return null
  }
}

function tableName(db: DatabaseSync): string | null {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cursorDiskKV', 'ItemTable')").all() as { name: string }[]
  return rows.find(r => r.name === 'cursorDiskKV')?.name ?? rows[0]?.name ?? null
}

function readRows(db: DatabaseSync, table: string): KvRow[] {
  try {
    return db.prepare(`SELECT key, value FROM "${table}"`).all() as KvRow[]
  } catch {
    return []
  }
}

function composerIdFromKey(key: string): string {
  const parts = key.split(':')
  return parts.length >= 2 ? parts[1] : ''
}

function modelOf(bubble: JsonObject, composer: JsonObject): string {
  return String(
    bubble.modelInfo?.modelName ??
    bubble.modelInfo?.model ??
    composer.modelConfig?.modelName ??
    composer.modelConfig?.model ??
    'cursor-auto',
  )
}

function projectOf(bubble: JsonObject, composer: JsonObject, projects: Map<string, string>, composerId: string): string {
  const workspaceId = typeof composer.workspaceIdentifier === 'string'
    ? composer.workspaceIdentifier
    : String(composer.workspaceIdentifier?.workspaceId ?? composer.workspaceIdentifier?.id ?? '')
  const direct = projects.get(composerId) ??
    projects.get(`workspace:${workspaceId}`) ??
    bubble.workspaceFolder ??
    bubble.cwd ??
    composer.workspaceFolder ??
    composer.cwd
  if (direct) return String(direct)
  const file = bubble.currentFileLocationData?.fsPath ??
    bubble.currentFileLocationData?.path ??
    bubble.workspaceIdentifier?.fsPath ??
    composer.workspaceIdentifier?.fsPath ??
    composer.workspaceIdentifier?.uri?.fsPath
  if (file) {
    const text = decodeFileUri(String(file))
    return path.extname(text) ? path.dirname(text) : text
  }
  return '(未知项目)'
}

function tokenRecord(
  id: string,
  ts: number,
  project: string,
  sessionId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens = 0,
): UsageRecord | null {
  if (inputTokens + outputTokens + reasoningTokens <= 0) return null
  return {
    id,
    source: 'cursor',
    ts,
    project,
    sessionId,
    model,
    provider: 'cursor',
    agent: '',
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

function workspaceProjects(): Map<string, string> {
  const out = new Map<string, string>()
  let dirs: fs.Dirent[] = []
  try {
    dirs = fs.readdirSync(workspaceRoot(), { withFileTypes: true })
  } catch {
    return out
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    let workspaceFolder = ''
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(workspaceRoot(), dir.name, 'workspace.json'), 'utf8')) as JsonObject
      workspaceFolder = decodeFileUri(String(meta.folder ?? ''))
    } catch {
      /* 无 workspace.json 时继续使用 composer 自带路径 */
    }
    if (workspaceFolder) out.set(`workspace:${dir.name}`, workspaceFolder)
    const file = path.join(workspaceRoot(), dir.name, 'state.vscdb')
    const db = stamp(file) ? (() => {
      try { return new DatabaseSync(file, { readOnly: true }) } catch { return null }
    })() : null
    if (!db) continue
    try {
      const table = tableName(db)
      if (!table) continue
      for (const row of readRows(db, table)) {
        if (String(row.key ?? '') !== 'composer.composerData' && String(row.key ?? '') !== 'composer.composerHeaders') continue
        const data = asJson(row.value)
        for (const c of data?.allComposers ?? []) {
          const id = String(c.composerId ?? '')
          const folder = String(c.folder ?? c.workspaceFolder ?? workspaceFolder)
          if (id && folder) out.set(id, decodeFileUri(folder))
        }
      }
    } finally {
      try { db.close() } catch { /* ignore */ }
    }
  }
  return out
}

function decodeFileUri(value: string): string {
  if (!value.startsWith('file://')) return value
  try {
    return decodeURIComponent(value.slice(7)).replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    return value
  }
}

export class CursorSource implements SourcePlugin {
  readonly id = 'cursor'
  ok = false
  lastPollAt: number | null = null
  private lastStamp = ''
  private db: DatabaseSync | null = null

  poll(): SourcePollResult {
    this.lastPollAt = Date.now()
    const file = dbPath()
    const current = stamp(file)
    if (!current) {
      this.ok = false
      this.close()
      return { records: [], reset: false }
    }
    if (current === this.lastStamp) return { records: [], reset: false }
    try {
      this.close()
      this.db = new DatabaseSync(file, { readOnly: true })
      const table = tableName(this.db)
      if (!table) throw new Error('Cursor database table not found')
      const rows = readRows(this.db, table)
      const composers = new Map<string, JsonObject>()
      const bubbles: { key: string; data: JsonObject }[] = []
      for (const row of rows) {
        const key = String(row.key ?? '')
        const data = asJson(row.value)
        if (!data) continue
        if (key.startsWith('composerData:')) {
          composers.set(composerIdFromKey(key), data)
        } else if (key === 'composer.composerHeaders') {
          const headers = Array.isArray(data) ? data : data.allComposers
          for (const c of headers ?? []) {
            const id = String(c.composerId ?? '')
            if (!id) continue
            const workspaceFolder = c.workspaceIdentifier?.fsPath ??
              c.workspaceIdentifier?.uri?.fsPath ??
              c.workspaceFolder ??
              c.folder
            composers.set(id, { ...(composers.get(id) ?? {}), ...c, workspaceFolder })
          }
        } else if (key.startsWith('bubbleId:')) {
          bubbles.push({ key, data })
        }
      }

      const projects = workspaceProjects()
      const out: UsageRecord[] = []
      const explicitByComposer = new Set<string>()
      for (const { key, data } of bubbles) {
        if (data.type !== 2 && data.type !== 'assistant' && data.type !== 'assistant_message') continue
        const composerId = String(data.composerId ?? composerIdFromKey(key))
        const tc = data.tokenCount ?? data.tokenUsage ?? data.usage ?? {}
        const input = num(tc.inputTokens ?? tc.input_tokens ?? tc.promptTokens)
        const output = num(tc.outputTokens ?? tc.output_tokens ?? tc.completionTokens)
        const reasoning = num(tc.reasoningTokens ?? tc.reasoning_tokens)
        const record = tokenRecord(
          `cursor:${key}`,
          timeMs(data.createdAt ?? data.timestamp ?? data.time),
          projectOf(data, composers.get(composerId) ?? {}, projects, composerId),
          composerId,
          modelOf(data, composers.get(composerId) ?? {}),
          input,
          output,
          reasoning,
        )
        if (record) {
          out.push(record)
          explicitByComposer.add(composerId)
        }
      }

      for (const [composerId, composer] of composers) {
        if (explicitByComposer.has(composerId)) continue
        const breakdown = composer.promptTokenBreakdown ?? {}
        const input = num(breakdown.totalUsedTokens ?? composer.contextTokensUsed)
        const record = tokenRecord(
          `cursor:composer:${composerId}`,
          timeMs(composer.createdAt ?? composer.lastUpdatedAt),
          projectOf(composer, composer, projects, composerId),
          composerId,
          modelOf(composer, composer),
          input,
          0,
        )
        if (record) out.push(record)
      }
      this.lastStamp = current
      this.ok = true
      return { records: out, reset: true }
    } catch {
      this.ok = false
      this.close()
      return { records: [], reset: false }
    }
  }

  close() {
    try { this.db?.close() } catch { /* ignore */ }
    this.db = null
  }
}

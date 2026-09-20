import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SourcePlugin, SourcePollResult, UsageRecord } from '../core/types.js'

// Cursor 数据源：只读解析 %APPDATA%/Cursor/User/globalStorage/state.vscdb。
// 新版 Cursor 的气泡级 tokenCount 恒为 0，本地只有 composer 级上下文计量器
// （promptTokenBreakdown.totalUsedTokens / contextTokensUsed）和消息文本。
// 因此估算口径（保守下限）：
//   每轮输入 ≈ 固定开销（计量器 − 全部对话文本）+ 此前累计对话 + 本轮用户消息
//   每轮输出 ≈ 本轮助手文本 + thinking 文本（thinking 同时记入 reasoningTokens，
//   项目口径 outputTokens 含 reasoning）
// agent 一轮内部的多次请求与缓存计费本地不可见，实际账单会高于此估算。

type JsonObject = Record<string, any>

interface KvRow {
  key?: unknown
  value?: unknown
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function asJson(raw: string): JsonObject | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as JsonObject : null
  } catch {
    return null
  }
}

// chars/4 估算；支持字符串与 { text } 形态（thinking 是对象）
function textTokens(value: unknown): number {
  if (!value) return 0
  if (typeof value === 'string') return Math.ceil(value.length / 4)
  if (typeof value === 'object') {
    const t = (value as JsonObject).text
    if (typeof t === 'string' && t) return Math.ceil(t.length / 4)
  }
  return 0
}

// 支持数字（秒/毫秒）与 ISO 字符串（气泡 createdAt 是 ISO 格式）；解析失败返回 null
function timeMs(value: unknown): number | null {
  if (typeof value === 'string' && value && !/^\d+$/.test(value)) {
    const t = Date.parse(value)
    return Number.isFinite(t) && t > 0 ? t : null
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

function normalizeModel(m: unknown): string {
  const s = m == null ? '' : String(m).trim()
  if (!s || /^(default|auto|cursor-auto)$/i.test(s)) return 'Auto'
  return s
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
    try {
      const w = fs.statSync(file + '-wal')
      wal = `${Math.round(w.mtimeMs)}:${w.size}`
    } catch { /* no WAL */ }
    // 不把 -shm 纳入指纹：SQLite 读者本身可能改变它的 mtime，造成每轮重复全库解析。
    return `${Math.round(st.mtimeMs)}:${st.size}:${wal}`
  } catch {
    return null
  }
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cursorDiskKV', 'ItemTable')").all() as { name: string }[]
  return rows.map(r => r.name)
}

function readRows(db: DatabaseSync, tables: string[]): KvRow[] {
  const out: KvRow[] = []
  const where = `
    WHERE key IN ('composer.composerHeaders', 'composer.composerData')
       OR key LIKE 'composerData:%'
       OR key LIKE 'bubbleId:%'
  `
  for (const table of tables) {
    try {
      out.push(...db.prepare(`SELECT key, value FROM "${table}"${where}`).all() as KvRow[])
    } catch {
      /* Cursor 可能正在写其中一张表；保住另一张 */
    }
  }
  return out
}

function composerIdFromKey(key: string): string {
  const parts = key.split(':')
  return parts.length >= 2 ? parts[1] : ''
}

function bubbleIdFromKey(key: string): string {
  const parts = key.split(':')
  return parts.length >= 3 ? parts.slice(2).join(':') : ''
}

function decodeFileUri(value: string): string {
  if (!value.startsWith('file://')) return value
  try {
    return decodeURIComponent(value.slice(7)).replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    return value
  }
}

// FNV-1a：内容签名，避免缓存原始 JSON 字符串占内存
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ---------- 轻量结构：解析一次后只保留统计所需字段，poll 间复用 ----------

interface LiteBubble {
  bubbleId: string
  composerId: string
  key: string
  type: number // 1 = user, 2 = assistant
  textTok: number
  thinkTok: number
  exactIn: number
  exactOut: number
  exactReason: number
  ts: number | null
  model?: string
  folderHint?: string
}

interface LiteComposer {
  id: string
  createdAt: number | null
  headers: string[]
  meter: number // 上下文计量器（最新快照）
  model?: string
  folder?: string
  workspaceId?: string
}

function bubbleType(data: JsonObject): number {
  const n = Number(data.type)
  if (Number.isFinite(n)) return n
  if (data.type === 'assistant' || data.type === 'assistant_message') return 2
  return data.type === 'user' ? 1 : 0
}

function parseBubble(key: string, data: JsonObject): LiteBubble {
  const tc = data.tokenCount ?? data.tokenUsage ?? data.usage ?? {}
  const file = data.currentFileLocationData?.fsPath ?? data.currentFileLocationData?.path
  const folderRaw = data.workspaceFolder ?? data.cwd ?? (file ? path.dirname(decodeFileUri(String(file))) : undefined)
  return {
    bubbleId: bubbleIdFromKey(key),
    composerId: String(data.composerId ?? composerIdFromKey(key)),
    key,
    type: bubbleType(data),
    textTok: textTokens(data.text),
    thinkTok: textTokens(data.thinking),
    exactIn: num(tc.inputTokens ?? tc.input_tokens ?? tc.promptTokens),
    exactOut: num(tc.outputTokens ?? tc.output_tokens ?? tc.completionTokens),
    exactReason: num(tc.reasoningTokens ?? tc.reasoning_tokens),
    ts: timeMs(data.createdAt ?? data.timestamp ?? data.time),
    model: data.modelInfo?.modelName ?? data.modelInfo?.model ?? data.model ?? undefined,
    folderHint: folderRaw ? decodeFileUri(String(folderRaw)) : undefined,
  }
}

function parseComposer(id: string, data: JsonObject): LiteComposer {
  const wsi = data.workspaceIdentifier
  const wsId = typeof wsi === 'string' ? wsi : String(wsi?.workspaceId ?? wsi?.id ?? '')
  const folderRaw = data.workspaceFolder ?? data.cwd ?? data.folder ?? wsi?.fsPath ?? wsi?.uri?.fsPath
  return {
    id,
    createdAt: timeMs(data.createdAt ?? data.lastUpdatedAt),
    headers: Array.isArray(data.fullConversationHeadersOnly)
      ? data.fullConversationHeadersOnly.map((h: JsonObject) => String(h?.bubbleId ?? h?.id ?? '')).filter(Boolean)
      : [],
    meter: num(data.promptTokenBreakdown?.totalUsedTokens ?? data.contextTokensUsed),
    model: data.modelConfig?.modelName ?? data.modelConfig?.model ?? data.model ?? undefined,
    folder: folderRaw ? decodeFileUri(String(folderRaw)) : undefined,
    workspaceId: wsId || undefined,
  }
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
  if (inputTokens + outputTokens <= 0) return null
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

function resolveProject(c: LiteComposer, bubbles: LiteBubble[], projects: Map<string, string>): string {
  const direct = projects.get(c.id) ?? (c.workspaceId ? projects.get('workspace:' + c.workspaceId) : undefined)
  if (direct) return direct
  const hint = c.folder ?? bubbles.find(b => b.folderHint)?.folderHint
  return hint || '(未知项目)'
}

// 按轮重建：用户气泡开新轮，其后的助手气泡归属该轮
function buildTurnRecords(c: LiteComposer, bubbles: LiteBubble[], project: string): UsageRecord[] {
  const byId = new Map(bubbles.map(b => [b.bubbleId, b]))
  const ordered: LiteBubble[] = []
  for (const id of c.headers) {
    const b = byId.get(id)
    if (b) {
      ordered.push(b)
      byId.delete(id)
    }
  }
  ordered.push(...[...byId.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)))

  const turns: { user: LiteBubble | null; assistants: LiteBubble[] }[] = []
  let cur: { user: LiteBubble | null; assistants: LiteBubble[] } | null = null
  const flush = () => {
    if (cur && (cur.user || cur.assistants.length)) turns.push(cur)
    cur = null
  }
  for (const b of ordered) {
    if (b.type === 1) {
      flush()
      cur = { user: b, assistants: [] }
    } else if (b.type === 2) {
      cur ??= { user: null, assistants: [] }
      cur.assistants.push(b)
    }
  }
  flush()
  if (!turns.length) return []

  const perTurn = turns.map(t => ({
    userTok: t.user?.textTok ?? 0,
    outTok: t.assistants.reduce((s, b) => s + b.textTok, 0),
    thinkTok: t.assistants.reduce((s, b) => s + b.thinkTok, 0),
  }))
  const totalText = perTurn.reduce((s, t) => s + t.userTok + t.outTok + t.thinkTok, 0)
  // 固定开销 ≈ 计量器 − 全部对话文本（system prompt / tools / skills / MCP 等）；无计量器则为 0
  const overhead = Math.max(0, c.meter - totalText)

  const out: UsageRecord[] = []
  let cumBefore = 0
  for (let i = 0; i < turns.length; i++) {
    const t = perTurn[i]
    const turn = turns[i]
    const last = turn.assistants[turn.assistants.length - 1] ?? turn.user
    const anchor = last?.ts ?? turn.user?.ts ?? c.createdAt ?? Date.now()
    // 保守口径：每轮按一次完整上下文输入计
    const input = overhead + cumBefore + t.userTok
    const output = t.outTok + t.thinkTok
    const rec = tokenRecord(
      `cursor:turn:${c.id}:${i}`,
      anchor,
      project,
      c.id,
      normalizeModel(last?.model ?? c.model),
      input,
      output,
      t.thinkTok,
    )
    if (rec) out.push(rec)
    cumBefore += t.userTok + t.outTok + t.thinkTok
  }
  return out
}

// ---------- 工作区 → 项目路径映射（带缓存） ----------

let workspaceCacheRoot = ''
let workspaceCacheStamp = ''
let workspaceCache = new Map<string, string>()

function workspaceProjects(): Map<string, string> {
  const out = new Map<string, string>()
  let dirs: fs.Dirent[] = []
  try {
    dirs = fs.readdirSync(workspaceRoot(), { withFileTypes: true })
  } catch {
    return out
  }
  const root = workspaceRoot()
  const currentStamp = dirs
    .filter(dir => dir.isDirectory())
    .map(dir => `${dir.name}:${stamp(path.join(root, dir.name, 'workspace.json')) ?? ''}:${stamp(path.join(root, dir.name, 'state.vscdb')) ?? ''}`)
    .join('|')
  if (root === workspaceCacheRoot && currentStamp === workspaceCacheStamp) return new Map(workspaceCache)
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    let workspaceFolder = ''
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, dir.name, 'workspace.json'), 'utf8')) as JsonObject
      workspaceFolder = decodeFileUri(String(meta.folder ?? ''))
    } catch {
      /* 无 workspace.json 时继续使用 composer 自带路径 */
    }
    if (workspaceFolder) out.set(`workspace:${dir.name}`, workspaceFolder)
    const file = path.join(root, dir.name, 'state.vscdb')
    const db = stamp(file) ? (() => {
      try { return new DatabaseSync(file, { readOnly: true }) } catch { return null }
    })() : null
    if (!db) continue
    try {
      const tables = tableNames(db)
      if (!tables.length) continue
      for (const row of readRows(db, tables)) {
        const k = String(row.key ?? '')
        if (k !== 'composer.composerData' && k !== 'composer.composerHeaders') continue
        const data = asJson(Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value ?? ''))
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
  workspaceCacheRoot = root
  workspaceCacheStamp = currentStamp
  workspaceCache = out
  return new Map(out)
}

// ---------- 数据源 ----------

interface CachedBubble { sig: string; lite: LiteBubble }
interface CachedComposer { sig: string; lite: LiteComposer }
interface CachedHeaders { sig: string; list: LiteComposer[] }

export class CursorSource implements SourcePlugin {
  readonly id = 'cursor'
  ok = false
  lastPollAt: number | null = null
  private lastStamp = ''
  private db: DatabaseSync | null = null
  private dbFile = ''
  private bubbleCache = new Map<string, CachedBubble>()
  private composerCache = new Map<string, CachedComposer>()
  private headerCache = new Map<string, CachedHeaders>()

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
      if (!this.db || this.dbFile !== file) {
        this.close()
        this.db = new DatabaseSync(file, { readOnly: true })
        this.dbFile = file
        this.bubbleCache.clear()
        this.composerCache.clear()
        this.headerCache.clear()
      }
      const tables = tableNames(this.db)
      if (!tables.length) throw new Error('Cursor database table not found')

      // 内容签名比对：只重新 JSON.parse 发生变化的行
      let changed = false
      const seen = new Set<string>()
      for (const row of readRows(this.db, tables)) {
        const key = String(row.key ?? '')
        const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value ?? '')
        const sig = `${raw.length}:${fnv1a(raw)}`
        seen.add(key)
        if (key.startsWith('bubbleId:')) {
          if (this.bubbleCache.get(key)?.sig === sig) continue
          const data = asJson(raw)
          if (!data) continue
          this.bubbleCache.set(key, { sig, lite: parseBubble(key, data) })
          changed = true
        } else if (key.startsWith('composerData:')) {
          if (this.composerCache.get(key)?.sig === sig) continue
          const data = asJson(raw)
          if (!data) continue
          this.composerCache.set(key, { sig, lite: parseComposer(composerIdFromKey(key), data) })
          changed = true
        } else {
          // composer.composerHeaders / composer.composerData：会话索引，含工作区归属
          if (this.headerCache.get(key)?.sig === sig) continue
          const data = asJson(raw)
          if (!data) continue
          const entries = Array.isArray(data) ? data : data.allComposers ?? []
          const list: LiteComposer[] = []
          for (const c of entries) {
            const id = String(c?.composerId ?? '')
            if (id) list.push(parseComposer(id, c))
          }
          this.headerCache.set(key, { sig, list })
          changed = true
        }
      }
      for (const k of [...this.bubbleCache.keys()]) if (!seen.has(k)) { this.bubbleCache.delete(k); changed = true }
      for (const k of [...this.composerCache.keys()]) if (!seen.has(k)) { this.composerCache.delete(k); changed = true }
      for (const k of [...this.headerCache.keys()]) if (!seen.has(k)) { this.headerCache.delete(k); changed = true }

      this.lastStamp = current
      this.ok = true
      if (!changed) return { records: [], reset: false }
      return { records: this.build(), reset: true }
    } catch {
      this.ok = false
      this.close()
      return { records: [], reset: false }
    }
  }

  private build(): UsageRecord[] {
    // composerData 为主，headers 索引补齐工作区归属等缺失字段
    const composers = new Map<string, LiteComposer>()
    for (const { lite } of this.composerCache.values()) composers.set(lite.id, { ...lite })
    for (const { list } of this.headerCache.values()) {
      for (const h of list) {
        const cur = composers.get(h.id)
        if (!cur) {
          composers.set(h.id, { ...h })
          continue
        }
        cur.folder ??= h.folder
        cur.workspaceId ??= h.workspaceId
        cur.model ??= h.model
        cur.createdAt ??= h.createdAt
        if (!cur.headers.length) cur.headers = h.headers
        if (!cur.meter) cur.meter = h.meter
      }
    }
    const byComposer = new Map<string, LiteBubble[]>()
    for (const { lite } of this.bubbleCache.values()) {
      const arr = byComposer.get(lite.composerId)
      if (arr) arr.push(lite)
      else byComposer.set(lite.composerId, [lite])
    }

    const projects = workspaceProjects()
    const out: UsageRecord[] = []
    const ids = new Set([...composers.keys(), ...byComposer.keys()])
    for (const id of ids) {
      const c = composers.get(id) ?? { id, createdAt: null, headers: [], meter: 0 }
      const bubbles = byComposer.get(id) ?? []
      const project = resolveProject(c, bubbles, projects)
      // 旧版气泡自带精确 token → 逐气泡入账；否则整会话按轮估算
      const exact = bubbles.filter(b => b.type === 2 && (b.exactIn > 0 || b.exactOut > 0 || b.exactReason > 0))
      if (exact.length) {
        for (const b of exact) {
          const output = b.exactOut || b.textTok + b.thinkTok
          const reasoning = b.exactReason || b.thinkTok
          const rec = tokenRecord(
            `cursor:${b.key}`,
            b.ts ?? c.createdAt ?? Date.now(),
            project,
            id,
            normalizeModel(b.model ?? c.model),
            b.exactIn,
            output,
            reasoning,
          )
          if (rec) out.push(rec)
        }
        continue
      }
      out.push(...buildTurnRecords(c, bubbles, project))
    }
    return out
  }

  close() {
    try { this.db?.close() } catch { /* ignore */ }
    this.db = null
    this.dbFile = ''
  }
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SourcePlugin, SourcePollResult, UsageRecord } from '../core/types.js'

interface FileState {
  offset: number // 下一次读取起点
  size: number
  mtime: number
  lineStart: number // st.buf 所在行的起始字节
  buf: string // 尾部不完整行
  model: string
  cwd: string
  provider: string
  sessionId: string
  lastTotal: Record<string, number> | null
}

// Codex 数据源：解析 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl。
// 每行一个事件；token_count 事件的 info.last_token_usage 即单次请求用量
// （input_tokens 不含 cached_input_tokens，total = input + cached + cache_write + output）。
export class CodexSource implements SourcePlugin {
  readonly id = 'codex'
  ok = false
  lastPollAt: number | null = null

  private root = path.join(os.homedir(), '.codex', 'sessions')
  private files = new Map<string, FileState>()

  poll(): SourcePollResult {
    this.lastPollAt = Date.now()
    const out: UsageRecord[] = []
    let files: string[] = []
    try {
      files = this.walk(this.root)
    } catch {
      this.ok = false
      return { records: [], reset: false }
    }
    for (const f of files) {
      let st: fs.Stats
      try {
        st = fs.statSync(f)
      } catch {
        continue
      }
      const prev = this.files.get(f)
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue
      this.parseFile(f, st, out)
    }
    this.ok = true
    return { records: out, reset: false }
  }

  private walk(dir: string): string[] {
    const acc: string[] = []
    const stack = [dir]
    while (stack.length) {
      const d = stack.pop()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) acc.push(p)
      }
    }
    return acc.sort()
  }

  private parseFile(f: string, stat: fs.Stats, out: UsageRecord[]) {
    let st = this.files.get(f)
    let from = 0
    if (st) {
      if (stat.size < st.offset) {
        // 文件被截断/替换，重头再读（id 相同会覆盖旧记录）
        st = { offset: 0, size: 0, mtime: 0, lineStart: 0, buf: '', model: '', cwd: '', provider: '', sessionId: '', lastTotal: null }
        this.files.set(f, st)
      } else {
        from = st.offset
      }
    } else {
      st = { offset: 0, size: 0, mtime: 0, lineStart: 0, buf: '', model: '', cwd: '', provider: '', sessionId: '', lastTotal: null }
      this.files.set(f, st)
    }

    const len = stat.size - from
    if (len <= 0) {
      st.size = stat.size
      st.mtime = stat.mtimeMs
      return
    }

    let text: string
    const fd = fs.openSync(f, 'r')
    try {
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, from)
      text = st.buf + buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }

    const lines = text.split('\n')
    const tail = lines.pop() ?? ''
    let pos = st.buf ? st.lineStart : from
    for (const line of lines) {
      this.parseLine(f, line, pos, st, out)
      pos += Buffer.byteLength(line, 'utf8') + 1
    }
    st.buf = tail
    st.lineStart = pos
    st.offset = stat.size
    st.size = stat.size
    st.mtime = stat.mtimeMs
  }

  private parseLine(f: string, line: string, lineStart: number, st: FileState, out: UsageRecord[]) {
    const s = line.trim()
    if (!s) return
    let ev: {
      timestamp?: string
      type?: string
      payload?: Record<string, unknown>
    }
    try {
      ev = JSON.parse(s)
    } catch {
      return
    }
    if (ev.type === 'session_meta') {
      const p = (ev.payload ?? {}) as Record<string, unknown>
      if (typeof p.cwd === 'string') st.cwd = p.cwd
      if (typeof p.model_provider === 'string') st.provider = p.model_provider
      if (typeof p.session_id === 'string') st.sessionId = p.session_id
      return
    }
    if (ev.type === 'turn_context') {
      const p = (ev.payload ?? {}) as Record<string, unknown>
      if (typeof p.cwd === 'string') st.cwd = p.cwd
      if (typeof p.model === 'string') st.model = p.model
      return
    }
    if (ev.type !== 'event_msg') return
    const payload = (ev.payload ?? {}) as Record<string, unknown>
    if (payload.type !== 'token_count') return
    const info = (payload.info ?? {}) as Record<string, unknown>

    let u = info.last_token_usage as Record<string, number> | undefined
    if (!u) {
      const tot = info.total_token_usage as Record<string, number> | undefined
      if (!tot) return
      const prev = st.lastTotal
      if (prev) {
        const d = {
          input_tokens: (tot.input_tokens ?? 0) - (prev.input_tokens ?? 0),
          cached_input_tokens: (tot.cached_input_tokens ?? 0) - (prev.cached_input_tokens ?? 0),
          cache_write_input_tokens: (tot.cache_write_input_tokens ?? 0) - (prev.cache_write_input_tokens ?? 0),
          output_tokens: (tot.output_tokens ?? 0) - (prev.output_tokens ?? 0),
          reasoning_output_tokens: (tot.reasoning_output_tokens ?? 0) - (prev.reasoning_output_tokens ?? 0),
        }
        u = d.input_tokens < 0 || d.output_tokens < 0 ? tot : d
      } else {
        u = tot
      }
      st.lastTotal = { ...tot }
    }

    const rec: UsageRecord = {
      id: `codex:${f}:${lineStart}`,
      source: this.id,
      ts: ev.timestamp ? Date.parse(ev.timestamp) : Date.now(),
      project: st.cwd || '(未知项目)',
      sessionId: st.sessionId,
      model: st.model || 'unknown',
      provider: st.provider,
      agent: '',
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      reasoningTokens: u.reasoning_output_tokens ?? 0,
      cacheReadTokens: u.cached_input_tokens ?? 0,
      cacheWriteTokens: u.cache_write_input_tokens ?? 0,
    }
    const t = rec.inputTokens + rec.outputTokens + rec.cacheReadTokens + rec.cacheWriteTokens
    if (t <= 0) return
    out.push(rec)
  }
}

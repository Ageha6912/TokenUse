import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CursorSource } from '../src/sources/cursor'

// 造一个最小的 Cursor 全局库：cursorDiskKV 装会话与气泡，ItemTable 装全局会话索引。
// 新版 Cursor 的气泡 tokenCount 恒为 {0,0}，走按轮估算路径。
const CID = 'comp-1'
const T = (s: string) => `2026-09-08T10:0${s}.000Z`

function bubbleRow(id: string, data: Record<string, unknown>) {
  return {
    key: `bubbleId:${CID}:${id}`,
    value: JSON.stringify({ tokenCount: { inputTokens: 0, outputTokens: 0 }, ...data }),
  }
}

function defaultRows() {
  return [
    {
      key: `composerData:${CID}`,
      value: JSON.stringify({
        composerId: CID,
        createdAt: Date.parse(T('0:00')),
        contextTokensUsed: 1000,
        modelConfig: { modelName: 'default' },
        fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }, { bubbleId: 'b3' }, { bubbleId: 'b4' }],
      }),
    },
    // 100 tok 用户 → 200 tok 输出 + 100 tok thinking → 50 tok 用户 → 100 tok 输出
    bubbleRow('b1', { type: 1, text: 'x'.repeat(400), createdAt: T('0:00') }),
    bubbleRow('b2', { type: 2, text: 'y'.repeat(800), thinking: { text: 'z'.repeat(400) }, createdAt: T('0:30') }),
    bubbleRow('b3', { type: 1, text: 'x'.repeat(200), createdAt: T('1:00') }),
    bubbleRow('b4', { type: 2, text: 'y'.repeat(400), createdAt: T('1:30') }),
  ]
}

function makeDb(dir: string, rows = defaultRows()): string {
  const file = path.join(dir, 'state.vscdb')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);' +
      'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);',
  )
  const ins = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
  for (const r of rows) ins.run(r.key, r.value)
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerHeaders',
    JSON.stringify({
      allComposers: [{ composerId: CID, workspaceIdentifier: { id: 'ws1', uri: { fsPath: 'E:/proj' } } }],
    }),
  )
  db.close()
  return file
}

/** 强制库文件指纹变化，避免同毫秒写入导致 mtime 相同 */
function touch(file: string, offsetSec = 10) {
  const t = new Date(Date.now() + offsetSec * 1000)
  fs.utimesSync(file, t, t)
}

function withEnv(file: string, wsDir: string, fn: () => void) {
  const prevDb = process.env.CURSOR_GLOBAL_DB_PATH
  const prevWs = process.env.CURSOR_WORKSPACE_STORAGE
  process.env.CURSOR_GLOBAL_DB_PATH = file
  process.env.CURSOR_WORKSPACE_STORAGE = wsDir
  try {
    fn()
  } finally {
    if (prevDb === undefined) delete process.env.CURSOR_GLOBAL_DB_PATH
    else process.env.CURSOR_GLOBAL_DB_PATH = prevDb
    if (prevWs === undefined) delete process.env.CURSOR_WORKSPACE_STORAGE
    else process.env.CURSOR_WORKSPACE_STORAGE = prevWs
  }
}

test('CursorSource 按轮估算：累计上下文 + 开销校准 + thinking 计入输出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenuse-cursor-'))
  try {
    const file = makeDb(dir)
    withEnv(file, path.join(dir, 'ws-empty'), () => {
      const src = new CursorSource()
      try {
        const first = src.poll()
        assert.equal(src.ok, true)
        assert.equal(first.reset, true)
        assert.equal(first.records.length, 2)
        const [t0, t1] = [...first.records].sort((a, b) => a.id.localeCompare(b.id))

        // 全部文本 550 tok，计量器 1000 → 固定开销 450
        // 轮 0：450 + 0 + 100 = 550 输入；200 文本 + 100 thinking = 300 输出
        assert.equal(t0.id, `cursor:turn:${CID}:0`)
        assert.equal(t0.inputTokens, 550)
        assert.equal(t0.outputTokens, 300)
        assert.equal(t0.reasoningTokens, 100)
        assert.equal(t0.ts, Date.parse(T('0:30'))) // 气泡 ISO createdAt，而非解析时刻
        assert.equal(t0.model, 'Auto') // default → Auto
        assert.equal(t0.project, 'E:/proj') // headers 索引里的 workspaceIdentifier

        // 轮 1：450 + 400 + 50 = 900 输入；100 输出
        assert.equal(t1.inputTokens, 900)
        assert.equal(t1.outputTokens, 100)
        assert.equal(t1.ts, Date.parse(T('1:30')))

        // 文件无变化 → 空轮不重播
        const second = src.poll()
        assert.equal(second.records.length, 0)
        assert.equal(second.reset, false)
      } finally {
        src.close()
      }
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CursorSource 内容签名增量：无实质变化不重播，有变化才重建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenuse-cursor-'))
  try {
    const file = makeDb(dir)
    withEnv(file, path.join(dir, 'ws-empty'), () => {
      const src = new CursorSource()
      try {
        assert.equal(src.poll().records.length, 2)
        // 只动文件 mtime，内容不变 → 不应重播
        touch(file, 10)
        const idle = src.poll()
        assert.equal(idle.records.length, 0)
        assert.equal(idle.reset, false)
        // 追加一轮对话 → 重建并带 reset
        const db = new DatabaseSync(file)
        db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
          `bubbleId:${CID}:b5`,
          JSON.stringify({ type: 1, text: 'q'.repeat(400), createdAt: T('2:00'), tokenCount: { inputTokens: 0, outputTokens: 0 } }),
        )
        db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
          `bubbleId:${CID}:b6`,
          JSON.stringify({ type: 2, text: 'w'.repeat(400), createdAt: T('2:30'), tokenCount: { inputTokens: 0, outputTokens: 0 } }),
        )
        db.close()
        touch(file, 20)
        const third = src.poll()
        assert.equal(third.reset, true)
        assert.equal(third.records.length, 3)
      } finally {
        src.close()
      }
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CursorSource 旧版精确 token 优先，跳过估算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenuse-cursor-'))
  try {
    const rows = defaultRows()
    // b2 带精确 token（旧版行为）
    rows[2] = bubbleRow('b2', {
      type: 2,
      text: 'y'.repeat(800),
      createdAt: T('0:30'),
      tokenCount: { inputTokens: 12345, outputTokens: 678 },
    })
    const file = makeDb(dir, rows)
    withEnv(file, path.join(dir, 'ws-empty'), () => {
      const src = new CursorSource()
      try {
        const r = src.poll()
        assert.equal(r.records.length, 1)
        assert.equal(r.records[0].id, `cursor:bubbleId:${CID}:b2`)
        assert.equal(r.records[0].inputTokens, 12345)
        assert.equal(r.records[0].outputTokens, 678)
      } finally {
        src.close()
      }
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CursorSource 库文件缺失时 ok=false 且不抛错', () => {
  withEnv(path.join(os.tmpdir(), 'tokenuse-cursor-missing-' + Date.now() + '.vscdb'), os.tmpdir(), () => {
    const src = new CursorSource()
    const r = src.poll()
    assert.equal(r.records.length, 0)
    assert.equal(src.ok, false)
  })
})

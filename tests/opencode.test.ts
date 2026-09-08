import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OpencodeSource, parseRow } from '../src/sources/opencode'
import { sourceLabel } from '../web/format'

test('sourceLabel 映射三数据源', () => {
  assert.equal(sourceLabel('zcode'), 'ZCode')
  assert.equal(sourceLabel('codex'), 'Codex')
  assert.equal(sourceLabel('opencode'), 'OpenCode')
  assert.equal(sourceLabel('other'), 'other')
})

test('parseRow 只收已完成的 assistant 消息', () => {
  const base = { mid: 'msg_1', sid: 'ses_1', sdir: 'F:/proj' }
  // user 消息跳过
  assert.equal(parseRow({ ...base, mdata: JSON.stringify({ role: 'user', time: { created: 1 } }) }), null)
  // 流式占位（无 completed）跳过
  assert.equal(
    parseRow({
      ...base,
      mdata: JSON.stringify({ role: 'assistant', time: { created: 1 }, tokens: { input: 5, output: 5, cache: {} } }),
    }),
    null,
  )
  // 零 token 跳过
  assert.equal(
    parseRow({
      ...base,
      mdata: JSON.stringify({ role: 'assistant', time: { created: 1, completed: 2 }, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } }),
    }),
    null,
  )
  // 坏 JSON 跳过
  assert.equal(parseRow({ ...base, mdata: '{oops' }), null)
})

test('parseRow 字段映射口径与 ZCode/Codex 一致', () => {
  const r = parseRow({
    mid: 'msg_abc',
    sid: 'ses_123',
    sdir: 'F:/TokenUse-Fork',
    mdata: JSON.stringify({
      role: 'assistant',
      parentID: 'msg_parent',
      mode: 'build',
      agent: 'build',
      path: { cwd: 'F:\\TokenUse-Fork', root: '/' },
      cost: 0,
      tokens: { input: 2163, output: 412, reasoning: 176, cache: { read: 67697, write: 0 } },
      modelID: 'muse-spark-1.3',
      providerID: 'opencode',
      time: { created: 1000, completed: 2000 },
      finish: 'tool-calls',
    }),
  })
  assert.ok(r)
  assert.equal(r!.id, 'opencode:msg_abc')
  assert.equal(r!.source, 'opencode')
  assert.equal(r!.ts, 2000)
  assert.equal(r!.project, 'F:/TokenUse-Fork')
  assert.equal(r!.sessionId, 'ses_123')
  assert.equal(r!.model, 'muse-spark-1.3')
  assert.equal(r!.provider, 'opencode')
  assert.equal(r!.agent, 'build')
  assert.equal(r!.inputTokens, 2163)
  assert.equal(r!.outputTokens, 412)
  assert.equal(r!.reasoningTokens, 176)
  assert.equal(r!.cacheReadTokens, 67697)
  assert.equal(r!.cacheWriteTokens, 0)
})

test('parseRow 无 session 目录时回退到 message 内 cwd，缺失则为未知项目', () => {
  const r1 = parseRow({
    mid: 'm1',
    sid: 's1',
    sdir: null,
    mdata: JSON.stringify({
      role: 'assistant',
      time: { created: 1, completed: 2 },
      tokens: { input: 1, output: 1, cache: {} },
      path: { cwd: '/tmp/x' },
    }),
  })
  assert.equal(r1!.project, '/tmp/x')
  const r2 = parseRow({
    mid: 'm2',
    sid: 's2',
    sdir: null,
    mdata: JSON.stringify({ role: 'assistant', time: { created: 1, completed: 2 }, tokens: { input: 1, output: 1 } }),
  })
  assert.equal(r2!.project, '(未知项目)')
})

function makeDb(dir: string): string {
  const file = path.join(dir, 'opencode.db')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);' +
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);',
  )
  db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('ses_1', 'F:/demo')
  const ins = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
  ins.run(
    'msg_done',
    'ses_1',
    1000,
    2000,
    JSON.stringify({ role: 'assistant', agent: 'build', modelID: 'm', providerID: 'opencode', time: { created: 1000, completed: 2000 }, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 7 } } }),
  )
  ins.run('msg_user', 'ses_1', 1000, 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }))
  ins.run(
    'msg_streaming',
    'ses_1',
    1000,
    1000,
    JSON.stringify({ role: 'assistant', time: { created: 1000 }, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } }),
  )
  db.close()
  return file
}

test('OpencodeSource 增量拉取真实 SQLite 库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenuse-opencode-'))
  try {
    const file = makeDb(dir)
    const prev = process.env.OPENCODE_DB_PATH
    process.env.OPENCODE_DB_PATH = file
    try {
      const src = new OpencodeSource()
      try {
        assert.equal(src.id, 'opencode')
        const first = src.poll()
        assert.equal(src.ok, true)
        assert.equal(first.records.length, 1)
        assert.equal(first.records[0].id, 'opencode:msg_done')
        assert.equal(first.records[0].inputTokens + first.records[0].outputTokens + first.records[0].cacheReadTokens + first.records[0].cacheWriteTokens, 137)
        // 文件无变化时第二轮为空（增量）
        const second = src.poll()
        assert.equal(second.records.length, 0)
      } finally {
        src.close()
      }
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_DB_PATH
      else process.env.OPENCODE_DB_PATH = prev
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpencodeSource 库文件缺失时 ok=false 且不抛错', () => {
  const prev = process.env.OPENCODE_DB_PATH
  process.env.OPENCODE_DB_PATH = path.join(os.tmpdir(), 'tokenuse-opencode-missing-' + Date.now() + '.db')
  try {
    const src = new OpencodeSource()
    const r = src.poll()
    assert.equal(r.records.length, 0)
    assert.equal(src.ok, false)
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_DB_PATH
    else process.env.OPENCODE_DB_PATH = prev
  }
})

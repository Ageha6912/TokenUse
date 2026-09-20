import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MimocodeSource, parseRow } from '../src/sources/mimocode'
import { sourceLabel } from '../web/format'

test('sourceLabel 映射 mimocode → MiMo', () => {
  assert.equal(sourceLabel('mimocode'), 'MiMo')
})

test('parseRow 只收已完成的 assistant 消息，流式占位返回 pending', () => {
  const base = { mid: 'msg_1', sid: 'ses_1', sdir: 'E:/demo' }
  assert.equal(parseRow({ ...base, mdata: JSON.stringify({ role: 'user', time: { created: 1 } }) }), null)
  assert.equal(
    parseRow({
      ...base,
      mdata: JSON.stringify({ role: 'assistant', time: { created: 1 }, tokens: { input: 5, output: 5, cache: {} } }),
    }),
    'pending',
  )
  assert.equal(
    parseRow({
      ...base,
      mdata: JSON.stringify({
        role: 'assistant',
        time: { created: 1, completed: 2 },
        tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      }),
    }),
    null,
  )
  assert.equal(parseRow({ ...base, mdata: '{oops' }), null)
})

test('parseRow 字段映射与 MiMo 真实库一致', () => {
  const r = parseRow({
    mid: 'msg_abc',
    sid: 'ses_123',
    sdir: 'C:\\Users\\me\\proj',
    mdata: JSON.stringify({
      role: 'assistant',
      mode: 'build',
      agent: 'build',
      path: { cwd: 'C:\\Users\\me\\proj', root: '/' },
      cost: 0,
      tokens: { total: 105060, input: 2699, output: 1049, reasoning: 0, cache: { read: 101312, write: 0 } },
      modelID: 'mimo-pro',
      providerID: 'xiaomi',
      time: { created: 1000, completed: 2000 },
      finish: 'tool-calls',
    }),
  })
  assert.ok(r && r !== 'pending')
  assert.equal(r.id, 'mimocode:msg_abc')
  assert.equal(r.source, 'mimocode')
  assert.equal(r.ts, 2000)
  assert.equal(r.project, 'C:\\Users\\me\\proj')
  assert.equal(r.sessionId, 'ses_123')
  assert.equal(r.model, 'mimo-pro')
  assert.equal(r.provider, 'xiaomi')
  assert.equal(r.agent, 'build')
  assert.equal(r.inputTokens, 2699)
  assert.equal(r.outputTokens, 1049)
  assert.equal(r.reasoningTokens, 0)
  assert.equal(r.cacheReadTokens, 101312)
  assert.equal(r.cacheWriteTokens, 0)
})

function completedMsg(id: string, output = 1): { id: string; data: object } {
  return {
    id,
    data: {
      role: 'assistant',
      agent: 'build',
      modelID: 'mimo-pro',
      providerID: 'xiaomi',
      time: { created: 1000, completed: 2000 },
      tokens: { input: 10, output, reasoning: 0, cache: { read: 100, write: 0 } },
    },
  }
}

function defaultMessages(): { id: string; data: object }[] {
  return [
    {
      id: 'msg_done',
      data: {
        role: 'assistant',
        agent: 'build',
        modelID: 'mimo-pro',
        providerID: 'xiaomi',
        time: { created: 1000, completed: 2000 },
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 100, write: 0 } },
      },
    },
    { id: 'msg_user', data: { role: 'user', time: { created: 1000 } } },
    {
      id: 'msg_streaming',
      data: { role: 'assistant', time: { created: 1000 }, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
    },
  ]
}

function makeDb(dir: string, messages = defaultMessages()): string {
  const file = path.join(dir, 'mimocode.db')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);' +
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);',
  )
  db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('ses_1', 'E:/demo')
  const ins = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
  let i = 0
  for (const m of messages) ins.run(m.id, 'ses_1', 1000 + i, 1000 + i++, JSON.stringify(m.data))
  db.close()
  return file
}

function touch(file: string) {
  const t = new Date(Date.now() + 10_000)
  fs.utimesSync(file, t, t)
}

function withEnvDb(file: string, fn: () => void) {
  const prev = process.env.MIMOCODE_DB_PATH
  process.env.MIMOCODE_DB_PATH = file
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.MIMOCODE_DB_PATH
    else process.env.MIMOCODE_DB_PATH = prev
  }
}

test('MimocodeSource 增量拉取真实 SQLite 库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenuse-mimocode-'))
  try {
    const file = makeDb(dir)
    withEnvDb(file, () => {
      const src = new MimocodeSource()
      try {
        assert.equal(src.id, 'mimocode')
        const first = src.poll()
        assert.equal(src.ok, true)
        assert.equal(first.records.length, 1)
        assert.equal(first.records[0].id, 'mimocode:msg_done')
        assert.equal(first.records[0].model, 'mimo-pro')
        assert.equal(first.records[0].provider, 'xiaomi')
        const second = src.poll()
        assert.equal(second.records.length, 0)
      } finally {
        src.close()
      }
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('流式占位完成后被补采，同批新行走游标增量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenuse-mimocode-'))
  try {
    const file = makeDb(dir)
    withEnvDb(file, () => {
      const src = new MimocodeSource()
      try {
        const first = src.poll()
        assert.equal(first.records.length, 1)
        const db = new DatabaseSync(file)
        db.prepare('UPDATE message SET data = ? WHERE id = ?').run(
          JSON.stringify({
            role: 'assistant',
            time: { created: 1000, completed: 3000 },
            tokens: { input: 7, output: 33, cache: { read: 0, write: 0 } },
          }),
          'msg_streaming',
        )
        db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
          'msg_done2',
          'ses_1',
          4000,
          4000,
          JSON.stringify(completedMsg('msg_done2', 9).data),
        )
        db.close()
        touch(file)
        const second = src.poll()
        assert.equal(second.records.length, 2)
        const ids = second.records.map(r => r.id).sort()
        assert.deepEqual(ids, ['mimocode:msg_done2', 'mimocode:msg_streaming'])
      } finally {
        src.close()
      }
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('MimocodeSource 库文件缺失时 ok=false 且不抛错', () => {
  const prev = process.env.MIMOCODE_DB_PATH
  process.env.MIMOCODE_DB_PATH = path.join(os.tmpdir(), 'tokenuse-mimocode-missing-' + Date.now() + '.db')
  try {
    const src = new MimocodeSource()
    const r = src.poll()
    assert.equal(r.records.length, 0)
    assert.equal(src.ok, false)
  } finally {
    if (prev === undefined) delete process.env.MIMOCODE_DB_PATH
    else process.env.MIMOCODE_DB_PATH = prev
  }
})

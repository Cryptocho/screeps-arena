/**
 * M3/S4 对局历史 store 打表（plan-M3 D7）：id 幂等 upsert、teardown 状态推进、
 * 崩溃残行跳过、pending 扫描（补拆解输入）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatchHistory } from '../src/server/history.js'
import type { MatchHistoryRecord } from '../src/server/history.js'

function makeRecord(id: string, teardown: MatchHistoryRecord['teardown'] = 'pending'): MatchHistoryRecord {
  return {
    id,
    config: { seats: 2, roundMs: 60_000, roundBreakTimeoutMs: 300_000, maxRounds: 8 },
    winner: { kind: 'draw' },
    settleReason: 'manual',
    scores: { a: 1, b: 0 },
    roundIndex: 3,
    createdAt: 1,
    settledAt: 2,
    seatUsers: { a: 'agent_a' },
    rooms: { a: 'E5N5' },
    teardown,
  }
}

describe('MatchHistory（M3/S4）', () => {
  it('upsert + list：新 id 追加，同 id 原位替换（GET /api/history 同局单条）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'history-'))
    try {
      const h = new MatchHistory(dir)
      h.upsert(makeRecord('m1', 'pending'))
      h.upsert(makeRecord('m2', 'pending'))
      h.upsert(makeRecord('m1', 'done')) // 幂等替换
      expect(h.list().map((r) => r.id)).toEqual(['m1', 'm2'])
      expect(h.list().find((r) => r.id === 'm1')!.teardown).toBe('done')
      // 落盘：jsonl 两行
      const lines = readFileSync(join(dir, 'matches.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!).id).toBe('m1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('markDone + pending：补拆解输入只含 pending 记录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'history-'))
    try {
      const h = new MatchHistory(dir)
      h.upsert(makeRecord('m1'))
      h.upsert(makeRecord('m2'))
      h.markDone('m1')
      expect(h.pending().map((r) => r.id)).toEqual(['m2'])
      h.markDone('m1') // 重复 markDone 无害
      expect(h.pending()).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('启动读回：崩溃残行跳过不炸（jsonl append 固有风险，整写后自愈）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'history-'))
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'matches.jsonl'), JSON.stringify(makeRecord('m1')) + '\n{"id": "bro')
      const h = new MatchHistory(dir)
      expect(h.list().map((r) => r.id)).toEqual(['m1'])
      h.upsert(makeRecord('m2', 'done'))
      const lines = readFileSync(join(dir, 'matches.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2) // 残行被整写清除
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('重启读回：teardown 状态持久（补拆解扫描跨重启生效）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'history-'))
    try {
      const h1 = new MatchHistory(dir)
      h1.upsert(makeRecord('m1', 'pending'))
      const h2 = new MatchHistory(dir) // 模拟重启
      expect(h2.pending().map((r) => r.id)).toEqual(['m1'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

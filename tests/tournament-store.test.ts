/**
 * TournamentStore 单测（plan-M4/S2）：tmp+rename 原子写、重启读回、损坏文件跳过、
 * 写透一致性（save 后同进程可见 + 落盘文件存在）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TournamentStore } from '../src/server/tournament/store.js'
import { newTournamentId } from '../src/server/tournament/types.js'
import type { Tournament } from '../src/server/tournament/types.js'

const dirs: string[] = []
function mk(): string {
  const d = mkdtempSync(join(tmpdir(), 'tstore-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function mkTournament(): Tournament {
  return {
    id: newTournamentId(),
    name: 'league-1',
    createdAt: 123,
    format: 'round-robin',
    participants: [
      { seatId: 's0', username: 'u0' },
      { seatId: 's1', username: 'u1' },
    ],
    matches: [{ pair: ['s0', 's1'], status: 'scheduled' }],
    errors: [],
  }
}

describe('TournamentStore', () => {
  it('save 落盘 + 同实例 list/get 可见', () => {
    const dir = mk()
    const store = new TournamentStore(dir)
    const t = mkTournament()
    store.save(t)
    expect(store.list()).toHaveLength(1)
    expect(store.get(t.id)?.name).toBe('league-1')
    expect(existsSync(join(dir, `${t.id}.json`))).toBe(true)
  })

  it('重启（新实例）读回全部届', () => {
    const dir = mk()
    const s1 = new TournamentStore(dir)
    const a = mkTournament()
    const b = mkTournament()
    s1.save(a)
    s1.save(b)
    const s2 = new TournamentStore(dir)
    expect(s2.list()).toHaveLength(2)
    expect(s2.get(b.id)?.matches[0]?.status).toBe('scheduled')
  })

  it('损坏文件跳过不炸启动', () => {
    const dir = mk()
    const s1 = new TournamentStore(dir)
    const t = mkTournament()
    s1.save(t)
    writeFileSync(join(dir, 'broken.json'), '{oops')
    const s2 = new TournamentStore(dir)
    expect(s2.list()).toHaveLength(1)
    expect(s2.get(t.id)?.id).toBe(t.id)
  })

  it('save 幂等更新（同 id 原位覆盖）', () => {
    const dir = mk()
    const store = new TournamentStore(dir)
    const t = mkTournament()
    store.save(t)
    t.matches[0]!.status = 'created'
    t.matches[0]!.matchId = 'm1'
    store.save(t)
    const s2 = new TournamentStore(dir)
    const stored = s2.get(t.id)
    expect(stored?.matches[0]).toEqual({ pair: ['s0', 's1'], status: 'created', matchId: 'm1' })
    expect(readFileSync(join(dir, `${t.id}.json`), 'utf8')).toContain('"matchId": "m1"')
  })

  it('空目录构造零届', () => {
    expect(new TournamentStore(mk()).list()).toHaveLength(0)
  })
})

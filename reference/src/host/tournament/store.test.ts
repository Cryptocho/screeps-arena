import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJson } from '../store-io.ts'
import type { MatchResult } from '../history/model.ts'
import {
  buildInitialSlots,
  defaultTournamentConfig,
  type TournamentParticipant,
  type TournamentState,
} from './model.ts'
import { TournamentError, TournamentStore, type TournamentReceipt } from './store.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-screeps-tstore-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function join(...p: string[]): string {
  return path.join(...p)
}

function participantsOf(seats: 4 | 8 = 4): TournamentParticipant[] {
  return Array.from({ length: seats }, (_, i) => ({
    participantId: `p${i}`,
    sessionId: `s${i}`,
    displayName: `Agent ${i + 1}`,
    seed: i,
  }))
}

/**
 * 模拟 recruit 完成 → ready + start：把 recruiting 赛事推进到 running，首轮两个 slot 均已编排
 * （attempt0 running、matchId 回填）。返回赛事 id 与当前 revision。
 */
async function buildRunning(
  store: TournamentStore,
  seats: 4 | 8 = 4,
  requestId = 'req-1',
): Promise<{ tournamentId: string; revision: number; participants: TournamentParticipant[] }> {
  const created = await store.createRecruiting(requestId, defaultTournamentConfig(seats))
  const participants = participantsOf(seats)
  let state = await store.update(created.state.id, created.state.revision, s => {
    s.phase = 'ready'
    s.participants = participants
  })
  let rev = state.revision
  const slots = buildInitialSlots(participants)
  const matchBySlot: Record<string, string> = { r1s0: 'match-1', r1s1: 'match-2', r1s2: 'match-3', r1s3: 'match-4' }
  state = await store.update(created.state.id, rev, s => {
    s.phase = 'running'
    s.currentSlotId = slots[0]!.slotId
    s.slots = slots
    for (const slot of slots) {
      slot.phase = 'running'
      slot.attempts[0]!.phase = 'running'
      slot.attempts[0]!.matchId = matchBySlot[slot.slotId] ?? `match-${slot.index + 1}`
    }
  })
  rev = state.revision
  return { tournamentId: created.state.id, revision: rev, participants }
}

function matchResult(opts: {
  matchId: string
  tournamentId: string
  winnerPid: string | null // null = draw
  pids: string[]
  attempt?: 0 | 1
  scoreOf?: Record<string, number>
}): MatchResult {
  const participantSnapshot = opts.pids.map(pid => ({ participantId: pid, displayName: pid }))
  const scores: Record<string, number> = {}
  for (const pid of opts.pids) scores[pid] = opts.scoreOf?.[pid] ?? 0
  return {
    resultId: opts.matchId,
    tournamentId: opts.tournamentId,
    attempt: opts.attempt ?? 0,
    preset: 'arena-blitz',
    phase: 'settled',
    winner: opts.winnerPid === null ? { kind: 'draw' } : { kind: 'participant', participantId: opts.winnerPid },
    scores,
    participantSnapshot,
    kills: {},
    losses: {},
    endTick: 500,
    createdAt: 1,
  }
}

describe('TournamentStore — createRecruiting & request index', () => {
  it('creates a recruiting tournament and returns it idempotently for the same requestId+config', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const first = await store.createRecruiting('req-1', defaultTournamentConfig(4))
    expect(first.created).toBe(true)
    expect(first.state.phase).toBe('recruiting')
    expect(first.state.revision).toBe(0)
    const second = await store.createRecruiting('req-1', defaultTournamentConfig(4))
    expect(second.created).toBe(false)
    expect(second.state.id).toBe(first.state.id)
    expect(second.state.revision).toBe(first.state.revision)
    expect(await store.getByRequestId('req-1')).toMatchObject({ id: first.state.id })
    expect(await store.getByRequestId('nope')).toBeNull()
  })

  it('returns the existing tournament even when it reached a terminal phase (no new id)', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const created = await store.createRecruiting('req-1', defaultTournamentConfig(4))
    await store.update(created.state.id, 0, s => {
      s.phase = 'failed'
      s.error = 'recruit timeout'
    })
    const again = await store.createRecruiting('req-1', defaultTournamentConfig(4))
    expect(again.created).toBe(false)
    expect(again.state.id).toBe(created.state.id)
    expect(again.state.phase).toBe('failed')
  })

  it('409-conflicts a same requestId with a different config hash', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    await store.createRecruiting('req-1', defaultTournamentConfig(4))
    await expect(store.createRecruiting('req-1', defaultTournamentConfig(8))).rejects.toMatchObject({
      name: 'TournamentError',
      code: 'conflict',
    })
    // model/tickDuration 差异同样冲突
    await expect(
      store.createRecruiting('req-1', { ...defaultTournamentConfig(4), model: 'stub' }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('indexes by normalized requestId (same config → same requestConfigHash)', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const a = await store.createRecruiting('ABC-123', defaultTournamentConfig(4))
    const b = await store.createRecruiting('ABC-123', defaultTournamentConfig(4))
    expect(a.state.id).toBe(b.state.id)
  })
})

describe('TournamentStore — revision CAS updates', () => {
  it('applies update only on matching revision and bumps it', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const created = await store.createRecruiting('req-1', defaultTournamentConfig(4))
    const updated = await store.update(created.state.id, 0, s => {
      s.phase = 'ready'
    })
    expect(updated.phase).toBe('ready')
    expect(updated.revision).toBe(1)
    await expect(store.update(created.state.id, 0, () => {})).rejects.toMatchObject({ code: 'badRevision' })
    await expect(store.update('missing-id', 0, () => {})).rejects.toMatchObject({ code: 'notFound' })
  })

  it('serializes concurrent writes so a stale revision can never clobber a newer one', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const created = await store.createRecruiting('req-1', defaultTournamentConfig(4))
    // 5 个并发 update 都基于 revision 0（读-改-写竞态模拟）：串行链 + CAS 下恰好 1 个成功，
    // 其余 4 个 badRevision —— 晚写者绝不覆盖早写者已推进的状态
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        store.update(created.state.id, 0, s => {
          s.error = `step-${i}`
        }),
      ),
    )
    const okCount = settled.filter(r => r.status === 'fulfilled').length
    const rejectCount = settled.filter(r => r.status === 'rejected').length
    expect(okCount).toBe(1)
    expect(rejectCount).toBe(4)
    const finalState = await store.get(created.state.id)
    expect(finalState!.revision).toBe(1)
  })
})

describe('TournamentStore — query & diagnostics', () => {
  it('lists tournaments, skipping corrupt directories', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    await store.createRecruiting('req-1', defaultTournamentConfig(4))
    // 造一个坏目录（半写入/损坏）
    const bad = join(tmp, 'tournaments', 'zzz-bad')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'state.json'), '{not json')
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.requestId).toBe('req-1')
  })

  it('listActive only returns recruiting/ready/running tournaments', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const created = await store.createRecruiting('req-1', defaultTournamentConfig(4))
    expect((await store.listActive()).map(s => s.id)).toEqual([created.state.id])
    await store.update(created.state.id, 0, s => {
      s.phase = 'failed'
      s.error = 'x'
    })
    expect(await store.listActive()).toEqual([])
  })

  it('scanDiagnostics reports corrupt dirs and index entries pointing at missing state', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const created = await store.createRecruiting('req-1', defaultTournamentConfig(4))
    const bad = join(tmp, 'tournaments', 'zzz-bad')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'state.json'), '{oops')
    // 索引指向缺失 state：删掉目录但保留索引
    await store.remove(created.state.id)
    const diags = await store.scanDiagnostics()
    expect(diags.some(d => d.id === 'zzz-bad')).toBe(true)
    expect(diags.some(d => d.reason.includes('request index'))).toBe(true)
  })
})

describe('TournamentStore — applyResult', () => {
  it('applies a winner: writes receipt then publishes slot won', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const { tournamentId } = await buildRunning(store)
    const res = await store.applyResult({
      tournamentId,
      slotId: 'r1s0',
      expectedSlotRevision: 0,
      attempt: 0,
      result: matchResult({ matchId: 'match-1', tournamentId, winnerPid: 'p0', pids: ['p0', 'p1'], scoreOf: { p0: 10, p1: 0 } }),
    })
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.slotRevision).toBe(1)
    const slot = res.state.slots.find(s => s.slotId === 'r1s0')!
    expect(slot.phase).toBe('won')
    expect(slot.winnerParticipantId).toBe('p0')
    expect(slot.attempts[0]).toMatchObject({ phase: 'settled', resultId: 'match-1' })
    // receipt no-clobber 落盘
    const receipt = await readJson<TournamentReceipt>(join(tmp, 'tournaments', tournamentId, 'receipts', 'match-1.json'))
    expect(receipt).toMatchObject({ resultId: 'match-1', slotId: 'r1s0', fromRevision: 0, toRevision: 1 })
    expect(receipt!.resultHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is idempotent for the same resultId+hash (no revision change, no double advance)', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const { tournamentId } = await buildRunning(store)
    const input = {
      tournamentId,
      slotId: 'r1s0',
      expectedSlotRevision: 0,
      attempt: 0 as const,
      result: matchResult({ matchId: 'match-1', tournamentId, winnerPid: 'p0', pids: ['p0', 'p1'] }),
    }
    const first = await store.applyResult(input)
    expect(first.kind).toBe('ok')
    const second = await store.applyResult(input)
    expect(second.kind).toBe('idempotent')
    expect(second.slotRevision).toBe(1)
    const state = await store.get(tournamentId)
    expect(state!.revision).toBe((first.kind === 'ok' ? first.state.revision : 0))
    expect(state!.slots.find(s => s.slotId === 'r1s0')!.attempts).toHaveLength(1)
  })

  it('conflicts on stale expectedSlotRevision without writing anything', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const { tournamentId, revision } = await buildRunning(store)
    const res = await store.applyResult({
      tournamentId,
      slotId: 'r1s0',
      expectedSlotRevision: 5,
      attempt: 0,
      result: matchResult({ matchId: 'match-1', tournamentId, winnerPid: 'p0', pids: ['p0', 'p1'] }),
    })
    expect(res.kind).toBe('conflict')
    const state = await store.get(tournamentId)
    expect(state!.revision).toBe(revision)
    expect(state!.slots.find(s => s.slotId === 'r1s0')!.phase).toBe('running')
  })

  it('marks the tournament failed when the same resultId resolves to a different hash (corrupt)', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const { tournamentId } = await buildRunning(store)
    const first = await store.applyResult({
      tournamentId,
      slotId: 'r1s0',
      expectedSlotRevision: 0,
      attempt: 0,
      result: matchResult({ matchId: 'match-1', tournamentId, winnerPid: 'p0', pids: ['p0', 'p1'], scoreOf: { p0: 10, p1: 0 } }),
    })
    expect(first.kind).toBe('ok')
    // 同一 match-1 但不同 winner/hash → corrupt → tournament failed
    const second = await store.applyResult({
      tournamentId,
      slotId: 'r1s0',
      expectedSlotRevision: 1,
      attempt: 0,
      result: matchResult({ matchId: 'match-1', tournamentId, winnerPid: 'p1', pids: ['p0', 'p1'], scoreOf: { p1: 9, p0: 0 } }),
    })
    expect(second.kind).toBe('corrupt')
    if (second.kind !== 'corrupt') return
    expect(second.state.phase).toBe('failed')
    expect(second.state.error).toContain('different resultHash')
  })

  it('rejects a session-kind winner (tournament results are participant-scoped)', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const { tournamentId } = await buildRunning(store)
    const res = await store.applyResult({
      tournamentId,
      slotId: 'r1s0',
      expectedSlotRevision: 0,
      attempt: 0,
      result: {
        resultId: 'match-1',
        tournamentId,
        preset: 'arena-blitz',
        phase: 'settled',
        winner: { kind: 'session', sessionId: 's0' },
        scores: { s0: 1 },
        participantSnapshot: [],
        kills: {},
        losses: {},
        endTick: 5,
        createdAt: 1,
      },
    })
    expect(res.kind).toBe('conflict')
    expect(res.reason).toContain('participant or draw')
  })
})

describe('TournamentStore — draw / rematch at store level', () => {
  it('attempt0 draw queues attempt1; orchestrator-actived attempt1 draw ends tournament as draw', async () => {
    const store = new TournamentStore(join(tmp, 'tournaments'))
    const { tournamentId } = await buildRunning(store)
    const step0 = await store.applyResult({
      tournamentId,
      slotId: 'r1s0',
      expectedSlotRevision: 0,
      attempt: 0,
      result: matchResult({ matchId: 'match-1', tournamentId, winnerPid: null, pids: ['p0', 'p1'] }),
    })
    expect(step0.kind).toBe('ok')
    if (step0.kind !== 'ok') return
    const slotAfterDraw = step0.state.slots.find(s => s.slotId === 'r1s0')!
    expect(slotAfterDraw.phase).toBe('running')
    expect(slotAfterDraw.attempts).toHaveLength(2)
    expect(slotAfterDraw.attempts[1]).toEqual({ attempt: 1, phase: 'pending' })
    // 编排创建 rematch MatchState 并激活 attempt1
    const activated = await store.update(tournamentId, step0.state.revision, s => {
      const slot = s.slots.find(x => x.slotId === 'r1s0')!
      slot.attempts[1]!.matchId = 'match-1b'
      slot.attempts[1]!.phase = 'running'
    })
    const step1 = await store.applyResult({
      tournamentId,
      slotId: 'r1s0',
      expectedSlotRevision: 1,
      attempt: 1,
      result: matchResult({ matchId: 'match-1b', tournamentId, winnerPid: null, pids: ['p0', 'p1'], attempt: 1 }),
    })
    expect(step1.kind).toBe('ok')
    if (step1.kind !== 'ok') return
    expect(step1.state.phase).toBe('draw')
    expect(step1.state.slots.find(s => s.slotId === 'r1s0')!.phase).toBe('draw')
    expect(activated.revision).toBe(step0.state.revision + 1)
  })
})

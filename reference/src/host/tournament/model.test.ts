import { describe, expect, it } from 'vitest'
import { hashV1 } from '../canonical.ts'
import {
  ACTIVE_TOURNAMENT_PHASES,
  allocateParticipants,
  applySlotResult,
  buildInitialSlots,
  defaultTournamentConfig,
  isTournamentPhaseActive,
  isTournamentPhaseRetryable,
  newParticipantId,
  newTournamentId,
  pairIntoSlots,
  slotIdFor,
  totalRounds,
  toTournamentPublicView,
  TournamentModelError,
  validateTournamentConfig,
  type TournamentParticipant,
  type TournamentSlot,
  type TournamentState,
} from './model.ts'

function participant(seed: number, sessionId = `s${seed}`): TournamentParticipant {
  return { participantId: `p${seed}`, sessionId, displayName: `Agent ${seed + 1}`, seed }
}

/** 一场 running 赛事：首轮 slots 就绪、slot r1s0 已编排（attempt0 running）。 */
function participantsFor(seats: 4 | 8 = 4): TournamentParticipant[] {
  const participants = allocateParticipants(Array.from({ length: seats }, (_, i) => `s${i}`), seats)
  for (let i = 0; i < participants.length; i++) participants[i]!.participantId = `p${i}`
  return participants
}

/** 编排激活 slot：回填 matchId、slot/attempt0 置 running（纯引擎不自动做；编排层行为）。 */
function activateSlot(state: TournamentState, slotId: string, matchId: string): TournamentState {
  const slot = state.slots.find(s => s.slotId === slotId)!
  slot.phase = 'running'
  slot.attempts[0]!.matchId = matchId
  slot.attempts[0]!.phase = 'running'
  return state
}

/** ready 赛事：slots 已建但都 pending（编排未开始）。 */
function initialTournament(seats: 4 | 8 = 4): TournamentState {
  const participants = participantsFor(seats)
  return {
    id: newTournamentId(),
    requestId: 'req-1',
    config: defaultTournamentConfig(seats),
    phase: 'ready',
    revision: 0,
    participants,
    slots: buildInitialSlots(participants),
    operations: [{ operationId: 'op-1', kind: 'recruit', at: 1 }],
    createdAt: 1,
    updatedAt: 1,
  }
}

/** running 赛事：首轮 slots 全部进入编排（attempt0 running、slot running）。 */
function runningTournament(seats: 4 | 8 = 4): TournamentState {
  const state = initialTournament(seats)
  state.phase = 'running'
  state.revision = 1
  for (const slot of state.slots) {
    slot.phase = 'running'
    slot.attempts[0]!.phase = 'running'
  }
  state.currentSlotId = state.slots[0]!.slotId
  return state
}

describe('config & guards', () => {
  it('accepts only seats 4|8, preset arena-blitz, maxAttempts 2', () => {
    validateTournamentConfig(defaultTournamentConfig(4))
    validateTournamentConfig(defaultTournamentConfig(8))
    expect(() => validateTournamentConfig({ ...defaultTournamentConfig(4), seats: 2 } as never)).toThrow(TournamentModelError)
    expect(() => validateTournamentConfig({ ...defaultTournamentConfig(4), preset: 'world-rounds' } as never)).toThrow(TournamentModelError)
    expect(() => validateTournamentConfig({ ...defaultTournamentConfig(4), maxAttempts: 3 } as never)).toThrow(TournamentModelError)
  })

  it('computes rounds: 4 → 2 rounds, 8 → 3 rounds', () => {
    expect(totalRounds(4)).toBe(2)
    expect(totalRounds(8)).toBe(3)
    expect(() => totalRounds(6)).toThrow(TournamentModelError)
  })

  it('treats recruiting/ready/running as active (single-active invariant) and failed/interrupted as retryable', () => {
    expect(ACTIVE_TOURNAMENT_PHASES).toEqual(['recruiting', 'ready', 'running'])
    for (const p of ['recruiting', 'ready', 'running'] as const) expect(isTournamentPhaseActive(p)).toBe(true)
    for (const p of ['completed', 'draw', 'failed', 'interrupted'] as const) expect(isTournamentPhaseActive(p)).toBe(false)
    expect(isTournamentPhaseRetryable('failed')).toBe(true)
    expect(isTournamentPhaseRetryable('interrupted')).toBe(true)
    expect(isTournamentPhaseRetryable('ready')).toBe(false)
  })

  it('generates distinct public ids (tournament/participant) and deterministic slotIds', () => {
    expect(newTournamentId()).not.toBe(newTournamentId())
    expect(newParticipantId()).not.toBe(newParticipantId())
    expect(slotIdFor(1, 0)).toBe('r1s0')
    expect(slotIdFor(2, 3)).toBe('r2s3')
  })
})

describe('roster & pairing (deterministic bracket)', () => {
  it('allocates participants by session order with seed 0..n-1 and Agent aliases', () => {
    const ps = allocateParticipants(['a', 'b', 'c', 'd'], 4)
    expect(ps.map(p => [p.seed, p.displayName, p.sessionId])).toEqual([
      [0, 'Agent 1', 'a'],
      [1, 'Agent 2', 'b'],
      [2, 'Agent 3', 'c'],
      [3, 'Agent 4', 'd'],
    ])
    expect(new Set(ps.map(p => p.participantId)).size).toBe(4)
    expect(() => allocateParticipants(['a', 'b'], 4)).toThrow(TournamentModelError)
  })

  it('pairs 4 seats as seed0 vs seed1, seed2 vs seed3 in round 1', () => {
    const ps = [participant(0), participant(1), participant(2), participant(3)]
    const slots = buildInitialSlots(ps)
    expect(slots.map(s => [s.slotId, s.participantIds])).toEqual([
      ['r1s0', ['p0', 'p1']],
      ['r1s1', ['p2', 'p3']],
    ])
    for (const s of slots) {
      expect(s.round).toBe(1)
      expect(s.phase).toBe('pending')
      expect(s.revision).toBe(0)
      expect(s.attempts).toEqual([{ attempt: 0, phase: 'pending' }])
    }
  })

  it('pairs 8 seats into 4 first-round slots, unsorted input still pairs by seed', () => {
    const ps = [participant(7), participant(0), participant(5), participant(2), participant(1), participant(6), participant(3), participant(4)]
    const slots = buildInitialSlots(ps)
    expect(slots).toHaveLength(4)
    expect(slots.map(s => s.participantIds)).toEqual([
      ['p0', 'p1'],
      ['p2', 'p3'],
      ['p4', 'p5'],
      ['p6', 'p7'],
    ])
    expect(totalRounds(8)).toBe(3)
  })

  it('pairIntoSlots rejects odd or empty input', () => {
    expect(() => pairIntoSlots(['a'], 2)).toThrow(TournamentModelError)
    expect(() => pairIntoSlots([], 2)).toThrow(TournamentModelError)
  })
})

describe('applySlotResult — slot CAS / attempt / winner advance', () => {
  it('applies a winner to a running attempt: slot won, attempt settled, revisions advance', () => {
    const state = runningTournament(4)
    const beforeRev = state.revision
    const res = applySlotResult(state, {
      slotId: 'r1s0',
      expectedSlotRevision: 0,
      expectedAttempt: 0,
      resultId: 'match-1',
      resultHash: hashV1({ resultId: 'match-1', winner: 'p0' }),
      outcome: { winnerParticipantId: 'p0' },
    })
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const slot = res.state.slots.find(s => s.slotId === 'r1s0')!
    expect(slot.phase).toBe('won')
    expect(slot.winnerParticipantId).toBe('p0')
    expect(slot.attempts[0]).toMatchObject({ attempt: 0, phase: 'settled', resultId: 'match-1', winnerParticipantId: 'p0' })
    expect(slot.revision).toBe(1)
    expect(res.state.revision).toBe(beforeRev + 1)
    expect(res.state.phase).toBe('running') // 非末轮：仍 running
  })

  it('rejects a winner that is not a slot participant', () => {
    const res = applySlotResult(runningTournament(4), {
      slotId: 'r1s0',
      expectedSlotRevision: 0,
      expectedAttempt: 0,
      resultId: 'm1',
      resultHash: 'h',
      outcome: { winnerParticipantId: 'p9' },
    })
    expect(res).toEqual({ kind: 'conflict', reason: expect.stringContaining('not in slot') } as never)
  })

  it('rejects stale slot revision, unknown attempt and attempts that cannot accept a result', () => {
    const state = runningTournament(4)
    const base = {
      resultId: 'm1',
      resultHash: 'h',
      outcome: { winnerParticipantId: 'p0' },
    } as const
    expect(applySlotResult(state, { ...base, slotId: 'r1s0', expectedSlotRevision: 1, expectedAttempt: 0 }).kind).toBe('conflict')
    expect(applySlotResult(state, { ...base, slotId: 'r1x', expectedSlotRevision: 0, expectedAttempt: 0 }).kind).toBe('conflict')
    expect(applySlotResult(state, { ...base, slotId: 'r1s0', expectedSlotRevision: 0, expectedAttempt: 1 }).kind).toBe('conflict')
    // pending attempt 不可结算（编排未开始的 slot）
    const ready = initialTournament(4)
    expect(applySlotResult(ready, { ...base, slotId: 'r1s0', expectedSlotRevision: 0, expectedAttempt: 0 }).kind).toBe('conflict')
  })

  it('creates the final slot once all round-1 slots are won, then completes on the final winner', () => {
    const state = runningTournament(4)
    const step1 = applySlotResult(state, {
      slotId: 'r1s0', expectedSlotRevision: 0, expectedAttempt: 0, resultId: 'm1', resultHash: 'h1', outcome: { winnerParticipantId: 'p0' },
    })
    expect(step1.kind).toBe('ok')
    if (step1.kind !== 'ok') return
    expect(step1.state.slots).toHaveLength(2) // 一轮未完，不生成下一轮
    const step2 = applySlotResult(step1.state, {
      slotId: 'r1s1', expectedSlotRevision: 0, expectedAttempt: 0, resultId: 'm2', resultHash: 'h2', outcome: { winnerParticipantId: 'p2' },
    })
    expect(step2.kind).toBe('ok')
    if (step2.kind !== 'ok') return
    expect(step2.state.slots).toHaveLength(3)
    const finalSlot = step2.state.slots.find(s => s.slotId === 'r2s0')!
    expect(finalSlot.participantIds).toEqual(['p0', 'p2']) // winners 按 slot.index 升序两两配对
    expect(finalSlot.phase).toBe('pending')
    // 决赛 slot 由编排激活（创建 MatchState）后才能结算
    const withFinal = activateSlot(step2.state, 'r2s0', 'm3')
    const step3 = applySlotResult(withFinal, {
      slotId: 'r2s0', expectedSlotRevision: 0, expectedAttempt: 0, resultId: 'm3', resultHash: 'h3', outcome: { winnerParticipantId: 'p0' },
    })
    expect(step3.kind).toBe('ok')
    if (step3.kind !== 'ok') return
    expect(step3.state.phase).toBe('completed')
    expect(step3.state.championParticipantId).toBe('p0')
  })
})

describe('applySlotResult — draw & rematch gate', () => {
  it('attempt0 draw keeps slot running and queues attempt1 pending (no champion)', () => {
    const state = runningTournament(4)
    const res = applySlotResult(state, {
      slotId: 'r1s0', expectedSlotRevision: 0, expectedAttempt: 0, resultId: 'm1', resultHash: 'h1', outcome: { draw: true },
    })
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const slot = res.state.slots.find(s => s.slotId === 'r1s0')!
    expect(slot.attempts[0]).toMatchObject({ attempt: 0, phase: 'draw', resultId: 'm1' })
    expect(slot.attempts).toHaveLength(2)
    expect(slot.attempts[1]).toEqual({ attempt: 1, phase: 'pending' })
    expect(slot.phase).toBe('running') // 等 rematch
    expect(res.state.phase).toBe('running')
  })

  it('attempt1 draw ends the slot and the tournament as draw (no next slots, no champion)', () => {
    let state = runningTournament(4)
    const step1 = applySlotResult(state, {
      slotId: 'r1s0', expectedSlotRevision: 0, expectedAttempt: 0, resultId: 'm1', resultHash: 'h1', outcome: { draw: true },
    })
    expect(step1.kind).toBe('ok')
    if (step1.kind !== 'ok') return
    // 编排（orchestrator）在 rematch MatchState 创建后把 attempt1 置 running（纯引擎不自动做）
    const slotAfterDraw = step1.state.slots.find(s => s.slotId === 'r1s0')!
    expect(slotAfterDraw.attempts[1]?.phase).toBe('pending')
    slotAfterDraw.attempts[1]!.phase = 'running'
    const step2 = applySlotResult(step1.state, {
      slotId: 'r1s0', expectedSlotRevision: 1, expectedAttempt: 1, resultId: 'm1b', resultHash: 'h1b', outcome: { draw: true },
    })
    expect(step2.kind).toBe('ok')
    if (step2.kind !== 'ok') return
    expect(step2.state.slots.find(s => s.slotId === 'r1s0')!.phase).toBe('draw')
    expect(step2.state.phase).toBe('draw')
    expect(step2.state.slots).toHaveLength(2) // 不创建后续 slot
    expect(step2.state.championParticipantId).toBeUndefined()
  })
})

describe('applySlotResult — idempotency & corruption', () => {
  it('same resultId with same prior resultHash is idempotent (no mutation)', () => {
    const state = runningTournament(4)
    const first = applySlotResult(state, {
      slotId: 'r1s0', expectedSlotRevision: 0, expectedAttempt: 0, resultId: 'm1', resultHash: 'h1', outcome: { winnerParticipantId: 'p0' },
    })
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    const after = first.state
    const replay = applySlotResult(after, {
      slotId: 'r1s0', expectedSlotRevision: 1, expectedAttempt: 0, resultId: 'm1', resultHash: 'h1', priorResultHash: 'h1', outcome: { winnerParticipantId: 'p0' },
    })
    expect(replay.kind).toBe('idempotent')
    if (replay.kind !== 'idempotent') return
    expect(replay.state.revision).toBe(after.revision)
    expect(replay.state.slots.find(s => s.slotId === 'r1s0')!.revision).toBe(1)
  })

  it('same resultId with a different resultHash is corrupt (store will fail the tournament)', () => {
    const state = runningTournament(4)
    const first = applySlotResult(state, {
      slotId: 'r1s0', expectedSlotRevision: 0, expectedAttempt: 0, resultId: 'm1', resultHash: 'h1', outcome: { winnerParticipantId: 'p0' },
    })
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    const replay = applySlotResult(first.state, {
      slotId: 'r1s0', expectedSlotRevision: 1, expectedAttempt: 0, resultId: 'm1', resultHash: 'h2', priorResultHash: 'h1', outcome: { winnerParticipantId: 'p0' },
    })
    expect(replay).toEqual({ kind: 'corrupt', reason: expect.stringContaining('different resultHash') } as never)
  })
})

describe('public view (redaction)', () => {
  it('strips sessionId and marks retryable from phase', () => {
    const state = runningTournament(4)
    const view = toTournamentPublicView(state)
    expect(JSON.stringify(view)).not.toContain('sessionId')
    // participant sessionIds 是 s0..s3；公开视图里不应出现这些值（slotId "r1s0" 含子串但值不同）
    expect(JSON.stringify(view)).not.toMatch(/"s[0-3]"/)
    expect(view.participants[0]).toEqual({ participantId: 'p0', displayName: 'Agent 1', seed: 0 })
    expect(view.retryable).toBe(false)
    const failed: TournamentState = { ...state, phase: 'failed', error: 'recruit timeout' }
    expect(toTournamentPublicView(failed).retryable).toBe(true)
    expect(toTournamentPublicView(failed).error).toBe('recruit timeout')
  })
})

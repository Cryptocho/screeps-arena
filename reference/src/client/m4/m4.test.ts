/**
 * M4-E.1 — 纯投影/API guard 单测：bracket 列投影、replay timeline/seek、
 * leaderboard 排序、strict DTO guard（丢弃未知字段，绝不把内部字段进 browser state）。
 */
import { describe, expect, it } from 'vitest'
import {
  guardMatch,
  guardMatchList,
  guardReplayPage,
  guardTournament,
  guardTournamentDetail,
  guardTournamentList,
} from './api.ts'
import {
  projectBracketColumns,
  projectLeaderboard,
  projectReplayTimeline,
  seekSeq,
  slotLabel,
  slotReplayId,
  type BracketView,
  type ReplayPageView,
} from './projection.ts'

describe('M4-E projection: bracket', () => {
  const participants = [
    { participantId: 'p1', displayName: 'Agent 1', seed: 0 },
    { participantId: 'p2', displayName: 'Agent 2', seed: 1 },
    { participantId: 'p3', displayName: 'Agent 3', seed: 2 },
    { participantId: 'p4', displayName: 'Agent 4', seed: 3 },
  ]
  const view: BracketView = {
    tournamentId: 't1',
    phase: 'running',
    seats: 4,
    participants,
    rounds: [
      {
        round: 2,
        slots: [{ slotId: 'r2s0', round: 2, index: 0, participants: [participants[0]!, participants[2]!], phase: 'pending', attempts: [] }],
      },
      {
        round: 1,
        slots: [
          {
            slotId: 'r1s0', round: 1, index: 0,
            participants: [participants[0]!, participants[1]!],
            phase: 'won',
            winner: participants[0],
            attempts: [{ attempt: 0, matchId: 'm1', replayId: 'r-m1', phase: 'settled', winnerParticipantId: 'p1' }],
            replayId: 'r-m1',
            matchId: 'm1',
          },
          {
            slotId: 'r1s1', round: 1, index: 1,
            participants: [participants[2]!, participants[3]!],
            phase: 'pending',
            attempts: [],
          },
        ],
      },
    ],
    currentSlotId: 'r1s1',
  }

  it('projectBracketColumns sorts rounds ascending and slots by index', () => {
    const cols = projectBracketColumns(view)
    expect(cols.map(c => c.round)).toEqual([1, 2])
    expect(cols[0]!.slots.map(s => s.slotId)).toEqual(['r1s0', 'r1s1'])
    expect(cols[1]!.slots[0]!.slotId).toBe('r2s0')
  })

  it('slotLabel / slotReplayId give public alias + replay entry', () => {
    const won = view.rounds.find(r => r.round === 1)!.slots[0]!
    expect(slotLabel(won)).toContain('🏆 Agent 1')
    expect(slotLabel(won)).toContain('Agent 2')
    expect(slotReplayId(won)).toBe('r-m1')
    const pending = view.rounds.find(r => r.round === 1)!.slots[1]!
    expect(slotLabel(pending)).toBe('Agent 3 vs Agent 4')
    expect(slotReplayId(pending)).toBeUndefined()
  })
})

describe('M4-E projection: replay timeline', () => {
  const page: ReplayPageView = {
    matchId: 'm1',
    replayId: 'r-m1',
    status: 'partial',
    complete: false,
    gapReasons: ['busy'],
    nextCursor: 3,
    availableCount: 3,
    records: [
      { kind: 'frame', seq: 0, gameTime: 10 },
      { kind: 'gap', seq: 1, fromTick: 11, toTick: 15, reason: 'busy' },
      { kind: 'frame', seq: 2, gameTime: 16 },
    ],
  }

  it('projectReplayTimeline: frames filter, gap fold, tickRange, complete passthrough', () => {
    const tl = projectReplayTimeline(page)
    expect(tl.frames.map(f => f.gameTime)).toEqual([10, 16])
    expect(tl.gaps).toEqual([{ fromTick: 11, toTick: 15, reason: 'busy' }])
    expect(tl.tickRange).toEqual({ from: 10, to: 16 })
    expect(tl.complete).toBe(false)
  })

  it('seekSeq finds first frame at/after target', () => {
    expect(seekSeq(page.records, 10)).toBe(0)
    expect(seekSeq(page.records, 16)).toBe(2)
    expect(seekSeq(page.records, 999)).toBeUndefined()
  })
})

describe('M4-E projection: leaderboard', () => {
  it('sorts by rank ascending', () => {
    const view = projectLeaderboard({
      rows: [
        { participantId: 'p2', displayName: 'B', wins: 1, losses: 0, draws: 0, matches: 1, scoreTotal: 5, rank: 2 },
        { participantId: 'p1', displayName: 'A', wins: 1, losses: 0, draws: 0, matches: 1, scoreTotal: 8, rank: 1 },
      ],
      hasMore: false,
    })
    expect(view.rows.map(r => r.participantId)).toEqual(['p1', 'p2'])
    expect(view.hasMore).toBe(false)
  })
})

describe('M4-E API guards (strict DTO, 丢弃未知字段)', () => {
  it('guardMatch 只抽公开字段，丢弃 settlement/journal/session 内部字段', () => {
    const raw = {
      ok: true,
      matches: [
        {
          id: 'm1',
          phase: 'running',
          preset: 'arena-blitz',
          players: [{ sessionId: 's1', username: 'u1', submitted: true }],
          // 内部字段必须被丢弃
          settlement: { journal: 'secret' },
          revision: 3,
        },
      ],
    }
    const list = guardMatchList(raw)
    expect(list).toHaveLength(1)
    const m = list[0]!
    expect(m.id).toBe('m1')
    expect(m.phase).toBe('running')
    expect(m.players[0]).toEqual({ sessionId: 's1', username: 'u1', submitted: true })
    expect(JSON.stringify(m)).not.toContain('settlement')
    expect(JSON.stringify(m)).not.toContain('journal')
    expect(JSON.stringify(m)).not.toContain('revision')
  })

  it('guardMatch rejects non-object / missing id, keeps no internal fields', () => {
    expect(guardMatch(null)).toBeUndefined()
    expect(guardMatch({ phase: 'running' })).toBeUndefined()
    const m = guardMatch({ id: 'x', phase: 'settled', players: [{ username: 'u' }] })!
    expect(m.players[0]).toEqual({ sessionId: undefined, username: 'u', submitted: undefined })
  })

  it('guardTournamentList 丢弃 session/userId/stack，保留公开 slot/attempt', () => {
    const raw = {
      tournaments: [
        {
          tournamentId: 't1',
          requestId: 'req-1',
          phase: 'running',
          revision: 3,
          config: { preset: 'arena-blitz', seats: 4 },
          participants: [{ participantId: 'p1', displayName: 'Agent 1', seed: 0, sessionId: 'SECRET', userId: 'SECRET2' }],
          slots: [
            {
              slotId: 'r1s0',
              round: 1,
              index: 0,
              participantIds: ['p1', 'p2'],
              phase: 'running',
              attempts: [{ attempt: 0, matchId: 'm1', replayId: 'r-m1', phase: 'settled' }],
            },
          ],
          championParticipantId: undefined,
          error: undefined,
          retryable: false,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    }
    const list = guardTournamentList(raw)
    expect(list).toHaveLength(1)
    const t = list[0]!
    expect(t.tournamentId).toBe('t1')
    expect(t.config?.seats).toBe(4)
    // 参与者的内部字段被剥离
    expect(JSON.stringify(t)).not.toContain('SECRET')
    expect(JSON.stringify(t)).not.toContain('sessionId')
    expect(JSON.stringify(t)).not.toContain('h1')
    expect(t.slots[0]!.attempts[0]!.replayId).toBe('r-m1')
  })

  it('guardTournamentDetail unwraps {ok, tournament:{...}} detail response', () => {
    // 详情端点响应形状（URL 实测）：{ok:true, tournament:{...}}
    const d = guardTournamentDetail({
      ok: true,
      tournament: {
        tournamentId: 't9',
        requestId: 'req-9',
        phase: 'ready',
        revision: 2,
        config: { preset: 'arena-blitz', seats: 4 },
        participants: [{ participantId: 'p1', displayName: 'Agent 1', seed: 0 }],
        slots: [],
        retryable: false,
        createdAt: 1,
        updatedAt: 2,
      },
    })
    expect(d?.tournamentId).toBe('t9')
    expect(d?.phase).toBe('ready')
    // 直接传完整对象（不解包）→ 失败（防旧误用）
    expect(guardTournamentDetail({ tournamentId: 't9', phase: 'ready' })).toBeUndefined()
    expect(guardTournamentDetail(null)).toBeUndefined()
  })

  it('guardReplayPage returns unavailable with reason when unavailable', () => {
    const p = guardReplayPage({ matchId: 'm1', unavailable: true, reason: 'no replay' })
    expect(p?.unavailable).toBe(true)
    expect(p?.reason).toBe('no replay')
    expect(p?.records).toEqual([])
  })

  it('guardReplayPage extracts public frameSummary but drops internal frame fields', () => {
    const p = guardReplayPage({
      matchId: 'm1',
      replayId: 'r-m1',
      status: 'complete',
      complete: true,
      gapReasons: [],
      nextCursor: 1,
      availableCount: 1,
      records: [
        {
          kind: 'frame',
          seq: 0,
          gameTime: 10,
          // 内部字段会被 ignore（frameSummary 只抽白名单）
          frame: {
            rooms: [{ room: 'W15N15', own: { username: 'u1', level: 5, energy: 9999 }, publicObjects: [{ kind: 'spawn' }] }],
            events: [{ type: 'attack', damage: 30 }],
            secret: 'xxx',
          },
        },
      ],
    })
    const r = p!.records[0]!
    expect(r.frameSummary?.rooms[0]).toEqual({ room: 'W15N15', owner: 'u1', objectCount: 1 })
    expect(r.frameSummary?.eventCount).toBe(1)
    expect(JSON.stringify(r)).not.toContain('secret')
    expect(JSON.stringify(r)).not.toContain('energy')
  })
})
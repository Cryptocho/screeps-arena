import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFromPreset } from './model.ts'
import { MatchError, MatchStore } from './store.ts'

const dirs: string[] = []
function tempStore(): MatchStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-match-'))
  dirs.push(dir)
  return new MatchStore(join(dir, 'matches'))
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('MatchStore', () => {
  it('create → get → list roundtrip', async () => {
    const store = tempStore()
    const created = await store.create(configFromPreset('world-rounds'), { sessionId: 'sess-1', username: 'bot_a' })
    expect(created.phase).toBe('creating')
    expect(created.players).toHaveLength(1)
    expect(created.players[0]!.username).toBe('bot_a')

    const loaded = await store.get(created.id)
    expect(loaded?.id).toBe(created.id)
    expect((await store.list())).toHaveLength(1)
    expect((await store.active())?.id).toBe(created.id)
  })

  it('enforces one active match per server dir', async () => {
    const store = tempStore()
    await store.create(configFromPreset('arena-blitz'))
    await expect(store.create(configFromPreset('arena-blitz'))).rejects.toMatchObject({ code: 'activeExists' })
  })

  it('remove() deletes the whole match dir including M6 codes.jsonl (plan-M6 §4-A)', async () => {
    const store = tempStore()
    const created = await store.create(configFromPreset('arena-blitz'))
    const { mkdirSync, existsSync } = await import('node:fs')
    const matchDir = join(store.dir, created.id)
    mkdirSync(matchDir, { recursive: true })
    writeFileSync(join(matchDir, 'codes.jsonl'), '{"seq":1}\n', 'utf8')
    expect(existsSync(join(matchDir, 'codes.jsonl'))).toBe(true)
    await store.remove(created.id)
    expect(existsSync(matchDir)).toBe(false)
  })

  it('allows a new match after the previous one settles', async () => {
    const store = tempStore()
    const first = await store.create(configFromPreset('arena-blitz'))
    await store.transition(first.id, 'placing')
    await store.transition(first.id, 'running')
    await store.settle(first.id, { kind: 'draw' }, {}, 1000)
    expect((await store.active())).toBeNull()
    const second = await store.create(configFromPreset('arena-blitz'))
    expect(second.id).not.toBe(first.id)
  })

  it('addPlayer: fills seats, rejects overflow and duplicate sessions', async () => {
    const store = tempStore()
    const match = await store.create(configFromPreset('arena-blitz'))
    await store.addPlayer(match.id, { sessionId: 'sess-1', username: 'bot_a' })
    const full = await store.addPlayer(match.id, { sessionId: 'sess-2', username: 'bot_b' })
    expect(full.players).toHaveLength(2)
    await expect(store.addPlayer(match.id, { sessionId: 'sess-3', username: 'bot_c' })).rejects.toMatchObject({ code: 'full' })
    await expect(store.addPlayer(match.id, { sessionId: 'sess-1', username: 'bot_a2' })).rejects.toMatchObject({ code: 'duplicatePlayer' })
  })

  it('addPlayer rejected in terminal phases', async () => {
    const store = tempStore()
    const match = await store.create(configFromPreset('arena-blitz'))
    await store.transition(match.id, 'placing')
    await store.transition(match.id, 'running')
    await store.settle(match.id, { kind: 'draw' }, {}, 100)
    await expect(store.addPlayer(match.id, { sessionId: 'sess-9', username: 'late' })).rejects.toMatchObject({ code: 'badPhase' })
  })

  it('transition validates the state machine and persists phaseTick extras', async () => {
    const store = tempStore()
    const match = await store.create(configFromPreset('world-rounds'))
    await expect(store.transition(match.id, 'running')).rejects.toMatchObject({ code: 'badTransition' })
    await store.transition(match.id, 'placing')
    const running = await store.transition(match.id, 'running', { startTick: 4242 })
    expect(running.phase).toBe('running')
    expect(running.startTick).toBe(4242)
    const reloaded = await store.get(match.id)
    expect(reloaded?.phase).toBe('running')
  })

  it('settle writes winner/scores/endTick exactly once', async () => {
    const store = tempStore()
    const match = await store.create(configFromPreset('arena-blitz'))
    await store.transition(match.id, 'placing')
    await store.transition(match.id, 'running')
    const settled = await store.settle(match.id, { kind: 'session', id: 'sess-1' }, { 'sess-1': 320, 'sess-2': 40 }, 1849)
    expect(settled.winner).toEqual({ kind: 'session', id: 'sess-1' })
    expect(settled.scores?.['sess-2']).toBe(40)
    await expect(store.settle(match.id, { kind: 'draw' }, {}, 2000)).rejects.toMatchObject({ code: 'badTransition' })
  })

  it('markInterrupted flags all leftover active matches after a crash', async () => {
    const store = tempStore()
    // 直接铺两个"上次崩溃留下"的活跃对局目录
    const mk = async (phase: 'creating' | 'placing' | 'running') => {
      const m = await store.create(configFromPreset('arena-blitz'))
      if (phase !== 'creating') await store.transition(m.id, phase === 'running' ? 'placing' : phase)
      if (phase === 'running') await store.transition(m.id, 'running')
      return m
    }
    // 同一时刻只能有一个活跃 —— 先建好第一个并终态化，为第二个腾位
    const first = await mk('creating')
    await store.transition(first.id, 'interrupted')
    const second = await mk('running')
    const flagged = await store.markInterrupted()
    expect(flagged.map(m => m.id)).toEqual([second.id])
    expect((await store.get(second.id))?.phase).toBe('interrupted')
  })

  it('list skips corrupt state files instead of throwing', async () => {
    const store = tempStore()
    await store.create(configFromPreset('arena-blitz'))
    // 伪造一个坏目录
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(store.dir, 'mbroken'))
    writeFileSync(join(store.dir, 'mbroken', 'state.json'), '{ not json')
    const all = await store.list()
    expect(all).toHaveLength(1)
    await expect(store.get('mbroken')).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('update mutates without touching phase', async () => {
    const store = tempStore()
    const match = await store.create(configFromPreset('world-rounds'), { sessionId: 'sess-1', username: 'bot_a' })
    const updated = await store.update(match.id, state => {
      state.players[0]!.userId = 'abc123'
    })
    expect(updated.players[0]!.userId).toBe('abc123')
    expect(updated.phase).toBe('creating')
  })

  it('concurrent writes do not clobber each other (random tmp suffix)', async () => {
    // A0 web lane 实测回归：start 编排的 transition/update 与 spawn 收尾并发写共用固定
    // pid tmp → 一个 rename 移走后另一个 ENOENT。随机后缀保证每次写独立 tmp、原子 rename。
    const store = tempStore()
    const match = await store.create(configFromPreset('arena-blitz'))
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.update(match.id, state => {
        state.players[0] = { sessionId: `sess-${i}`, username: `bot_${i}`, joinedAt: Date.now() }
      })),
    )
    // 全部并发 update 成功、state 可读、最后写入者胜（原子 rename 无 ENOENT）
    const finalState = await store.get(match.id)
    expect(finalState?.phase).toBe('creating')
    expect(finalState?.players[0]?.sessionId).toMatch(/^sess-\d$/)
  })

  it('serialized writes: transition(placing) not clobbered by concurrent update (UI start bug)', async () => {
    // browser-mcp UI 验收实测回归：「creating → running not allowed」——start 里
    // transition(placing) 与 update(回填 userId) 并发，「读-改写」晚写者基于旧 creating
    // 快照覆盖把 phase 打回 creating，running 转不过去。修复 = 写操作串行化。
    const store = tempStore()
    const match = await store.create(configFromPreset('arena-blitz'), { sessionId: 'sess-1', username: 'bot_a' })
    await Promise.all([
      store.transition(match.id, 'placing'),
      store.update(match.id, state => {
        state.players[0]!.userId = 'u123'
      }),
    ])
    // 最终 phase 必须仍是 placing（transition 不被 update 的旧快照覆盖）
    const after = await store.get(match.id)
    expect(after?.phase).toBe('placing')
    expect(after?.players[0]?.userId).toBe('u123')
    // 且可继续 transition running（start 后续步骤不受阻）
    await expect(store.transition(match.id, 'running', { startTick: 1 })).resolves.toMatchObject({ phase: 'running' })
  })

  it('settle inside a serialized write does not deadlock', async () => {
    const store = tempStore()
    const match = await store.create(configFromPreset('arena-blitz'))
    await store.transition(match.id, 'placing')
    await store.transition(match.id, 'running')
    await expect(store.settle(match.id, { kind: 'draw' }, {}, 100)).resolves.toMatchObject({ phase: 'settled' })
  })
})

describe('MatchStore — settlement journal (M4-B)', () => {
  const candidate = (): Parameters<MatchStore['beginSettlement']>[1] => ({
    reason: 'manual' as const,
    winner: { kind: 'session', id: 'sess-a' },
    scores: { 'sess-a': 10, 'sess-b': 0 },
    kills: { 'sess-a': 1, 'sess-b': 0 },
    losses: { 'sess-a': 0, 'sess-b': 1 },
    endTick: 500,
    participantMapping: [
      { sessionId: 'sess-a', participantId: 'pa', displayName: 'Agent A', username: 'u_a' },
      { sessionId: 'sess-b', participantId: 'pb', displayName: 'Agent B', username: 'u_b' },
    ],
  })
  const ALL_NA: Parameters<MatchStore['beginSettlement']>[2] = { replay: 'na', history: 'na', tournament: 'na' }
  const ALL_ON: Parameters<MatchStore['beginSettlement']>[2] = { replay: 'enabled', history: 'enabled', tournament: 'enabled' }

  async function runningMatch(store: MatchStore, tournament = false): Promise<string> {
    const id = (await store.create(configFromPreset('arena-blitz'))).id
    await store.transition(id, 'placing')
    const state = await store.update(id, s => {
      s.phase = 'running'
      if (tournament) {
        s.tournamentId = 't1'
        s.tournamentSlotId = 'r1s0'
        s.attempt = 0
        s.players[0] = { sessionId: 'sess-a', username: 'u_a', participantId: 'pa', joinedAt: 1 }
        s.players.push({ sessionId: 'sess-b', username: 'u_b', participantId: 'pb', joinedAt: 1 })
      }
    })
    return state.id
  }

  it('begin → mark(×3) → commit walks a full enabled settlement and copies candidate to state', async () => {
    const store = tempStore()
    const id = await runningMatch(store, true)
    const begun = await store.beginSettlement(id, candidate(), ALL_ON)
    expect(begun.phase).toBe('settling')
    expect(begun.settlement?.candidateHash).toMatch(/^[0-9a-f]{64}$/)
    expect(begun.settlement?.replay.status).toBe('pending')
    expect(begun.settlement?.cleanup.status).toBe('not-applicable') // tournament → cleanup na
    const rev1 = begun.revision!
    const afterReplay = await store.markSettlement(id, rev1, 'replay', { resultId: id, payloadHash: 'r1' }, { completeness: 'complete' })
    const rev2 = afterReplay.revision!
    const afterHistory = await store.markSettlement(id, rev2, 'history', { resultId: id, payloadHash: 'h1' })
    const rev3 = afterHistory.revision!
    const afterTournament = await store.markSettlement(id, rev3, 'tournament', { resultId: id, payloadHash: 'h1', storeRevision: 3 })
    const rev4 = afterTournament.revision!
    const committed = await store.commitSettlement(id, rev4)
    expect(committed.phase).toBe('settled')
    expect(committed.winner).toEqual({ kind: 'session', id: 'sess-a' })
    expect(committed.scores).toEqual({ 'sess-a': 10, 'sess-b': 0 })
    expect(committed.endTick).toBe(500)
    expect(committed.settlement?.replay.status).toBe('committed')
    expect(committed.settlement?.replay.completeness).toBe('complete')
  })

  it('ordinary match begins with replay/history/tournament not-applicable and cleanup pending; commit is immediate', async () => {
    const store = tempStore()
    const id = await runningMatch(store)
    const begun = await store.beginSettlement(id, candidate(), ALL_NA)
    expect(begun.settlement?.replay.status).toBe('not-applicable')
    expect(begun.settlement?.history.status).toBe('not-applicable')
    expect(begun.settlement?.tournament.status).toBe('not-applicable')
    expect(begun.settlement?.cleanup.status).toBe('pending')
    const committed = await store.commitSettlement(id, begun.revision!)
    expect(committed.phase).toBe('settled')
    expect(committed.winner).toEqual({ kind: 'session', id: 'sess-a' })
  })

  it('beginSettlement is idempotent on same candidate and conflicts on a different one', async () => {
    const store = tempStore()
    const id = await runningMatch(store)
    await store.beginSettlement(id, candidate(), ALL_NA)
    const state = await store.get(id)
    const rev = state!.revision
    const again = await store.beginSettlement(id, candidate(), ALL_NA, rev)
    expect(again.phase).toBe('settling')
    expect(again.revision).toBe(rev) // 幂等不 bump
    await expect(store.beginSettlement(id, { ...candidate(), endTick: 999 }, ALL_NA)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('begin only from running/paused; mark only while settling; commit requires all markers resolved', async () => {
    const store = tempStore()
    const id = await runningMatch(store)
    await store.beginSettlement(id, candidate(), ALL_ON)
    // 只 mark replay → commit 失败（history/tournament 仍 pending）
    const state = await store.get(id)
    await store.markSettlement(id, state!.revision!, 'replay', { resultId: id, payloadHash: 'r1' })
    const rev = (await store.get(id))!.revision!
    await expect(store.commitSettlement(id, rev)).rejects.toMatchObject({ code: 'badPhase' })
    // mark 非 pending marker 幂等 / 异 receipt conflict
    const s2 = await store.get(id)
    await expect(store.markSettlement(id, s2!.revision!, 'replay', { resultId: id, payloadHash: 'r1' })).resolves.toMatchObject({ phase: 'settling' })
    const s3 = await store.get(id)
    await expect(store.markSettlement(id, s3!.revision!, 'replay', { resultId: id, payloadHash: 'OTHER' })).rejects.toMatchObject({ code: 'conflict' })
    // mark not-applicable marker → badTransition
    const ordinaryStore = tempStore()
    const ordinary = await runningMatch(ordinaryStore)
    await ordinaryStore.beginSettlement(ordinary, candidate(), ALL_NA)
    const s4 = await ordinaryStore.get(ordinary)
    await expect(ordinaryStore.markSettlement(ordinary, s4!.revision!, 'replay', { resultId: ordinary, payloadHash: 'x' })).rejects.toMatchObject({ code: 'badTransition' })
  })

  it('rejects mark receipts whose resultId is not the matchId', async () => {
    const store = tempStore()
    const id = await runningMatch(store, true)
    await store.beginSettlement(id, candidate(), ALL_ON)
    const state = await store.get(id)
    await expect(store.markSettlement(id, state!.revision!, 'history', { resultId: 'other-match', payloadHash: 'h' })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('markCleanup records hook outcome after commit and never blocks committed results', async () => {
    const store = tempStore()
    const id = await runningMatch(store)
    await store.beginSettlement(id, candidate(), ALL_NA)
    const committed = await store.commitSettlement(id, (await store.get(id))!.revision!)
    const rev = committed.revision!
    const ok = await store.markCleanup(id, rev, 'committed')
    expect(ok.settlement?.cleanup.status).toBe('committed')
    const rev2 = ok.revision!
    // 失败重试 → unknown + error
    const failed = await store.markCleanup(id, rev2, 'unknown', 'dispose failed')
    expect(failed.settlement?.cleanup.error).toBe('dispose failed')
  })

  it('markInterrupted never touches a settling match (recovery owns it); flags a running match', async () => {
    // 单活跃席位：settling 局与 running 局不能共存于同一 store → 分别验证
    const settlingStore = tempStore()
    const settling = await runningMatch(settlingStore, true)
    await settlingStore.beginSettlement(settling, candidate(), ALL_ON)
    const flaggedSettling = await settlingStore.markInterrupted()
    expect(flaggedSettling).toEqual([])
    expect((await settlingStore.get(settling))!.phase).toBe('settling')

    const runningStore = tempStore()
    const active = await runningMatch(runningStore)
    const flaggedActive = await runningStore.markInterrupted()
    expect(flaggedActive.map(m => m.id)).toEqual([active])
    expect((await runningStore.get(active))!.phase).toBe('interrupted')
  })

  it('generic transition cannot clobber settling (only abortSettlement may) and abort leaves interrupted + error', async () => {
    const store = tempStore()
    const id = await runningMatch(store, true)
    await store.beginSettlement(id, candidate(), ALL_ON)
    await expect(store.transition(id, 'interrupted')).rejects.toMatchObject({ code: 'badTransition' })
    await expect(store.transition(id, 'settled')).rejects.toMatchObject({ code: 'badTransition' }) // 只能 commitSettlement
    const state = await store.get(id)
    const aborted = await store.abortSettlement(id, state!.revision!, 'receipt conflict, abandoning candidate')
    expect(aborted.phase).toBe('interrupted')
    expect(aborted.settlement?.error).toContain('abandoning')
  })

  it('markSettlement/commitSettlement use revision CAS (stale revision rejected)', async () => {
    const store = tempStore()
    const id = await runningMatch(store, true)
    await store.beginSettlement(id, candidate(), ALL_ON)
    await expect(store.commitSettlement(id, 0)).rejects.toMatchObject({ code: 'badRevision' })
  })
})

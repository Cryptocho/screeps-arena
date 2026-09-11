import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHandleLike, AgentRegistryLike } from '../agents.ts'
import type { ScreepsWorldSnapshot, ScreepsService } from '../service.ts'
import { MatchService } from '../match/match-service.ts'
import { TournamentStore } from './store.ts'
import { TournamentError } from './store.ts'
import { TournamentService } from './service.ts'
import { defaultTournamentConfig } from './model.ts'
import { AdmissionStore } from '../admission/store.ts'
import { AdmissionGate } from '../admission/gate.ts'

let base: string
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-tsvc-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function fakeScreeps(): ScreepsService {
  return {
    ensureRunning: async () => ({ port: 1, baseUrl: 'http://x' }),
    system: async () => ({}),
    createUser: async (input: { username: string }) => ({ username: input.username, id: `uid-${input.username}` }),
    restart: async () => {},
    getWorld: async (): Promise<ScreepsWorldSnapshot> => ({ ok: true, gameTime: 1, users: [] }),
    eventLog: async () => ({ events: [], cursor: 0, bound: true }),
  } as unknown as ScreepsService
}

interface FakeRegistry extends AgentRegistryLike {
  created: Array<{ sessionId: string; agentOptions?: unknown; meta?: unknown }>
  handles: FakeHandle[]
  failNext: boolean
  disposeCalls: string[]
}

interface FakeHandle extends AgentHandleLike {
  followups: unknown[]
}

function makeFakeRegistry(failNext = false): FakeRegistry {
  const created: FakeRegistry['created'] = []
  const handles: FakeHandle[] = []
  const disposeCalls: string[] = []
  const registry: FakeRegistry = {
    created,
    handles,
    failNext,
    disposeCalls,
    async create(options) {
      if (this.failNext) {
        this.failNext = false
        throw new Error('registry create failed (simulated)')
      }
      created.push(options)
      const handle: FakeHandle = {
        followups: [],
        agent: {
          id: options.sessionId,
          followup(msg: unknown) {
            handle.followups.push(msg)
          },
        },
        async dispose() {
          disposeCalls.push(options.sessionId)
        },
      }
      handles.push(handle)
      return handle
    },
  }
  return registry
}

function makeService(registry: AgentRegistryLike | null) {
  const admission = new AdmissionStore(path.join(base, 'admission'))
  const tournamentStore = new TournamentStore(path.join(base, 'tournaments'))
  const matches = new MatchService(fakeScreeps(), path.join(base, 'data'), () => {}, {}, {})
  const gate = new AdmissionGate({ admission, matches: matches.store, tournaments: tournamentStore, log: () => {} })
  const service = new TournamentService({
    store: tournamentStore,
    gate,
    match: matches,
    registry: () => registry,
    timeoutMs: 1_000,
    log: () => {},
  })
  return { service, tournamentStore, matches, admission, gate }
}

describe('TournamentService — create & recruit', () => {
  it('create persists recruiting then recruit spawns all roster sessions and CAS → ready', async () => {
    const registry = makeFakeRegistry()
    const { service, tournamentStore: store } = makeService(registry)
    const res = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    expect(res.recruiting).toBe(false)
    const state = await store.get(res.tournamentId)
    expect(state!.phase).toBe('ready')
    expect(state!.participants).toHaveLength(4)
    expect(registry.created).toHaveLength(4)
    // participant sessionId 都已 create
    const createdSessions = registry.created.map(c => c.sessionId)
    for (const p of state!.participants) expect(createdSessions).toContain(p.sessionId)
    // handles 已登记
    expect(service.handleCount).toBe(4)
    // displayName/seed 与 participantId 分离
    expect(new Set(state!.participants.map(p => p.displayName)).size).toBe(4)
    expect(state!.participants.map(p => p.seed).sort()).toEqual([0, 1, 2, 3])
  })

  it('same requestId + same config is idempotent (returns existing tournament, no second spawn)', async () => {
    const registry = makeFakeRegistry()
    const { service, tournamentStore: store } = makeService(registry)
    const first = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    const second = await service.create('req-1', defaultTournamentConfig(4), 'op-2', { awaitRecruit: true })
    expect(second.tournamentId).toBe(first.tournamentId)
    expect(registry.created).toHaveLength(4) // 不重复 spawn
  })

  it('different config with the same requestId conflicts', async () => {
    const registry = makeFakeRegistry()
    const { service, tournamentStore: store } = makeService(registry)
    await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    await expect(service.create('req-1', defaultTournamentConfig(8), 'op-2')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('recruit failure CAS → failed and disposes the created handles', async () => {
    const registry = makeFakeRegistry()
    registry.failNext = true // 第 3 次 create 抛（前面 2 个成功）
    const { service, tournamentStore: store } = makeService(registry)
    const res = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true }).catch(e => e)
    // 只 spawn 了 1 个（第 2 个即失败）——因为循环在第一个 handle create 成功后第二次抛
    expect(registry.created.length).toBeLessThan(4)
    const state = await store.get(res.tournamentId ?? (await store.getByRequestId('req-1'))!.id)
    // create() 抛错：createRecruiting 已落盘但 gate runExclusive 内 awaitRecruit 抛 → create 也抛。
    // 直接查 store 确认 failed 被写。
    const byReq = await store.getByRequestId('req-1')
    expect(byReq).not.toBeNull()
    expect(byReq!.phase).toBe('failed')
    expect(byReq!.error).toContain('registry create failed')
    void state
    // 失败路径已 dispose 已登记 handles → service 无残留
    expect(service.handleCount).toBe(0)
  })

  it('retry with a fresh operationId re-recruits failed tournament reusing participant identity', async () => {
    const registry = makeFakeRegistry()
    registry.failNext = true
    const { service, tournamentStore: store } = makeService(registry)
    await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true }).catch(() => {})
    const failed = (await store.getByRequestId('req-1'))!
    expect(failed.phase).toBe('failed')
    const firstPids = failed.participants.map(p => p.participantId).sort()
    // retry（registry 不再失败）→ recruiting → recruit → ready
    const registry2 = makeFakeRegistry()
    const { service: service2 } = makeService(registry2)
    // 复用同一 store 目录：service2 指向不同 TournamentStore 实例但同目录
    const byReq = await store.getByRequestId('req-1')
    expect(byReq!.phase).toBe('failed')
    const retried = await service2.retry(byReq!.id, 'op-2')
    expect(retried.phase).toBe('ready')
    expect(retried.participants.map(p => p.participantId).sort()).toEqual(firstPids) // 复用身份
    expect(registry2.created).toHaveLength(4)
  })

  it('retry is refused for ready/running/completed tournaments', async () => {
    const registry = makeFakeRegistry()
    const { service, tournamentStore: store } = makeService(registry)
    const res = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    await expect(service.retry(res.tournamentId, 'op-2')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('recruit without a registry reports a readable error', async () => {
    const { service, tournamentStore } = makeService(null)
    const created = await tournamentStore.createRecruiting('req-1', defaultTournamentConfig(4))
    await expect(service.recruit('op-1', created.state.id)).rejects.toThrow('recruit needs a real DSH runtime')
  })

  it('dispose() interrupts active tournaments and disposes all handles', async () => {
    const registry = makeFakeRegistry()
    const { service, tournamentStore: store } = makeService(registry)
    const res = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    expect(service.handleCount).toBe(4)
    await service.dispose()
    expect(registry.disposeCalls).toHaveLength(4)
    expect(service.handleCount).toBe(0)
    const state = await store.get(res.tournamentId)
    expect(state!.phase).toBe('interrupted')
    expect(state!.cleanupUnknown).toContain('service-disposed')
  })

  it('recruit is idempotent once ready (repeated call returns state without re-spawning)', async () => {
    const registry = makeFakeRegistry()
    const { service, tournamentStore: store } = makeService(registry)
    const res = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    const again = await service.recruit('op-9', res.tournamentId)
    expect(again.phase).toBe('ready')
    expect(registry.created).toHaveLength(4)
  })

  it('driveOnce starts an attempt once both players submitted (submitted → lifecycle.start)', async () => {
    const registry = makeFakeRegistry()
    const { service, matches, tournamentStore: store } = makeService(registry)
    const res = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    await service.start(res.tournamentId, 'op-start')
    // orchestrator.start 已激活首场（creating + 两 player submitted=false）
    const st = await store.get(res.tournamentId)
    const slot1 = st!.slots.find(s => s.slotId === 'r1s0')!
    const matchId = slot1.attempts[0]!.matchId!
    const m0 = await matches.store.get(matchId)
    expect(m0!.phase).toBe('creating')
    // 模拟两 Agent 提交（staged code + submitted=true）
    await matches.store.update(matchId, s => {
      for (const p of s.players) {
        p.code = { main: 'module.exports.loop = function () {}' }
        p.submitted = true
      }
    })
    // 驱动一拍 → start（fake backend 的 start 会跑完落盘 running）
    const outcome = await service.driveOnce(res.tournamentId)
    expect(outcome).toBe('started')
    const after = await matches.store.get(matchId)
    expect(after!.phase).toBe('running')
    // 镜像分配：players[0] → W15N15（基准），players[1] → W14N14（镜像）
    const order = after!.players.map(p => p.sessionId)
    const slots = order.map(sid => after!.assignments![sid])
    expect(slots).toEqual(['W15N15', 'W14N15'])
  })

  it('driveOnce returns idle while players are not submitted yet', async () => {
    const registry = makeFakeRegistry()
    const { service, tournamentStore: store } = makeService(registry)
    const res = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    await service.start(res.tournamentId, 'op-start2')
    const outcome = await service.driveOnce(res.tournamentId)
    expect(outcome).toBe('idle')
    void store
  })

  it('driveOnce returns idle for a non-running tournament', async () => {
    const registry = makeFakeRegistry()
    const { service } = makeService(registry)
    const res = await service.create('req-1', defaultTournamentConfig(4), 'op-1', { awaitRecruit: true })
    // ready（未 start）→ idle
    expect(await service.driveOnce(res.tournamentId)).toBe('idle')
  })
})

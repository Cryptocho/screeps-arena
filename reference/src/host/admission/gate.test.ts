import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdmissionStore } from './store.ts'
import { AdmissionGate, AdmissionGateError } from './gate.ts'
import { TournamentStore } from '../tournament/store.ts'
import { defaultTournamentConfig } from '../tournament/model.ts'
import type { ScreepsWorldSnapshot, ScreepsService } from '../service.ts'
import { MatchService } from '../match/match-service.ts'

let base: string
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-gate-'))
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

function makeParts() {
  const admission = new AdmissionStore(path.join(base, 'admission'))
  const tournaments = new TournamentStore(path.join(base, 'tournaments'))
  const matches = new MatchService(fakeScreeps(), path.join(base, 'data'), () => {}, {}, {})
  const gate = new AdmissionGate({ admission, matches: matches.store, tournaments, log: () => {} })
  return { admission, tournaments, matches, gate }
}

describe('AdmissionGate', () => {
  it('runExclusive serializes two operations (second conflicts until first releases)', async () => {
    const { gate } = makeParts()
    let firstDone = false
    let releaseSeen = false
    const first = gate.runExclusive('tournament-create', 'op-1', 't1', async () => {
      // 第一段执行期间第二段应 conflict（acquire 检查 held）
      await expect(gate.runExclusive('legacy-spawn', 'op-2', 'legacy-1', async () => {})).rejects.toMatchObject({ code: 'conflict' })
      firstDone = true
    })
    await first
    expect(firstDone).toBe(true)
    void releaseSeen
    // 释放后可再入
    const second = await gate.runExclusive('legacy-spawn', 'op-2', 'legacy-1', async () => 'ok')
    expect(second).toBe('ok')
  })

  it('assertIdle rejects when a recovery reservation is held', async () => {
    const { gate, admission } = makeParts()
    await admission.acquireRecovery()
    await expect(gate.assertIdle()).rejects.toBeInstanceOf(AdmissionGateError)
    await expect(gate.assertIdle()).rejects.toMatchObject({ code: 'recovery' })
  })

  it('assertIdle rejects while an active tournament exists (recruiting/ready/running)', async () => {
    const { gate, tournaments } = makeParts()
    await tournaments.createRecruiting('req-1', defaultTournamentConfig(4))
    await expect(gate.assertIdle()).rejects.toMatchObject({ code: 'activeTournament' })
  })

  it('assertIdle rejects while an active match exists', async () => {
    const { gate, matches } = makeParts()
    const m = await matches.createMatch({ preset: 'world-rounds', sessionId: 's1', username: 'u1' })
    await matches.store.update(m.id, s => {
      s.phase = 'running'
    })
    await expect(gate.assertIdle()).rejects.toMatchObject({ code: 'activeMatch' })
    // 终态后放行
    await matches.store.transition(m.id, 'interrupted')
    await expect(gate.assertIdle()).resolves.toBeUndefined()
  })

  it('runExclusive returns the fn value and persists reservation across instances', async () => {
    const { admission, tournaments, matches } = makeParts()
    const gate1 = new AdmissionGate({ admission, matches: matches.store, tournaments })
    await gate1.runExclusive('tournament-create', 'op-1', 't1', async () => 'done')
    // release 已落盘：新实例可见无锁
    const gate2 = new AdmissionGate({ admission: new AdmissionStore(path.join(base, 'admission')), matches: matches.store, tournaments })
    await expect(gate2.assertIdle()).resolves.toBeUndefined()
  })
})

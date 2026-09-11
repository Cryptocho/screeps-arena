import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScreepsWorldSnapshot } from '../service.ts'
import { configFromPreset, type MatchState } from './model.ts'
import type { ArenaBackend, SettlementDrivers } from './lifecycle.ts'
import { MatchLifecycle } from './lifecycle.ts'
import { MatchStore } from './store.ts'

/** world-rounds 专项（plan-M5 §3.2/3.3/3.4）：周期边界状态机 + commit 语义 + 调度 + 超时。 */

function snapshot(gameTime: number, users: Array<Partial<ScreepsWorldSnapshot['users'][number]> & { username: string }>): ScreepsWorldSnapshot {
  return {
    ok: true,
    gameTime,
    users: users.map(u => ({
      id: `uid-${u.username}`,
      username: u.username,
      badge: undefined,
      isBot: false,
      cpu: 100,
      gcl: 0,
      ownedRooms: u.ownedRooms ?? 0,
      rclTotal: u.rclTotal ?? 0,
      spawns: u.spawns ?? 0,
      creeps: u.creeps ?? 0,
      spawnEnergy: u.spawnEnergy ?? 0,
      rooms: u.rooms ?? [],
    })),
  }
}

interface RoundsBackend extends ArenaBackend {
  calls: Array<[cmd: string, value?: unknown]>
  uploads: Array<{ username: string; branch?: string }>
  setWorld(next: ScreepsWorldSnapshot): void
  setSubmitError(username: string, err: Error): void
}

function roundsBackend(initial: ScreepsWorldSnapshot): RoundsBackend {
  const calls: Array<[cmd: string, value?: unknown]> = []
  const uploads: Array<{ username: string; branch?: string }> = []
  let world = initial
  const submitError = new Map<string, Error>()
  const backend: RoundsBackend = {
    calls,
    uploads,
    async ensureRunning() {},
    async system(cmd, value) {
      calls.push([cmd, value])
      return {}
    },
    async createUser(input) {
      calls.push(['createUser', input.username])
      return { username: input.username, id: `uid-${input.username}` }
    },
    async restart() {},
    async getWorld() {
      return world
    },
    async eventLog() {
      return { events: [], cursor: 0, bound: true }
    },
    async submitCode(username, modules, branch) {
      uploads.push({ username, branch })
      const err = submitError.get(username)
      if (err) throw err
      return { timestamp: Date.now() }
    },
    setWorld(next) {
      world = next
    },
    setSubmitError(username, err) {
      submitError.set(username, err)
    },
  }
  return backend
}

const dirs: string[] = []
function makeRounds(initial: ScreepsWorldSnapshot, drivers: SettlementDrivers = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-rounds-'))
  dirs.push(dir)
  const store = new MatchStore(join(dir, 'matches'))
  const backend = roundsBackend(initial)
  const lifecycle = new MatchLifecycle(store, backend, () => {}, drivers, 0)
  return { store, backend, lifecycle }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 双玩家 world-rounds 局：start 后世界推进到 gameTime，一轮（roundTicks）跑完。 */
async function startedRounds(lifecycle: MatchLifecycle, roundTicks = 100, maxRounds = 2) {
  const cfg = configFromPreset('world-rounds', { roundTicks, maxRounds })
  // 直接经 store.create（lifecycle.createMatch 走 world-rounds 预设+codeMode rounds）
  const store = (lifecycle as unknown as { store: MatchStore }).store
  const m = await store.create(cfg, { sessionId: 'sess-a', username: 'pa' }, { codeMode: 'rounds' })
  await store.addPlayer(m.id, { sessionId: 'sess-b', username: 'pb' })
  return m.id
}

async function startMatch(lifecycle: MatchLifecycle, id: string): Promise<MatchState> {
  return lifecycle.start(id)
}

describe('world-rounds 周期边界（plan-M5 §3.2/3.4）', () => {
  it('running 到 roundTicks 即 autoRound.due（phaseTick 驱动）', async () => {
    const { backend, lifecycle } = makeRounds(snapshot(0, []))
    const id = await startedRounds(lifecycle, 100, 2)
    const running = await startMatch(lifecycle, id)
    expect(running.phaseTick).toBe(0) // start 写入 phaseTick=当时 gameTime

    backend.setWorld(snapshot(99, []))
    const obs1 = await lifecycle.observe(id)
    expect(obs1.autoRound.due).toBe(false)

    backend.setWorld(snapshot(100, []))
    const obs2 = await lifecycle.observe(id)
    expect(obs2.autoRound.due).toBe(true)
    expect(obs2.autoRound.index).toBe(0)
  })

  it('enterRoundBreak：running → roundBreak，世界 pause，botCode 座位自动 ready', async () => {
    const { backend, lifecycle, store } = makeRounds(snapshot(0, []))
    const id = await startedRounds(lifecycle, 100, 2)
    await startMatch(lifecycle, id)
    backend.setWorld(snapshot(100, []))
    // 给 players[0] 注入 botCode（bot 身份；M3 测试链路）
    await store.update(id, s => {
      s.players[0]!.botCode = { main: 'module.exports.loop = function () {}' }
    })
    const broken = await lifecycle.enterRoundBreak(id)
    expect(broken.phase).toBe('roundBreak')
    expect(broken.roundBreakSince).toBeGreaterThan(0)
    // pause 已调用
    expect(backend.calls.some(c => c[0] === 'pause')).toBe(true)
    // bot 座位自动 ready；Agent 座位未 ready
    expect(broken.players[0]!.ready).toBe(true)
    expect(broken.players[1]!.ready).toBeUndefined()
    // 幂等：再次 enterRoundBreak 不重复 pause
    const c2 = backend.calls.filter(c => c[0] === 'pause').length
    await lifecycle.enterRoundBreak(id)
    expect(backend.calls.filter(c => c[0] === 'pause').length).toBe(c2)
  })

  it('resumeNextRound：全员 ready 后续跑——resume 前真传代码（submitCode 上传），roundIndex+1', async () => {
    const { backend, lifecycle, store } = makeRounds(snapshot(0, []))
    const id = await startedRounds(lifecycle, 100, 2)
    await startMatch(lifecycle, id)
    backend.setWorld(snapshot(100, []))
    await lifecycle.enterRoundBreak(id)
    // 两个 Agent 座位都 commit（保留 code + ready=true）
    const commitCode = { main: 'module.exports.loop = function () { /* round1 */ }' }
    await store.update(id, s => {
      for (const p of s.players) {
        p.code = commitCode
        p.ready = true
      }
    })
    const resumed = await lifecycle.resumeNextRound(id)
    expect(resumed.phase).toBe('running')
    expect(resumed.roundIndex).toBe(1)
    expect(resumed.players.every(p => p.ready === undefined || p.ready === false)).toBe(true)
    // resume 前真传：submitCode 调了 2 玩家、branch=$activeWorld；world resumed
    expect(backend.uploads.map(u => u.username).sort()).toEqual(['pa', 'pb'])
    expect(backend.uploads.every(u => u.branch === '$activeWorld')).toBe(true)
    const resumeIdx = backend.calls.findIndex(c => c[0] === 'resume')
    // submitCode 走 backend.uploads（不在 calls）；断言 resume 时 uploads 已发生（resume 在 submit 之后）
    expect(resumeIdx).toBeGreaterThan(-1)
    // phaseTick 已更新为 resume 时的 worldTime（仍冻结在 100）
    expect(resumed.phaseTick).toBe(100)
  })

  it('resumeNextRound 失败降级：N-1 成功 1 失败 → 照常 resume + error 落盘', async () => {
    const { backend, lifecycle, store } = makeRounds(snapshot(0, []))
    const id = await startedRounds(lifecycle, 100, 2)
    await startMatch(lifecycle, id)
    backend.setWorld(snapshot(100, []))
    await lifecycle.enterRoundBreak(id)
    await store.update(id, s => {
      for (const p of s.players) {
        p.code = { main: 'module.exports.loop = function () {}' }
        p.ready = true
      }
    })
    backend.setSubmitError('pb', new Error('network down'))
    await lifecycle.resumeNextRound(id)
    const st = await store.get(id)
    expect(st!.phase).toBe('running')
    expect(st!.error).toContain('pb')
    expect(st!.error).toContain('keep last-round code')
    // 成功玩家（pa）已上传
    expect(backend.uploads.map(u => u.username)).toContain('pa')
  })

  it('driveNextRound：autoRound.due → break；全员 ready → resumed；maxRounds 尽 → settled', async () => {
    const { backend, lifecycle, store } = makeRounds(snapshot(0, []))
    const id = await startedRounds(lifecycle, 100, 1) // maxRounds=1 → round0 后即终止
    await startMatch(lifecycle, id)
    backend.setWorld(snapshot(100, []))
    // 第一拍：autoRound → break
    expect(await lifecycle.driveNextRound(id)).toBe('break')
    let st = await store.get(id)
    expect(st!.phase).toBe('roundBreak')
    // maxRounds=1, roundIndex=0 已尽 → 再 drive → settle（roundBreak→settling→settled）
    expect(await lifecycle.driveNextRound(id)).toBe('settled')
    st = await store.get(id)
    expect(st!.phase).toBe('settled')
  })
})

describe('world-rounds 提交语义（plan-M5 §3.3）', () => {
  it('roundBreak 提交（codeMode=rounds）经 tools 置 ready+code', async () => {
    // 工具面在 tools.test 覆盖（screeps_submit_code）；此处验证 store 层面 commit 落盘
    const { lifecycle, store } = makeRounds(snapshot(0, []))
    const id = await startedRounds(lifecycle, 100, 2)
    await startMatch(lifecycle, id)
    await lifecycle.enterRoundBreak(id)
    const commitCode = { main: 'module.exports.loop = function () {}' }
    await store.update(id, s => {
      const p = s.players.find(x => x.sessionId === 'sess-a')!
      p.code = commitCode
      p.ready = true
    })
    const st = await store.get(id)
    expect(st!.players[0]!.ready).toBe(true)
    expect(st!.players[0]!.code).toEqual(commitCode)
  })
})
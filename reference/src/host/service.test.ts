/**
 * ScreepsService 生命周期语义单测（fake server，不碰私服）。
 *
 * 钉死 docs/spikes/m0-flake.md 第二节的孤儿进程根因与修复：
 * 1. disposer 必须返回 promise —— cordis runDisposable 只 await 返回的 thenable；
 * 2. dispose 早于 ensure 就绪时，shutdown 必须等 ensure 落地再停服；
 * 3. ensure 失败路径（waitReady 抛错）的半拉起组仍由 dispose 兜住；
 * 4. exit guard 随 server 生命周期注册/注销（宿主异常退出时 SIGKILL 整组）；
 * 5. exit guard 必须保持挂载到 stop() 完成——headless 宿主只给 5s dispose 宽限，
 *    stop() 的 autosave 窗口 (~10.5s) 内被强制退出时，guard 是最后的 SIGKILL 兜底
 *    （S14 实测：C2 headless 单任务退出后私服 6 进程全套孤儿，server.log 无 stopped）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { ScreepsService, type Config } from './service.ts'

/** vi.hoisted 共享态：mock 工厂与测试体都能读。 */
const h = vi.hoisted(() => ({
  launchCalls: 0,
  stopCalls: 0,
  holdInstaller: false,
  installerGateResolve: undefined as (() => void) | undefined,
  holdStop: false,
  stopGateResolve: undefined as (() => void) | undefined,
  waitReadyError: undefined as Error | undefined,
}))

vi.mock('../runtime/node-runtime.ts', () => ({
  ensureNodeRuntime: async () => ({ version: 'v22.23.2-fake', nodeBin: '/bin/true', binDir: '/bin' }),
}))

vi.mock('../runtime/server-installer.ts', () => ({
  ensureScreepsServer: async () => {
    if (h.holdInstaller) {
      await new Promise<void>(resolve => {
        h.installerGateResolve = resolve
      })
    }
  },
  readArenaSecret: async () => 'test-secret',
}))

vi.mock('../runtime/server-launcher.ts', () => ({
  launchScreepsServer: async () => {
    h.launchCalls++
    return {
      port: 30001,
      cliPort: 30002,
      // pid 取 pid_max 之外的值，保证 stop() 里的 process.kill(-pgid, 0) 恒 ESRCH
      child: { pid: 987_654_321, exitCode: null } as unknown as ChildProcess,
      waitReady: async () => {
        if (h.waitReadyError) throw h.waitReadyError
      },
      stop: async () => {
        h.stopCalls++
        if (h.holdStop) {
          await new Promise<void>(resolve => {
            h.stopGateResolve = resolve
          })
        }
      },
      isAlive: () => false,
    }
  },
}))

/** 单测环境无真私服：setTickDuration 放行（ensure 成功路径），pause 拒绝（跳过 stop 的 10.5s autosave 窗口）。 */
const goodFetch = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
  const body = typeof init?.body === 'string' ? init.body : ''
  const target = typeof url === 'string' ? url : String(url)
  if (body.includes('"cmd":"pause"')) throw new Error('pause disabled in unit test')
  if (target.includes('/api/arena/users')) {
    // 建号返回（match.start 需要 userId）
    return new Response(JSON.stringify({ ok: true, user: { id: 'uid-1', username: 'any' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (target.includes('/api/arena/world')) {
    // 世界快照（settle observe 需要）
    return new Response(
      JSON.stringify({ ok: true, gameTime: 5, users: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
})
vi.stubGlobal('fetch', goodFetch)

function makeConfig(): Config {
  return ScreepsService.Config({
    serverMode: 'managed',
    dataDir: mkdtempSync(join(tmpdir(), 'dsh-screeps-svc-')),
    externalUrl: 'http://127.0.0.1:21025',
    port: 30001,
    nodeVersion: '22',
    nodeDistMirror: 'https://nodejs.org/dist',
    tickDuration: 200,
    readyTimeoutMs: 180_000,
    agentRecruitTimeoutMs: 180_000,
  })
}

beforeEach(() => {
  h.launchCalls = 0
  h.stopCalls = 0
  h.holdInstaller = false
  h.installerGateResolve = undefined
  h.holdStop = false
  h.stopGateResolve = undefined
  h.waitReadyError = undefined
})

describe('ScreepsService lifecycle semantics (fake server)', () => {
  it('disposer awaits shutdown: fiber.dispose() does not settle until server.stop() completes', async () => {
    const exitListenersBefore = process.listenerCount('exit')
    const ctx = new Context()
    const fiber = await ctx.plugin(ScreepsService, makeConfig())
    const svc = ctx.screeps
    await svc.ensureRunning()
    expect(h.launchCalls).toBe(1)
    // 进程组已 spawn：exit guard 应在位
    expect(process.listenerCount('exit')).toBe(exitListenersBefore + 1)

    h.holdStop = true
    let disposeSettled = false
    const disposePromise = fiber.dispose().then(() => {
      disposeSettled = true
    })
    // stop 被调用且卡在 gate → dispose 正在等停服
    await vi.waitFor(() => expect(h.stopCalls).toBe(1))
    await new Promise(r => setTimeout(r, 20))
    // 回归断言：旧实现 `() => void this.shutdown()` 会在这里就 settled
    expect(disposeSettled).toBe(false)

    h.stopGateResolve!()
    await disposePromise
    expect(disposeSettled).toBe(true)
    expect(svc.getStatus().status).toBe('stopped')
    // exit guard 已随 shutdown 注销
    expect(process.listenerCount('exit')).toBe(exitListenersBefore)
  })

  it('exit guard stays armed while stop() is in flight (headless 5s force-exit safety)', async () => {
    const exitListenersBefore = process.listenerCount('exit')
    const ctx = new Context()
    const fiber = await ctx.plugin(ScreepsService, makeConfig())
    const svc = ctx.screeps
    await svc.ensureRunning()
    expect(h.launchCalls).toBe(1)
    expect(process.listenerCount('exit')).toBe(exitListenersBefore + 1)

    // stop() 卡在 autosave 窗口（10.5s 数据安全等待）这是 dsh headless 单任务
    // 只给 5s dispose 宽限后 forceExit 的命中窗口：guard 必须保持挂载，
    // 宿主 process.exit() 时 SIGKILL 兜底整组（S14 C2 实证：旧实现先在 stop() 前
    // removeExitGuard → 该窗口内宿主退出 → 私服 6 进程全套孤儿）。
    h.holdStop = true
    const disposePromise = fiber.dispose()
    await vi.waitFor(() => expect(h.stopCalls).toBe(1))
    expect(process.listenerCount('exit')).toBe(exitListenersBefore + 1) // 仍在位

    h.stopGateResolve!()
    await disposePromise
    expect(svc.getStatus().status).toBe('stopped')
    // 正常停服完成后 guard 注销
    expect(process.listenerCount('exit')).toBe(exitListenersBefore)
  })

  it('dispose during in-flight ensure: shutdown waits for ensure, then stops the launched group', async () => {
    h.holdInstaller = true
    const ctx = new Context()
    // init 只做快速校验，后台 ensure 卡在 installer gate
    const fiber = await ctx.plugin(ScreepsService, makeConfig())
    const svc = ctx.screeps
    await vi.waitFor(() => expect(h.installerGateResolve).toBeDefined())

    // ensure 仍在途时 dispose：shutdown 必须 await ensurePromise，
    // 否则此刻 server 未定义 → no-op → ensure 继续拉起 → 孤儿（stopCalls 恒 0）。
    const disposePromise = fiber.dispose()
    h.installerGateResolve!()
    h.holdInstaller = false

    await vi.waitFor(() => expect(h.launchCalls).toBe(1))
    await vi.waitFor(() => expect(h.stopCalls).toBe(1))
    await disposePromise
    expect(svc.getStatus().status).toBe('stopped')
  })

  it('ensure failure path (waitReady throws): dispose still stops the half-launched group', async () => {
    h.waitReadyError = new Error('not ready within 0ms (fake timeout)')
    const ctx = new Context()
    const fiber = await ctx.plugin(ScreepsService, makeConfig())
    const svc = ctx.screeps
    // ensure 失败时 ensureRunning 直接抛出原始错误（await this.ensurePromise 透传）
    await expect(svc.ensureRunning()).rejects.toThrow(/fake timeout/)
    expect(svc.getStatus().status).toBe('failed')
    expect(h.launchCalls).toBe(1) // 组已拉起

    h.holdStop = true
    const disposePromise = fiber.dispose()
    await vi.waitFor(() => expect(h.stopCalls).toBe(1))
    h.stopGateResolve!()
    await disposePromise
    expect(svc.getStatus().status).toBe('stopped')
  })

  it('system() throws on ok:false so half-executed commands cannot pass silently', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(ScreepsService, makeConfig())
    const svc = ctx.screeps
    await svc.ensureRunning()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: 'addAccessibleRoom is not defined' }), { status: 400 })),
    )
    try {
      await expect(svc.system('generateRoom', 'W48N49')).rejects.toThrow(/addAccessibleRoom is not defined/)
    } finally {
      vi.stubGlobal('fetch', goodFetch)
    }
    await fiber.dispose()
  })

  it('M4-C assembly: exposes tournament service, admission gate, history/replay stores and runs boot recovery', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(ScreepsService, makeConfig())
    const svc = ctx.screeps
    // 装配面存在且指向同一 dataDir
    expect(svc.tournaments).toBeDefined()
    expect(svc.admission).toBeDefined()
    expect(svc.historyStore).toBeDefined()
    expect(svc.replayStore).toBeDefined()
    // init 的 RecoveryCoordinator 已跑（空目录 → 无中断、锁已释放）
    await expect(svc.admission.assertIdle()).resolves.toBeUndefined()
    await fiber.dispose()
    expect(svc.getStatus().status).toBe('stopped')
  })

  it('M4-C assembly: settlement drivers wired — ordinary settle writes history store and cleanup is committed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(ScreepsService, makeConfig())
    const svc = ctx.screeps
    // 直接建普通局并 settle（fake backend world 空 → draw）
    const m = await svc.match.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'u1' })
    await svc.match.join(m.id, { sessionId: 's2', username: 'u2' })
    await svc.match.start(m.id)
    const settled = await svc.match.settle(m.id, 'manual')
    expect(settled.phase).toBe('settled')
    // history driver 已装配：MatchResult 落盘（无 participantId → 不进 leaderboard）
    const result = await svc.historyStore.get(m.id)
    expect(result?.resultId).toBe(m.id)
    expect(result?.participantSnapshot.every(p => p.participantId === undefined)).toBe(true)
    // cleanup committed（普通局 dispose hook 空跑成功）
    const latest = await svc.match.store.get(m.id)
    expect(latest!.settlement?.cleanup.status).toBe('committed')
    await fiber.dispose()
  })
})

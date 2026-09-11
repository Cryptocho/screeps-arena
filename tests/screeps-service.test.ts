/**
 * S1 ScreepsService 单测（fake 进程面）——生命周期状态机与坑平移断言。
 * 真实启动走 tests/screeps-live.it.test.ts（test:live lane）。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

// mock runtime 三件套：不下载 node、不 npm install、不 spawn 进程
vi.mock('../src/server/screeps/node-runtime.js', () => ({
  ensureNodeRuntime: vi.fn(async () => ({
    nodeBin: '/fake/node', npmBin: '/fake/npm', npxBin: '/fake/npx',
    binDir: '/fake/bin', version: 'v22.23.2', source: 'portable' as const,
  })),
}))
vi.mock('../src/server/screeps/server-installer.js', () => ({
  ensureScreepsServer: vi.fn(async () => ({
    serverDir: '/fake/server', nodeModules: '/fake/server/node_modules',
    artifacts: [], screepsVersion: '4.3.0', installSkipped: true,
  })),
  readArenaSecret: vi.fn(async () => 'secret-123'),
}))
const fakeServer = {
  port: 0, cliPort: 0, child: { pid: 4242 },
  waitReady: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  isAlive: () => true,
}
vi.mock('../src/server/screeps/server-launcher.js', () => ({
  launchScreepsServer: vi.fn(async () => fakeServer),
}))

import * as http from 'node:http'
import { ScreepsService, modFileFromContent } from '../src/server/screeps/service.js'

/** 假 arena HTTP 端点：system 命令打表回 ok:true。返回真实端口供 baseUrl 用。 */
async function startFakeArena(): Promise<{ port: number; close: () => Promise<void>; cmds: string[] }> {
  const cmds: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { cmd?: string }
        if (parsed.cmd) cmds.push(parsed.cmd)
      } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { port, cmds, close: () => new Promise((r) => server.close(() => r())) }
}

let arena: Awaited<ReturnType<typeof startFakeArena>>
beforeAll(async () => {
  arena = await startFakeArena()
  fakeServer.port = arena.port
  fakeServer.cliPort = arena.port + 1
})
afterAll(async () => {
  await arena.close()
})

describe('ScreepsService（fake 进程面）', () => {
  it('ensureRunning：provision→running，setTickDuration 走直连（ensure 链内不自死锁）', async () => {
    const logs: string[] = []
    const svc = new ScreepsService({ dataDir: '/tmp/fake-data', tickDuration: 100 }, (m, ...a) => logs.push(m.replace(/%s/g, () => String(a.shift()))))
    // 拦截 arenaFetchDirect：验证 setTickDuration 在 waitReady 之后、不经 ensureRunning
    const calls: Array<{ path: string; body?: unknown }> = []
    // @ts-expect-error 测试窥探私有方法
    const orig = svc.arenaFetchDirect.bind(svc)
    // @ts-expect-error 同上
    svc.arenaFetchDirect = async (p: string, init?: RequestInit) => {
      calls.push({ path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return { ok: true }
    }
    const { port, baseUrl } = await svc.ensureRunning()
    expect(port).toBe(arena.port)
    expect(baseUrl).toBe(`http://127.0.0.1:${arena.port}`)
    expect(svc.currentStatus).toBe('running')
    expect(calls).toEqual([{ path: '/api/arena/system', body: { cmd: 'setTickDuration', value: 100 } }])
    // 幂等：第二次直接返回，不再 ensure
    const again = await svc.ensureRunning()
    expect(again.port).toBe(arena.port)
    expect(fakeServer.waitReady).toHaveBeenCalledTimes(1)
  })

  it('ensure 失败：status=failed + statusDetail 落盘，ensurePromise 清位（可重试）', async () => {
    const { launchScreepsServer } = await import('../src/server/screeps/server-launcher.js')
    const { ensureScreepsServer } = await import('../src/server/screeps/server-installer.js')
    vi.mocked(ensureScreepsServer).mockRejectedValueOnce(new Error('npm install exploded'))
    const svc = new ScreepsService({ dataDir: '/tmp/fake-data2' })
    await expect(svc.ensureRunning()).rejects.toThrow('npm install exploded')
    expect(svc.currentStatus).toBe('failed')
    expect(svc.statusDetailText).toContain('npm install exploded')
    // 重试路径：installer 恢复正常 → running
    await expect(svc.ensureRunning()).resolves.toMatchObject({ port: arena.port })
    expect(launchScreepsServer).toHaveBeenCalled()
  })

  it('shutdown：先等在途 ensure，再 stop，最后注销 exit guard；幂等', async () => {
    const svc = new ScreepsService({ dataDir: '/tmp/fake-data3' })
    await svc.ensureRunning()
    const exitOff = vi.spyOn(process, 'off')
    await svc.shutdown()
    expect(fakeServer.stop).toHaveBeenCalledTimes(1)
    expect(svc.currentStatus).toBe('stopped')
    // exit guard 被注销（process.off('exit', fn) 被调用）
    expect(exitOff.mock.calls.some(([ev]) => ev === 'exit')).toBe(true)
    // 幂等：再 shutdown 不再 stop
    await svc.shutdown()
    expect(fakeServer.stop).toHaveBeenCalledTimes(1)
    exitOff.mockRestore()
  })

  it('restart：stop → ensureRunning → resume（地形缓冲坑的平移语义）', async () => {
    const svc = new ScreepsService({ dataDir: '/tmp/fake-data4' })
    await svc.ensureRunning()
    const calls: string[] = []
    const svcAny = svc as unknown as {
      system: (cmd: string, value?: unknown) => Promise<Record<string, unknown>>
      arenaFetchDirect: (p: string, init?: RequestInit) => Promise<unknown>
    }
    const origSystem = svcAny.system.bind(svc)
    svcAny.system = async (cmd, value) => {
      calls.push(cmd)
      return await origSystem(cmd, value)
    }
    svcAny.arenaFetchDirect = async (p, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (body.cmd) calls.push(body.cmd)
      return { ok: true }
    }
    fakeServer.stop.mockClear()
    await svc.restart()
    expect(fakeServer.stop).toHaveBeenCalledTimes(1)
    expect(calls).toContain('resume')
    expect(arena.cmds).toContain('resume')
    expect(svc.currentStatus).toBe('running')
  })

  it('getTerrain 边界：rooms 空/超 64 拒绝（不触网）', async () => {
    const svc = new ScreepsService({ dataDir: '/tmp/fake-data5' })
    await expect(svc.getTerrain([])).rejects.toThrow('1..64')
    await expect(svc.getTerrain(new Array(65).fill('W1N1'))).rejects.toThrow('1..64')
  })

  it('modFileFromContent：平名校验', () => {
    expect(modFileFromContent('arena-mod.cjs', 'x')).toEqual({ name: 'arena-mod.cjs', content: 'x' })
    expect(() => modFileFromContent('a/b.cjs', 'x')).toThrow('flat')
    expect(() => modFileFromContent('..', 'x')).toThrow('flat')
  })
})

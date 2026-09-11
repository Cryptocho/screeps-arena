/**
 * S13 工具面单测：会话映射（公平边界）+ 工具行为（直接调用 execute，绕过注册管线）。
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { join } from 'node:path'
import { buildTools, requireUser, resolveBinding } from './tools.ts'
import { MatchService } from './match/match-service.ts'
import type { ScreepsService, ScreepsWorldSnapshot } from './service.ts'

const WORLD: ScreepsWorldSnapshot = {
  ok: true,
  gameTime: 1000,
  users: [
    { id: 'uid-a', username: 'e2e_a', isBot: true, cpu: 2, gcl: 0, ownedRooms: 1, rclTotal: 1, spawns: 1, rooms: [{ room: 'W45N74', level: 1, progress: 12 }] },
    { id: 'uid-b', username: 'e2e_b', isBot: true, cpu: 3, gcl: 0, ownedRooms: 1, rclTotal: 1, spawns: 1, rooms: [{ room: 'W68N70', level: 1, progress: 0 }] },
  ],
}

function makeService(overrides: Partial<ScreepsService> = {}): ScreepsService {
  const state = {
    submitted: [] as Array<{ username: string; modules: Record<string, string> }>,
    memoryWrites: [] as Array<{ username: string; value: unknown; path?: string }>,
    consoleFired: [] as string[],
    events: [] as unknown[],
    consoleLines: [] as unknown[],
  }
  const svc = {
    ensureRunning: async () => ({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
    getWorld: async () => WORLD,
    system: async (cmd: string) => (cmd === 'getTickDuration' ? { ok: true, tickDuration: 150 } : { ok: true }),
    createUser: async (input: { username: string }) => ({ id: 'uid-' + input.username, username: input.username }),
    restart: async () => {},
    eventLog: async (since?: number) => {
      const from = typeof since === 'number' && since >= 0 ? since : 0
      return { events: state.events.slice(from), cursor: state.events.length, bound: true }
    },
    submitCode: async (username: string, modules: Record<string, string>) => {
      state.submitted.push({ username, modules })
      return { timestamp: 123 }
    },
    runConsole: async (username: string) => {
      state.consoleFired.push(username)
      return 'ok'
    },
    consoleOutput: async (username: string, since: number) => {
      if (state.consoleLines.length > 0 && since < state.consoleLines.length) {
        return { lines: state.consoleLines.slice(since), cursor: state.consoleLines.length, bound: true }
      }
      return since === 0 && state.consoleFired.includes(username)
        ? { lines: [{ messages: ['hello from console'] }], cursor: 1, bound: true }
        : { lines: [], cursor: since, bound: true }
    },
    readMemoryPath: async () => ({
      data: 'gz:' + zlib.gzipSync(JSON.stringify({ stats: { tick: 7 } })).toString('base64'),
    }),
    writeMemory: async (username: string, value: unknown, path?: string) => {
      state.memoryWrites.push({ username, value, path })
    },
    ...overrides,
  } as unknown as ScreepsService
  ;(svc as unknown as { __state: typeof state }).__state = state
  return svc
}

function makeMatchService(svc: ScreepsService): MatchService {
  const matches = new MatchService(svc, join(tmpdir(), 'dsh-screeps-tools-' + Math.random().toString(36).slice(2, 8)), () => {})
  ;(svc as unknown as { match: MatchService }).match = matches
  return matches
}

function makeExec(sessionId?: string) {
  return { agent: sessionId ? { id: sessionId } : undefined, signal: new AbortController().signal } as never
}

function findTool(svc: ScreepsService, name: string): { execute: (args: unknown, exec: unknown) => Promise<unknown> } {
  if (!(svc as unknown as { match?: MatchService }).match) makeMatchService(svc)
  const tools = buildTools(svc) as Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>
  const tool = tools.find(t => t.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return tool
}

describe('screeps session mapping (fair boundary)', () => {
  it('has no binding before match participation', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const binding = await resolveBinding(matches, 'sess-x')
    expect(binding).toBeUndefined()
    await expect(requireUser(svc, 'sess-x')).rejects.toThrow(/no bound Screeps user/)
  })

  it('binds session → username via match create/join', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const created = await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'user_new' })
    await matches.join(created.id, { sessionId: 'sess-2', username: 'other_user' })
    await matches.start(created.id)

    const binding = await resolveBinding(matches, 'sess-1')
    expect(binding?.username).toBe('user_new')
    expect(binding?.matchPhase).toBe('running')
    const other = await resolveBinding(matches, 'sess-2')
    expect(other?.username).toBe('other_user')
  })
})

describe('screeps tools', () => {
  it('exposes the full tool face', () => {
    const names = (buildTools(makeService()) as Array<{ name: string }>).map(t => t.name)
    expect(names).toEqual([
      'screeps_world_status',
      'screeps_report',
      'screeps_wait',
      'screeps_submit_code',
      'screeps_console',
      'screeps_read_memory',
      'screeps_write_memory',
      'screeps_match',
    ])
  })

  it('world_status works without a session binding', async () => {
    const svc = makeService()
    const result = (await findTool(svc, 'screeps_world_status').execute({}, makeExec())) as { text: string }
    expect(result.text).toContain('gameTime=1000')
    expect(result.text).toContain('e2e_a')
  })

  it('screeps_wait returns once the world advances past the target tick (P0 审查提示6: 补行为覆盖)', async () => {
    // getWorld 每次调用 ++gameTime → wait 循环推进后命中 target
    let gt = 1000
    const svc = makeService({
      getWorld: async () => ({ ok: true, gameTime: gt++, users: [] }),
    })
    const result = (await findTool(svc, 'screeps_wait').execute({ ticks: 3 }, makeExec('sess-w'))) as {
      text: string
      gameTime: number
    }
    expect(result.gameTime).toBeGreaterThanOrEqual(1003)

    // abort → 抛 aborted（exec.signal 取消语义）
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      findTool(svc, 'screeps_wait').execute({ ticks: 3 }, { agent: { id: 'sess-w2' }, signal: ctrl.signal } as never),
    ).rejects.toThrow(/aborted/)

    // 无 ticks 无 seconds → 拒
    await expect(findTool(svc, 'screeps_wait').execute({}, makeExec('sess-w3'))).rejects.toThrow(/provide ticks or seconds/)
  })

  it('report binds via session and shows you-marker', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const created = await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join(created.id, { sessionId: 'sess-2', username: 'e2e_b' })
    await matches.start(created.id)

    const report = findTool(svc, 'screeps_report')
    const first = (await report.execute({}, makeExec('sess-1'))) as { text: string }
    expect(first.text).toContain('boundUser=e2e_a')
    expect(first.text).toContain('(you)')
    const second = (await report.execute({}, makeExec('sess-1'))) as { text: string }
    expect(second.text).toContain('delta=')
  })

  it('report includes my-sight event digest, error count and cpu trend (M2 D)', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const created = await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join(created.id, { sessionId: 'sess-2', username: 'e2e_b' })
    await matches.start(created.id)

    // 注入：我方房间的 DESTROYED（我=uid-a）+ 我方受击 ATTACK + 无关房间事件（应被过滤）
    ;(svc as unknown as { __state: { events: unknown[] } }).__state.events = [
      { tick: 10, eventsByRoom: { W45N74: [{ event: 2, objectId: 'mine', attackerUser: 'uid-b', data: {} }] } },
      { tick: 10, eventsByRoom: { W45N74: [{ event: 1, objectId: 'foe', attackerUser: 'uid-b', targetUser: 'uid-a', data: {} }] } },
      { tick: 10, eventsByRoom: { W99N99: [{ event: 1, objectId: 'a', attackerUser: 'uid-b', targetUser: 'uid-c', data: {} }] } },
    ]
    ;(svc as unknown as { __state: { consoleLines: unknown[] } }).__state.consoleLines = [
      { userId: 'uid-a', error: 'ReferenceError: boom' },
    ]

    const reportTool = findTool(svc, 'screeps_report')
    const report = (await reportTool.execute({}, makeExec('sess-1'))) as { text: string }
    expect(report.text).toContain('events(inSight): involved=2 attack=1 destroyed=1 other=0') // 无关房被滤
    expect(report.text).toContain('errors: 1 — ReferenceError: boom')
    // 第二次调用（同一工具实例 → 增量游标）：不再重复 digest/errors
    const again = (await reportTool.execute({}, makeExec('sess-1'))) as { text: string }
    expect(again.text).not.toContain('events(inSight)')
    expect(again.text).not.toContain('errors:')
  })

  it('submit_code requires modules.main and forwards to the bound user', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    const submit = findTool(svc, 'screeps_submit_code')

    await expect(
      submit.execute({ modules: { notMain: '' } }, makeExec('sess-1')),
    ).rejects.toThrow(/modules\.main/)

    // A0 暂存式 submit：creating 阶段不直调 svc.submitCode（未建号 404），暂存进 MatchPlayer.code + submitted
    const result = (await submit.execute(
      { modules: { main: 'module.exports.loop = function () {}' } },
      makeExec('sess-1'),
    )) as { text: string }
    expect(result.text).toContain('e2e_a')
    expect(result.text).toContain('staged')
    expect((svc as unknown as { __state: { submitted: unknown[] } }).__state.submitted).toHaveLength(0)
    const staged = (await matches.store.get((await matches.store.list())[0]!.id))!
    expect(staged.players[0]!.code).toEqual({ main: 'module.exports.loop = function () {}' })
    expect(staged.players[0]!.submitted).toBe(true)
    // 结构非法脚本（无 module.exports.loop）拒暂存
    await expect(
      submit.execute({ modules: { main: 'module.exports = function () {}' } }, makeExec('sess-1')),
    ).rejects.toThrow(/module\.exports\.loop/)
  })

  it('submit_code hot-updates via svc.submitCode once the match is running', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    // live 热更语义（仅 arena-blitz 承载；world-rounds running 拒 submit）
    await matches.createMatch({ preset: 'arena-blitz', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join((await matches.store.list())[0]!.id, { sessionId: 'sess-2', username: 'e2e_b' })
    await matches.start((await matches.store.list())[0]!.id)
    const submit = findTool(svc, 'screeps_submit_code')
    const result = (await submit.execute(
      { modules: { main: 'module.exports.loop = function () {}' } },
      makeExec('sess-1'),
    )) as { text: string }
    expect(result.text).toContain('e2e_a')
    expect((svc as unknown as { __state: { submitted: unknown[] } }).__state.submitted).toHaveLength(1)
    expect((svc as unknown as { __state: { submitted: Array<{ username: string }> } }).__state.submitted[0]!.username).toBe('e2e_a')
  })

  it('console fires and captures output lines', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    const consoleTool = findTool(svc, 'screeps_console')
    const result = (await consoleTool.execute({ expression: 'Game.time' }, makeExec('sess-1'))) as { text: string }
    expect(result.text).toContain('hello from console')
  })

  it('read_memory decodes gz payload', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    const tool = findTool(svc, 'screeps_read_memory')
    const result = (await tool.execute({}, makeExec('sess-1'))) as { text: string; value: { stats: { tick: number } } }
    expect(result.value.stats.tick).toBe(7)
  })

  it('write_memory forwards value and path', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    const tool = findTool(svc, 'screeps_write_memory')
    await tool.execute({ value: { a: 1 }, path: 'stats.x' }, makeExec('sess-1'))
    const state = (svc as unknown as { __state: { memoryWrites: Array<{ path?: string }> } }).__state
    expect(state.memoryWrites[0]?.path).toBe('stats.x')
  })

  it('match tool: create/join/observe and creator-only settle', async () => {
    const svc = makeService()
    const tool = findTool(svc, 'screeps_match')

    const created = (await tool.execute(
      { action: 'create', preset: 'world-rounds', username: 'e2e_a' },
      makeExec('creator-1'),
    )) as { match: { id: string } }
    const matchId = created.match.id

    await tool.execute(
      { action: 'join', matchId, username: 'e2e_b' },
      makeExec('other-2'),
    )

    // 非 creator 不能 start
    await expect(
      tool.execute({ action: 'start', matchId }, makeExec('other-2')),
    ).rejects.toThrow(/only the creator/)

    const started = (await tool.execute({ action: 'start', matchId }, makeExec('creator-1'))) as { match: { phase: string } }
    expect(started.match.phase).toBe('running')

    const observation = (await tool.execute({ action: 'observe', matchId }, makeExec('creator-1'))) as { text: string }
    expect(observation.text).toContain('(you)')

    const settled = (await tool.execute(
      { action: 'settle', matchId, reason: 'manual' },
      makeExec('creator-1'),
    )) as { match: { phase: string } }
    expect(settled.match.phase).toBe('settled')

    // 非 creator 不能 settle（新对局验证）
    const created2 = (await tool.execute(
      { action: 'create', preset: 'world-rounds', username: 'e2e_a' },
      makeExec('creator-1'),
    )) as { match: { id: string } }
    await tool.execute({ action: 'join', matchId: created2.match.id, username: 'e2e_b' }, makeExec('other-2'))
    await tool.execute({ action: 'start', matchId: created2.match.id }, makeExec('creator-1'))
    await expect(
      tool.execute({ action: 'settle', matchId: created2.match.id, reason: 'manual' }, makeExec('other-2')),
    ).rejects.toThrow(/only the creator/)
  })

  it('submit_code is rejected in frozen presets and allowed in live', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const frozen = await matches.createMatch({ preset: 'world-frozen', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join(frozen.id, { sessionId: 'sess-2', username: 'e2e_b' })
    await matches.start(frozen.id)
    const submit = findTool(svc, 'screeps_submit_code')
    await expect(
      submit.execute({ modules: { main: 'module.exports.loop = function () {}' } }, makeExec('sess-1')),
    ).rejects.toThrow(/freezes code/)
    await matches.settle(frozen.id, 'manual')

    const live = await matches.createMatch({ preset: 'arena-blitz', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join(live.id, { sessionId: 'sess-2', username: 'e2e_b' })
    await matches.start(live.id)
    const result = (await submit.execute(
      { modules: { main: 'module.exports.loop = function () {}' } },
      makeExec('sess-1'),
    )) as { text: string }
    expect(result.text).toContain('submitted')
  })

  it('screeps_match create/join reject __bot__ reserved names', async () => {
    const svc = makeService()
    const tool = findTool(svc, 'screeps_match')
    await expect(
      tool.execute({ action: 'create', username: '__bot_harvester' }, makeExec('sess-x')),
    ).rejects.toThrow(/__bot__/)
  })

  it('submit_code in world-rounds: roundBreak commit=ready, running rejected (M5 §3.3)', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const created = await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join(created.id, { sessionId: 'sess-2', username: 'e2e_b' })
    const submit = findTool(svc, 'screeps_submit_code')
    // creating：A0 暂存（submitted=true），与 live 同构
    const staged = (await submit.execute(
      { modules: { main: 'module.exports.loop = function () {}' } },
      makeExec('sess-1'),
    )) as { staged?: boolean }
    expect(staged.staged).toBe(true)
    // start → running：周期内拒提交
    await matches.start(created.id)
    await expect(
      submit.execute({ modules: { main: 'module.exports.loop = function () {}' } }, makeExec('sess-1')),
    ).rejects.toThrow(/frozen during a round/)
    // 进入 roundBreak：commit = 就绪（code 更新 + ready=true），不传私服（services.submitCode 未被调）
    await (matches.lifecycle as unknown as { enterRoundBreak(id: string): Promise<unknown> }).enterRoundBreak(created.id)
    const committed = (await submit.execute(
      { modules: { main: 'module.exports.loop = function () { /* round1 */ }' } },
      makeExec('sess-1'),
    )) as { text: string }
    expect(committed.text).toContain('round break')
    const st = await matches.store.get(created.id)
    const p1 = st!.players.find(p => p.sessionId === 'sess-1')!
    expect(p1.ready).toBe(true)
    expect(p1.code!.main).toContain('round1')
    // 未走 svc.submitCode（commit 只暂存，resume 才上传）
    expect((svc as unknown as { __state: { submitted: unknown[] } }).__state.submitted).toHaveLength(0)
  })

  it('screeps_match pause/resume/observe require being a player of the match', async () => {
    const svc = makeService()
    const tool = findTool(svc, 'screeps_match')
    const created = (await tool.execute(
      { action: 'create', preset: 'world-rounds', username: 'e2e_a' },
      makeExec('creator-1'),
    )) as { match: { id: string } }
    const matchId = created.match.id
    await tool.execute({ action: 'join', matchId, username: 'e2e_b' }, makeExec('other-2'))
    await tool.execute({ action: 'start', matchId }, makeExec('creator-1'))

    // 非玩家会话不能 pause/resume/observe
    for (const action of ['pause', 'resume', 'observe'] as const) {
      await expect(tool.execute({ action, matchId }, makeExec('stranger'))).rejects.toThrow(/only players/)
    }
    // 玩家可以 observe
    const obs = (await tool.execute({ action: 'observe', matchId }, makeExec('creator-1'))) as { text: string }
    expect(obs.text).toContain('(you)')
  })

  it('screeps_match does NOT expose addBot (2026-09-09: 对局参与者只能是 Agent；测试 bot 走内部链路)', async () => {
    const svc = makeService()
    const created = (await findTool(svc, 'screeps_match').execute(
      { action: 'create', preset: 'world-rounds', username: 'e2e_a' },
      makeExec('creator-1'),
    )) as { match: { id: string } }
    const matchId = created.match.id

    // addBot action 在 schema enum 校验就被拒（invalid arguments 列出的合法 action 无 addBot）
    await expect(
      findTool(svc, 'screeps_match').execute({ action: 'addBot', matchId, bot: 'harvester' }, makeExec('creator-1')),
    ).rejects.toThrow(/must be one of/)
  })
})

describe('screeps_submit_code — M4 round-token gate', () => {
  const roundCode = { main: 'module.exports.loop = function () { console.log("hi") }' }
  const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

  function makeRoundMatch(svc: ScreepsService, token: string) {
    const matches = makeMatchService(svc)
    return matches.store
      .createTournament({
        tournamentId: 't1',
        slotId: 'r1s0',
        attempt: 0,
        roundTokenHash: sha256(token),
        players: [
          { sessionId: 'sess-p0', username: 'u_p0', participantId: 'p0' },
          { sessionId: 'sess-p1', username: 'u_p1', participantId: 'p1' },
        ],
      })
      .then(m => {
        void m
        return matches
      })
  }

  it('accepts staged round code only with the matching roundToken', async () => {
    const svc = makeService()
    const matches = await makeRoundMatch(svc, 'rt-secret-1')
    const matchId = (await matches.store.active())!.id
    const submit = findTool(svc, 'screeps_submit_code')
    // 缺 token → 拒
    await expect(submit.execute({ modules: roundCode }, makeExec('sess-p0'))).rejects.toThrow(/roundToken/)
    // 错 token → 拒
    await expect(submit.execute({ modules: roundCode, roundToken: 'wrong' }, makeExec('sess-p0'))).rejects.toThrow(/roundToken/)
    // 对 token → 暂存成功 + submitted
    const ok = (await submit.execute({ modules: roundCode, roundToken: 'rt-secret-1' }, makeExec('sess-p0'))) as { text: string; staged?: boolean }
    expect(ok.staged).toBe(true)
    const m = (await matches.store.get(matchId))!
    expect(m.players.find(p => p.sessionId === 'sess-p0')!.submitted).toBe(true)
    expect(m.players.find(p => p.sessionId === 'sess-p0')!.code).toEqual(roundCode)
  })

  it('rejects submit once the round match left creating (placing/running/paused/settling)', async () => {
    const svc = makeService()
    const matches = await makeRoundMatch(svc, 'rt-secret-2')
    const matchId = (await matches.store.active())!.id
    await matches.store.transition(matchId, 'placing')
    const submit = findTool(svc, 'screeps_submit_code')
    await expect(submit.execute({ modules: roundCode, roundToken: 'rt-secret-2' }, makeExec('sess-p0'))).rejects.toThrow(/submit window/)
  })

  it('ordinary live matches do NOT require roundToken (M3 regression)', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    const submit = findTool(svc, 'screeps_submit_code')
    const ok = (await submit.execute({ modules: { main: 'module.exports.loop = function () {}' } }, makeExec('sess-1'))) as { staged?: boolean }
    expect(ok.staged).toBe(true) // creating 阶段暂存不受 round 校验影响
  })
})

describe('screeps_submit_code — M6 记录点（plan-M6 §3.1 code-log）', () => {
  const LOOP = 'module.exports.loop = function () {}'

  it('records point 2 (creating stage) and point 1 (roundBreak commit) for world-rounds', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const created = await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join(created.id, { sessionId: 'sess-2', username: 'e2e_b' })
    const submit = findTool(svc, 'screeps_submit_code')
    // 点 2：creating 暂存
    await submit.execute({ modules: { main: LOOP } }, makeExec('sess-1'))
    // 点 1：roundBreak commit（产品路径 enterRoundBreak，与 drive 循环同构）
    await matches.start(created.id)
    await matches.lifecycle.enterRoundBreak(created.id)
    await submit.execute({ modules: { main: LOOP + ' /* round1 */' } }, makeExec('sess-1'))
    const list = await matches.codeLog.list(created.id)
    // e2e_a 三条：creating 暂存 → start 注入（v0 落服）→ roundBreak commit；
    // seq 是 per-match 全局计数（e2e_b 的注入条目排在中间占 seq3 → e2e_a 最后一条 = 4）
    const mine = list.versions.filter(v => v.username === 'e2e_a')
    expect(mine.map(v => [v.seq, v.phase, v.source])).toEqual([
      [1, 'creating', 'agent-submit'],
      [2, 'placing', 'start-injected'],
      [4, 'roundBreak', 'agent-submit'],
    ])
    expect(mine[2]!.roundIndex).toBe(0)
    expect(list.versions).toHaveLength(4)
    // 公平兜底：流水文件全文不含 sessionId
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const raw = await readFile(join(matches.store.dir, created.id, 'codes.jsonl'), 'utf8')
    expect(raw).not.toContain('sessionId')
    expect(raw).not.toContain('sess-1')
  })

  it('records point 3 (live direct hot-update) for arena-blitz running phase', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const created = await matches.createMatch({ preset: 'arena-blitz', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join(created.id, { sessionId: 'sess-2', username: 'e2e_b' })
    await matches.start(created.id)
    const submit = findTool(svc, 'screeps_submit_code')
    const hot = { main: LOOP + ' /* hot */' }
    await submit.execute({ modules: hot }, makeExec('sess-1'))
    // live 直传确实走了 svc.submitCode（host 状态不留副本 → 流水是唯一观战数据源）
    expect((svc as unknown as { __state: { submitted: unknown[] } }).__state.submitted).toHaveLength(1)
    const list = await matches.codeLog.list(created.id)
    // 两座位 start 注入（点 4）+ e2e_a live 直传（点 3）
    expect(list.versions.map(v => [v.username, v.phase, v.source])).toEqual([
      ['e2e_a', 'placing', 'start-injected'],
      ['e2e_b', 'placing', 'start-injected'],
      ['e2e_a', 'running', 'agent-submit'],
    ])
    const entry = await matches.codeLog.getEntry(created.id, 'e2e_a', 3)
    expect(entry?.modules).toEqual(hot)
  })

  it('records point 4 (start-injected code v0) for every seat, phase=placing', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const created = await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-1', username: 'e2e_a' })
    await matches.join(created.id, { sessionId: 'sess-2', username: 'e2e_b' })
    // 玩家 1 有暂存脚本，玩家 2 空壳（EMPTY_CODE 注入）——两座位都记录
    await findTool(svc, 'screeps_submit_code').execute({ modules: { main: LOOP } }, makeExec('sess-1'))
    await matches.start(created.id)
    const list = await matches.codeLog.list(created.id)
    // e2e_a：creating 暂存 + start 注入；e2e_b：仅空壳注入（EMPTY_CODE v0）
    expect(list.versions.map(v => [v.username, v.phase, v.source])).toEqual([
      ['e2e_a', 'creating', 'agent-submit'],
      ['e2e_a', 'placing', 'start-injected'],
      ['e2e_b', 'placing', 'start-injected'],
    ])
    const empty = await matches.codeLog.getEntry(created.id, 'e2e_b', 3) // 全局 seq：e2e_a 占 1/2
    expect(empty?.modules).toEqual({ main: LOOP }) // EMPTY_CODE 形状
  })

  it('records tournament (codeMode=round) creating submits via the same staging branch', async () => {
    const svc = makeService()
    const matches = makeMatchService(svc)
    const token = 'rt-m6-log'
    await matches.store.createTournament({
      tournamentId: 't1',
      slotId: 'r1s0',
      attempt: 0,
      roundTokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      players: [
        { sessionId: 'sess-p0', username: 'u_p0', participantId: 'p0' },
        { sessionId: 'sess-p1', username: 'u_p1', participantId: 'p1' },
      ],
    })
    const matchId = (await matches.store.active())!.id
    await findTool(svc, 'screeps_submit_code').execute(
      { modules: { main: LOOP }, roundToken: token },
      makeExec('sess-p0'),
    )
    const list = await matches.codeLog.list(matchId)
    expect(list.versions).toMatchObject([{ username: 'u_p0', phase: 'creating', source: 'agent-submit' }])
  })
})

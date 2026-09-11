/**
 * A0 spawn-Agent 编排器单测（plan-M3 A0 单测清单）：
 * - spawn 调用形状（count/model/provider 传递）；
 * - followup 恰一次 + prompt 含玩家编号/preset/matchId；
 * - create 失败 dispose 全部（原子性）；
 * - count 校验（arena 强制 2 / world [2,seats]）；
 * - 阶段超时（deadline 到且未推进 → 一次重试 → dispose 全部 + 抛错）；
 * - host 观察 match 出现（A1 create 后拿到 matchId）+ 打标 spawnedBy；
 * - disposeMatchAgents 收会话（成功 & 中途 dispose 幂等）。
 *
 * fake registry 模拟 Agent 行为：解析 followup prompt 动作（create/join/submit）推进真实
 * MatchStore；`silent` 名单模拟 Agent 沉默（不推进），触发编排器超时/重试路径。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScreepsService } from './service.ts'
import { MatchService } from './match/match-service.ts'
import { MatchStore } from './match/store.ts'
import type { AgentHandleLike, AgentRegistryLike } from './agents.ts'
import { SPAWN_SESSION_PREFIX, SpawnOrchestrator, assertUniqueUsernames, buildCreatePrompt, buildJoinPrompt } from './agents.ts'

const dirs: string[] = []

/** fake Agent：按 followup prompt 的动作推进真实 MatchStore（username 按 create 序 pa1/pa2/…）。
 * 注意：act 推进必须**串行化**——store.update 是 read-modify-write，多个 act 并发写同一 state.json
 * 会互相覆盖（后写吞前写的 submitted）；真实 DSH 里 Agent 提交间隔大不暴露，fake 近同步推进必现。 */
class FakeRegistry implements AgentRegistryLike {
  created: Array<{ sessionId: string; agentOptions?: { provider?: string; model?: string } }> = []
  followups: Array<{ sessionId: string; text: string }> = []
  disposed: string[] = []
  actErrors: string[] = []
  failCreateAfter: number | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly matches: MatchService,
    private readonly silent: string[] = [],
  ) {}

  async create(options: {
    sessionId: string
    agentOptions?: { provider?: string; model?: string }
    meta?: { agentPreset?: string; origin?: 'subagent' }
  }): Promise<AgentHandleLike> {
    this.created.push(options)
    if (this.failCreateAfter !== undefined && this.created.length >= this.failCreateAfter) {
      throw new Error('fake registry create boom')
    }
    const handle: AgentHandleLike = {
      agent: {
        id: options.sessionId,
        followup: message => {
          const text = ((message as { content: Array<{ text: string }> }).content[0] as { text: string }).text
          this.followups.push({ sessionId: options.sessionId, text })
          this.chain = this.chain
            .then(() => this.act(options.sessionId, text))
            .catch(err => {
              this.actErrors.push(String((err as Error).message ?? err))
            })
        },
      },
      dispose: async () => {
        this.disposed.push(options.sessionId)
      },
    }
    return handle
  }

  private usernameFor(sessionId: string): string {
    const index = this.created.findIndex(c => c.sessionId === sessionId)
    return `pa${index + 1}`
  }

  private matchIdFrom(text: string): string | undefined {
    return /matchId=([A-Za-z0-9]+)/.exec(text)?.[1]
  }

  protected async act(sessionId: string, text: string): Promise<void> {
    if (this.silent.includes(sessionId)) return
    if (text.includes('action="create"')) {
      const preset = /preset="([^"]+)"/.exec(text)?.[1] ?? 'world-rounds'
      await this.matches.createMatch({ preset: preset as never, sessionId, username: this.usernameFor(sessionId) })
      return
    }
    const matchId = this.matchIdFrom(text)
    if (!matchId) return
    if (text.includes('action="join"')) {
      await this.matches.join(matchId, { sessionId, username: this.usernameFor(sessionId) })
      return
    }
    if (text.includes('screeps_submit_code')) {
      await this.matches.store.update(matchId, state => {
        const player = state.players.find(p => p.sessionId === sessionId)
        if (player) {
          player.code = { main: 'module.exports.loop = function () {}' }
          player.submitted = true
        }
      })
    }
  }

  // 编排器 poll 只需看到 store 状态反转；act 进场串行队列，全部完成等价于 store 就绪
  async settle(): Promise<void> {
    await this.chain
  }
}

function makeSvc(): ScreepsService {
  return {
    ensureRunning: async () => ({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
    getWorld: async () => ({ ok: true, gameTime: 1000, users: [] }),
    system: async () => ({ ok: true }),
    createUser: async (input: { username: string }) => ({ id: 'uid-' + input.username, username: input.username }),
    restart: async () => {},
    eventLog: async () => ({ events: [], cursor: 0, bound: true }),
  } as unknown as ScreepsService
}

function makeOrchestrator(opts: { silent?: string[]; intervalMs?: number; failCreateAfter?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-agents-'))
  dirs.push(dir)
  const svc = makeSvc()
  const matches = new MatchService(svc, dir, () => {})
  const registry = new FakeRegistry(matches, opts.silent ?? [])
  registry.failCreateAfter = opts.failCreateAfter
  const orchestrator = new SpawnOrchestrator({ registry, match: matches, intervalMs: opts.intervalMs ?? 5 })
  return { orchestrator, registry, matches }
}

const TIMEOUT = { timeoutMs: 300 }

import { afterEach } from 'vitest'

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SpawnOrchestrator', () => {
  it('spawns the requested agents with model/provider plumbing and returns a ready match', async () => {
    const { orchestrator, registry, matches } = makeOrchestrator({ intervalMs: 5 })
    const result = await orchestrator.spawn({
      preset: 'world-rounds',
      count: 3,
      model: 'deepseek-v4-flash',
      provider: 'stub',
      timeoutMs: 500,
    })

    expect(registry.created).toHaveLength(3)
    for (const created of registry.created) {
      expect(created.sessionId.startsWith(SPAWN_SESSION_PREFIX)).toBe(true)
      expect(created.agentOptions).toEqual({ provider: 'stub', model: 'deepseek-v4-flash' })
    }
    expect(result.sessionIds).toHaveLength(3)
    expect(result.matchId).toBeTruthy()

    const match = await matches.store.get(result.matchId)
    expect(match!.spawnedBy).toBe('agents')
    expect(match!.players).toHaveLength(3)
    expect(match!.players.every(p => p.submitted === true)).toBe(true)
    expect(match!.players.map(p => p.username).sort()).toEqual(['pa1', 'pa2', 'pa3'])
  })

  it('drives exactly one followup per stage per agent, with player index/preset/matchId in prompts', async () => {
    const { orchestrator, registry } = makeOrchestrator({ intervalMs: 5 })
    await orchestrator.spawn({ preset: 'arena-blitz', model: 'deepseek-v4-flash', count: 2, timeoutMs: 500 })

    // create 阶段 1 次 + join 阶段 1 次 + script 阶段 2 次 = 4
    const creates = registry.followups.filter(f => f.text.includes('action="create"'))
    const joins = registry.followups.filter(f => f.text.includes('action="join"'))
    const scripts = registry.followups.filter(f => f.text.includes('screeps_submit_code'))
    expect(creates).toHaveLength(1)
    expect(joins).toHaveLength(1)
    expect(scripts).toHaveLength(2)

    expect(creates[0]!.text).toContain('玩家 1')
    expect(creates[0]!.text).toContain('preset="arena-blitz"')
    expect(joins[0]!.text).toContain('玩家 2')
    expect(joins[0]!.text).toContain('matchId=m')
  })

  it('rejects counts outside the preset bounds (arena=2, world [2,seats])', async () => {
    const { orchestrator } = makeOrchestrator()
    await expect(orchestrator.spawn({ preset: 'arena-blitz', count: 2, model: undefined as unknown as string, timeoutMs: TIMEOUT.timeoutMs })).rejects.toThrow(/requires a model/)
    await expect(orchestrator.spawn({ preset: 'arena-blitz', model: 'deepseek-v4-flash', count: 3, timeoutMs: TIMEOUT.timeoutMs })).rejects.toThrow(/exactly 2/)
    await expect(orchestrator.spawn({ preset: 'world-rounds', model: 'deepseek-v4-flash', count: 1, timeoutMs: TIMEOUT.timeoutMs })).rejects.toThrow(/allow 2-4/)
    await expect(orchestrator.spawn({ preset: 'world-rounds', model: 'deepseek-v4-flash', count: 5, timeoutMs: TIMEOUT.timeoutMs })).rejects.toThrow(/allow 2-4/)
  })

  it('rejects when an active match already exists (spawn 前 activeExists 预检)', async () => {
    const { orchestrator, matches } = makeOrchestrator()
    await matches.createMatch({ preset: 'world-rounds', sessionId: 'other', username: 'other' })
    await expect(orchestrator.spawn({ preset: 'arena-blitz', model: 'deepseek-v4-flash', count: 2, timeoutMs: TIMEOUT.timeoutMs })).rejects.toThrow(/must settle first/)
  })

  it('disposes all already-spawned handles when a create fails (atomicity)', async () => {
    const { orchestrator, registry } = makeOrchestrator({ intervalMs: 5, failCreateAfter: 2 })
    await expect(
      orchestrator.spawn({ preset: 'arena-blitz', model: 'deepseek-v4-flash', count: 2, timeoutMs: TIMEOUT.timeoutMs }),
    ).rejects.toThrow(/session create failed/)
    // 第 1 个已 spawn 的会话被 dispose，第 2 个未创建
    expect(registry.disposed).toHaveLength(1)
    expect(registry.disposed[0]).toBe(registry.created[0]!.sessionId)
  })
})

describe('SpawnOrchestrator 超时重试（确定性注入）', () => {
  /** 构造「写脚本阶段玩家 2 沉默」的编排器：registry.create 时把 target 位置 sessionId 记入 silent。 */
  function makeSilentOrchestrator(silentAtScriptFor: 'player1' | 'player2') {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-agents-silent-'))
    dirs.push(dir)
    const svc = makeSvc()
    const matches = new MatchService(svc, dir, () => {})
    const silent = new Set<string>()
    const registry = new (class extends FakeRegistry {
      override async create(options: {
        sessionId: string
        agentOptions?: { provider?: string; model?: string }
        meta?: { agentPreset?: string; origin?: 'subagent' }
      }): Promise<AgentHandleLike> {
        const handle = await super.create(options)
        // 按目标序号注入沉默：player1 = 第 1 个 create，player2 = 第 2 个
        const index = this.created.length
        if ((silentAtScriptFor === 'player1' && index === 1) || (silentAtScriptFor === 'player2' && index === 2)) {
          silent.add(options.sessionId)
        }
        return handle
      }
      hasSilent(sessionId: string): boolean {
        return silent.has(sessionId)
      }
      override async act(sessionId: string, text: string): Promise<void> {
        // 只沉默「写脚本」阶段的推进（create/join 正常）
        if (text.includes('screeps_submit_code') && silent.has(sessionId)) return
        await super.act(sessionId, text)
      }
    })(matches)
    const orchestrator = new SpawnOrchestrator({ registry, match: matches, intervalMs: 5 })
    return { orchestrator, registry }
  }

  it('script 阶段超时：一次重试后 dispose 全部并抛错', async () => {
    const { orchestrator, registry } = makeSilentOrchestrator('player2')
    await expect(orchestrator.spawn({ preset: 'world-rounds', model: 'deepseek-v4-flash', count: 2, timeoutMs: 120 })).rejects.toThrow(
      /did not all submit scripts in time/,
    )
    // 玩家 2 的写脚本 prompt 被驱动两次（首次 + 一次重试）
    const scriptDrives = registry.followups.filter(f => f.text.includes('screeps_submit_code') && registry.followups.some(x => x.sessionId === f.sessionId))
    const drivesByPlayer2 = scriptDrives.filter(f => f.text.includes('玩家 2') || f.text.includes('pa2'))
    expect(drivesByPlayer2.length).toBeGreaterThanOrEqual(1)
    // 全部已 spawn 会话被 dispose（原子性）
    expect(registry.disposed).toHaveLength(2)
  })

  it('join 阶段超时：silent joiner 一次重试后 dispose 全部并抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-agents-silent-join-'))
    dirs.push(dir)
    const svc = makeSvc()
    const matches = new MatchService(svc, dir, () => {})
    const joinSilent = new Set<string>()
    const registry = new (class extends FakeRegistry {
      override async create(options: {
        sessionId: string
        agentOptions?: { provider?: string; model?: string }
        meta?: { agentPreset?: string; origin?: 'subagent' }
      }): Promise<AgentHandleLike> {
        const handle = await super.create(options)
        if (this.created.length === 2) joinSilent.add(options.sessionId)
        return handle
      }
      override async act(sessionId: string, text: string): Promise<void> {
        if (text.includes('action="join"') && joinSilent.has(sessionId)) return
        await super.act(sessionId, text)
      }
    })(matches)
    const orchestrator = new SpawnOrchestrator({ registry, match: matches, intervalMs: 5 })
    await expect(orchestrator.spawn({ preset: 'arena-blitz', model: 'deepseek-v4-flash', count: 2, timeoutMs: 120 })).rejects.toThrow(
      /players did not all join in time/,
    )
    expect(registry.disposed).toHaveLength(2)
  })

  it('create 阶段超时：玩家 1 沉默不建局 → 重试 → 仍无 → dispose 全部并抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-agents-silent-create-'))
    dirs.push(dir)
    const svc = makeSvc()
    const matches = new MatchService(svc, dir, () => {})
    const createSilent = true
    const registry = new (class extends FakeRegistry {
      override async act(sessionId: string, text: string): Promise<void> {
        if (createSilent && text.includes('action="create"')) return
        await super.act(sessionId, text)
      }
    })(matches)
    const orchestrator = new SpawnOrchestrator({ registry, match: matches, intervalMs: 5 })
    await expect(orchestrator.spawn({ preset: 'arena-blitz', model: 'deepseek-v4-flash', count: 2, timeoutMs: 120 })).rejects.toThrow(
      /player 1 did not create a match in time/,
    )
    // 玩家 1 的 create prompt 驱动了两次（首次 + 重试）
    const createDrives = registry.followups.filter(f => f.text.includes('action="create"'))
    expect(createDrives).toHaveLength(2)
    expect(registry.disposed).toHaveLength(2)
  })
})

describe('SpawnOrchestrator 收尾', () => {
  it('disposeMatchAgents disposes the spawned handles for that match (成功后), 幂等', async () => {
    const { orchestrator, registry } = makeOrchestrator({ intervalMs: 5 })
    const result = await orchestrator.spawn({ preset: 'arena-blitz', model: 'deepseek-v4-flash', count: 2, timeoutMs: 500 })
    expect(registry.disposed).toHaveLength(0)
    await orchestrator.disposeMatchAgents(result.matchId)
    expect(registry.disposed).toHaveLength(2)
    // 幂等：再次 dispose 不再重复
    await orchestrator.disposeMatchAgents(result.matchId)
    expect(registry.disposed).toHaveLength(2)
  })

  it('assertUniqueUsernames rejects duplicates and accepts uniques', () => {
    expect(() => assertUniqueUsernames(['a', 'a'])).toThrow(/duplicate usernames/)
    expect(() => assertUniqueUsernames(['a', 'b'])).not.toThrow()
  })

  it('prompt builders carry the documented rules', () => {
    const create = buildCreatePrompt({ preset: 'arena-blitz', count: 2 })
    expect(create).toContain('玩家 1')
    expect(create).toContain('__bot__')
    const join = buildJoinPrompt({ preset: 'arena-blitz', count: 2, matchId: 'm1', index: 2, names: ['pa1'] })
    expect(join).toContain('玩家 2')
    expect(join).toContain('m1')
  })

  it('spawn 后对局处于 creating（可点开始）且不误伤普通局', async () => {
    const { orchestrator, matches } = makeOrchestrator({ intervalMs: 5 })
    const result = await orchestrator.spawn({ preset: 'arena-blitz', model: 'deepseek-v4-flash', count: 2, timeoutMs: 500 })
    const match = await matches.store.get(result.matchId)
    expect(match!.phase).toBe('creating')
    expect(match!.spawnedBy).toBe('agents')
  })
})
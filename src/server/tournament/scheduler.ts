/**
 * 锦标赛调度器（plan-M4/S3，D3/D5）——host 侧编排状态机。
 *
 * 职责：round-robin 赛程 pump（scheduled 先落盘 → createMatch → 回填 matchId）、
 * settle 结果同步回填、开局驱动（初始 prompt 有界补发 + 全员就绪 start）、
 * 启动恢复三态判定。依赖全部注入（createMatch / journal / history / prompt 发送），
 * 本模块 import 面不含 src/agent/*（验收判据 4 的可执行负向断言）。
 *
 * 并发不变式（D3）：每位选手同时至多 1 局活跃对局；锦标赛 maxConcurrent 固定 1
 * ——pump 只在「本届无活跃 created 对局」时排下一场。池耗尽/席位占用两类瞬时拒绝
 * catch 后留待下个触发点（settle / 新届 / 30s 兜底定时器），不重试。
 */
import { RoomPoolExhaustedError, SeatInUseError } from '../pool.js'
import { applyResult, roundRobinPairs, standings } from './bracket.js'
import { newTournamentId, tournamentFinished } from './types.js'
import type { Tournament, TournamentMatchResult, TournamentParticipant } from './types.js'
import type { MatchMachine } from '../match/machine.js'
import type { MatchConfig } from '../match/model.js'

/** 初始 prompt 有界补发上限（对齐 llm-smoke maxAttempts=3 语义：reasoning 模型
 *  偶发只回文本不调工具，单次 prompt 不可靠——二审 RB1）。 */
export const INITIAL_PROMPT_MAX_ATTEMPTS = 3

/** 初始提交 prompt（D7：只含本局语义——席位/对局/提交要求，不含任何跨局信息；
 *  单测钉死字样）。 */
export function initialPromptText(matchId: string): string {
  return (
    `A new match (${matchId}) has been created for your seat. ` +
    'Commit your initial bot code NOW by CALLING the submit_code tool (do not just reply with text).'
  )
}

export interface TournamentSchedulerDeps {
  store: import('./store.js').TournamentStore
  /** 建局唯一正道（main.ts 内部 createMatch，与 HTTP 同一函数）。 */
  createMatch: (players: Array<{ seatId: string; username: string }>, config?: Partial<MatchConfig>) => MatchMachine
  /** 活跃对局查找（machines 表；恢复局的 journal 灌回对局也在其中）。 */
  getMachine: (id: string) => MatchMachine | undefined
  /** journal 记录投影（恢复判定：created 但不在 machines/journal → 重排）。 */
  journalEntries: () => Array<{ id: string; players: string[] }>
  /** history 记录查找（settled 未回填 → 按 matchId 回填）。 */
  historyGet: (id: string) => { winner: unknown; scores: Record<string, number> | null; settledAt: number | null } | undefined
  /** history 按 pair 反查（RN1：scheduled 采纳路径；main 侧从 history.list() 过滤）。 */
  historyFindByPair: (pair: [string, string]) => { id: string; winner: unknown; scores: Record<string, number> | null; settledAt: number | null } | undefined
  /** 初始 prompt 发送（main 侧经 waker 通道；返回在途 Promise 供补发去重——
   *  首轮唤醒含建号 + 房间生成 + restart，常超 starter 5s 周期，不去重会空耗配额）。 */
  initialPrompt: (seatId: string, matchId: string) => void | Promise<void>
  log: (msg: string) => void
}

interface SeatPromptState {
  sent: number
  exceeded: boolean
  /** 在途 prompt（未完成前 starter 补发跳过、不计数——配额只计真实重试）。 */
  pending?: Promise<void>
}

export class TournamentScheduler {
  private readonly deps: TournamentSchedulerDeps
  /** pump 单飞互斥（D3/N4：settle 触发与 30s 定时器同拍只跑一份）。 */
  private pumping = false
  /** per-(matchId, seatId) 初始 prompt 计数（上限对齐 llm-smoke maxAttempts：per-seat）。 */
  private readonly promptState = new Map<string, Map<string, SeatPromptState>>()
  private starterTimer?: ReturnType<typeof setInterval>
  private pumpTimer?: ReturnType<typeof setInterval>

  constructor(deps: TournamentSchedulerDeps) {
    this.deps = deps
  }

  /* ---------------- 创建与校验（D6 业务规则；HTTP 层另有格式校验） ---------------- */

  create(input: {
    name?: string
    participants: TournamentParticipant[]
    matchConfig?: Partial<MatchConfig>
  }): Tournament {
    const seatIds = input.participants.map((p) => p.seatId)
    if (input.participants.length < 2 || input.participants.length > 8) {
      throw new Error('tournament: participants must be 2..8')
    }
    if (new Set(seatIds).size !== seatIds.length) throw new Error('tournament: duplicate seatId')
    for (const p of input.participants) {
      if (!p.username) throw new Error('tournament: username required')
    }
    // pair 固定 2 席；覆盖 seats≠2 会在 MatchMachine 构造期才炸（一审 N2）——创建期直接拒
    if (input.matchConfig?.seats !== undefined && input.matchConfig.seats !== 2) {
      throw new Error('tournament: matchConfig.seats is fixed to 2')
    }
    const pairs = roundRobinPairs(seatIds)
    const t: Tournament = {
      id: newTournamentId(),
      name: input.name ?? 'tournament',
      createdAt: Date.now(),
      format: 'round-robin',
      participants: input.participants.map((p) => ({ ...p })),
      ...(input.matchConfig ? { matchConfig: { ...input.matchConfig } } : {}),
      matches: pairs.map((pair) => ({ pair, status: 'scheduled' as const })),
      errors: [],
    }
    this.deps.store.save(t)
    this.deps.log(`tournament ${t.id} created (${t.participants.length} players, ${t.matches.length} matches)`)
    void this.pump(t.id)
    return t
  }

  /* ---------------- settle 挂点（D3-②：applyResult 同步落账，pump 异步） ---------------- */

  onSettled(m: MatchMachine): void {
    for (const t of this.deps.store.list()) {
      const match = t.matches.find((x) => x.matchId === m.id)
      if (!match) continue
      if (match.status !== 'settled') {
        const winner = m.state.winner
        const result: TournamentMatchResult = {
          winner: winner?.kind === 'seat' ? winner.seatId : null,
          scores: m.state.scores ?? {},
          settledAt: m.state.settledAt ?? Date.now(),
        }
        applyResult(t, m.id, result)
        this.deps.store.save(t)
        this.deps.log(`tournament ${t.id}: match ${m.id} settled (${result.winner ?? 'draw'})`)
      }
      this.maybeFinish(t)
      void this.pump(t.id)
      return
    }
  }

  /* ---------------- pump（D3） ---------------- */

  async pump(tournamentId: string): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const t = this.deps.store.get(tournamentId)
      if (!t || tournamentFinished(t)) return
      // maxConcurrent=1：本届仍有活跃 created 对局（机器在）则不排下一场
      const activeCreated = t.matches.filter((m) => m.status === 'created' && this.deps.getMachine(m.matchId ?? ''))
      if (activeCreated.length > 0) {
        for (const m of activeCreated) this.sendInitialPrompts(this.deps.getMachine(m.matchId ?? '') as MatchMachine, t)
        return
      }
      const next = t.matches.find((m) => m.status === 'scheduled')
      if (!next) return
      const players = next.pair.map((seatId) => {
        const p = t.participants.find((x) => x.seatId === seatId)
        return { seatId, username: p?.username ?? seatId }
      })
      try {
        const machine = this.deps.createMatch(players, t.matchConfig ? { ...t.matchConfig } : undefined)
        next.status = 'created'
        next.matchId = machine.id
        this.deps.store.save(t)
        this.deps.log(`tournament ${t.id}: match ${machine.id} created for pair [${next.pair.join(', ')}]`)
        // pump 建局后的首发计入 starter 的重发计数（二审措辞补项：计数器共享）
        this.sendInitialPrompts(machine, t)
      } catch (err) {
        // 瞬时拒绝（teardown 在飞等）不重试：留 scheduled，等下个触发点（D3）
        if (err instanceof RoomPoolExhaustedError || err instanceof SeatInUseError) {
          this.deps.log(`tournament ${t.id}: pump deferred (${err.constructor.name})`)
          return
        }
        throw err
      }
    } finally {
      this.pumping = false
    }
  }

  /* ---------------- 开局驱动（D5，RB1 修订：starter 兼任开局与有界补发） ---------------- */

  /** per-match per-seat 初始 prompt（有界）；pump 首发与 starter 补发共享同一计数器。
   *  超界落届 errors 可查面（不静默卡死，RB1）。 */
  private sendInitialPrompts(machine: MatchMachine, t: Tournament): void {
    let perSeat = this.promptState.get(machine.id)
    if (!perSeat) {
      perSeat = new Map()
      this.promptState.set(machine.id, perSeat)
    }
    for (const p of machine.players) {
      if (p.code) continue
      const st = perSeat.get(p.seatId) ?? { sent: 0, exceeded: false }
      perSeat.set(p.seatId, st)
      if (st.exceeded) continue
      if (st.pending) continue // 在途唤醒未收口：不重发、不计数（真实重试才耗配额）
      if (st.sent >= INITIAL_PROMPT_MAX_ATTEMPTS) {
        st.exceeded = true
        const msg = `match ${machine.id}: seat ${p.seatId} initial prompt exceeded ${INITIAL_PROMPT_MAX_ATTEMPTS} attempts (no submit_code observed)`
        t.errors.push(msg)
        this.deps.store.save(t)
        this.deps.log(`tournament ${t.id}: ${msg}`)
        continue
      }
      st.sent++
      const r = this.deps.initialPrompt(p.seatId, machine.id)
      st.pending =
        r instanceof Promise
          ? r.catch(() => {}).finally(() => {
              st.pending = undefined
            })
          : undefined
      this.deps.log(`tournament ${t.id}: match ${machine.id} initial prompt -> ${p.seatId} (attempt ${st.sent}/${INITIAL_PROMPT_MAX_ATTEMPTS})`)
    }
  }

  /** starter：对已建局未 started 的对局补发初始 prompt / 全员就绪即 start。
   *  返回是否还有未开局对局（测试口）。 */
  tickStarter(): boolean {
    let pending = false
    for (const t of this.deps.store.list()) {
      if (tournamentFinished(t)) continue
      for (const m of t.matches) {
        if (m.status !== 'created') {
          if (m.status === 'scheduled') pending = true
          continue
        }
        const machine = this.deps.getMachine(m.matchId ?? '')
        if (!machine || machine.phase !== 'creating') continue
        const missing = machine.players.filter((p) => !p.code)
        if (missing.length === 0) {
          try {
            machine.start()
            this.deps.log(`tournament ${t.id}: match ${machine.id} started`)
          } catch (err) {
            this.deps.log(`tournament ${t.id}: start ${machine.id} failed: ${String(err)}`)
          }
        } else {
          pending = true
          this.sendInitialPrompts(machine, t)
        }
      }
    }
    return pending
  }

  /* ---------------- 启动恢复（D3-③，优先级写死） ---------------- */

  /** 返回处理的未完届数（测试口）。 */
  recoverOnStartup(): number {
    let processed = 0
    for (const t of this.deps.store.list()) {
      if (tournamentFinished(t)) continue
      processed++
      const journalEntries = this.deps.journalEntries()
      for (const m of t.matches) {
        // ① settled 未回填（settle→pump 崩溃窗）→ history 按 matchId 回填
        if (m.status === 'settled' && !m.result && m.matchId) {
          const rec = this.deps.historyGet(m.matchId)
          if (rec) {
            m.result = this.resultFromHistory(rec)
            this.deps.store.save(t)
            this.deps.log(`tournament ${t.id}: match ${m.matchId} result backfilled from history`)
          }
          continue
        }
        // ② scheduled（matchId 缺席）：先按 pair 扫 journal/history 采纳已有对局
        //    （RN1：回填写盘失败的双故障窗下防重打一局），扫不到才留给 pump 重排
        if (m.status === 'scheduled') {
          const adopted = this.adoptFromJournalOrHistory(t, m.pair, journalEntries)
          if (adopted) {
            Object.assign(m, adopted)
            this.deps.store.save(t)
            this.deps.log(`tournament ${t.id}: scheduled pair [${m.pair.join(', ')}] adopted as ${adopted.matchId}`)
          }
          continue
        }
        // ③ created 且 matchId 不在 machines/journal（建局成功但进程内状态全失）→ 重排
        if (m.status === 'created' && m.matchId) {
          const live = this.deps.getMachine(m.matchId) || journalEntries.some((j) => j.id === m.matchId)
          if (!live) {
            // history 有完整赛果 = 实际已 settle 过 → 回填；否则重排
            const rec = this.deps.historyGet(m.matchId)
            if (rec && rec.winner !== undefined) {
              m.status = 'settled'
              m.result = this.resultFromHistory(rec)
              this.deps.log(`tournament ${t.id}: lost match ${m.matchId} settled via history, backfilled`)
            } else {
              this.deps.log(`tournament ${t.id}: match ${m.matchId} lost (not in machines/journal), rescheduling pair [${m.pair.join(', ')}]`)
              m.status = 'scheduled'
              delete m.matchId
            }
            this.deps.store.save(t)
          }
        }
      }
      this.maybeFinish(t)
      void this.pump(t.id)
    }
    return processed
  }

  /** 对局结果从 history 记录映射（同源：M3/D7 winner/scores 快照）。 */
  private resultFromHistory(rec: { winner: unknown; scores: Record<string, number> | null; settledAt: number | null }): TournamentMatchResult {
    const w = rec.winner as { kind?: string; seatId?: string } | null
    return {
      winner: w?.kind === 'seat' && typeof w.seatId === 'string' ? w.seatId : null,
      scores: rec.scores ?? {},
      settledAt: rec.settledAt ?? Date.now(),
    }
  }

  /** scheduled pair 的已有对局采纳：journal（未完局）或 history（已完局）中
   *  players 恰为该 pair 的记录。 */
  private adoptFromJournalOrHistory(
    t: Tournament,
    pair: [string, string],
    journalEntries: Array<{ id: string; players: string[] }>,
  ): { matchId: string; status: 'created' | 'settled'; result?: TournamentMatchResult } | undefined {
    const isPair = (players: string[]) => {
      const s = [...players].sort()
      const p = [...pair].sort()
      return s.length === 2 && s[0] === p[0] && s[1] === p[1]
    }
    const j = journalEntries.find((x) => isPair(x.players))
    if (j) return { matchId: j.id, status: 'created' }
    const found = this.deps.historyFindByPair(pair)
    if (found) return { matchId: found.id, status: 'settled', result: this.resultFromHistory(found) }
    return undefined
  }

  private maybeFinish(t: Tournament): void {
    if (!t.finishedAt && tournamentFinished(t)) {
      t.finishedAt = Date.now()
      const rows = standings(t)
      this.deps.store.save(t)
      this.deps.log(`tournament ${t.id} finished; winner: ${rows[0]?.seatId ?? 'n/a'} (${rows[0]?.points ?? 0} pts)`)
    }
  }

  /* ---------------- 定时器 ---------------- */

  startTimers(): void {
    if (!this.starterTimer) {
      this.starterTimer = setInterval(() => this.tickStarter(), 5_000)
      this.starterTimer.unref?.()
    }
    if (!this.pumpTimer) {
      this.pumpTimer = setInterval(() => {
        for (const t of this.deps.store.list()) {
          if (!tournamentFinished(t)) void this.pump(t.id)
        }
      }, 30_000)
      this.pumpTimer.unref?.()
    }
  }

  stopTimers(): void {
    if (this.starterTimer) clearInterval(this.starterTimer)
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    this.starterTimer = undefined
    this.pumpTimer = undefined
  }

  /** 测试口：清除 per-match prompt 状态（同 seatId 跨场计数归零 = 新 matchId 天然隔离，
   *  仅重排产生的新 match 也天然新键，故常态无需调用）。 */
  resetPromptState(matchId: string): void {
    this.promptState.delete(matchId)
  }
}

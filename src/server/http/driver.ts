/**
 * 对局驱动器（M1/S4，plan-M1 一审修复项 2）——M0 遗留接线的落点：
 *   ① 常驻 interval → machine.advance(真实时钟)（running 周期到点 / roundBreak 超时兜底）；
 *   ② MatchEvent → 席位 AgentRunner.prompt() 唤醒（round_break → 战报唤醒、
 *      started/round_resume → 开跑通知）。
 *
 * 语义（二审非阻塞建议 1，实现期钉死）：
 *   - interval 粒度 500ms（advance 幂等，错过周期不补跑——advance 内部按 now 判定）；
 *   - 唤醒串行：每席位一次只有一个 prompt 在飞（AgentRunner 并发拒绝兜底）；
 *   - 唤醒失败不抛出驱动循环（经 log 回调记录），下一轮 advance 重试由状态机语义保证
 *     （roundBreak 期未 ready 的席位在超时兜底前仍会被再次唤醒——由本类 pending 去重）。
 */
import type { MatchMachine, MatchEvent } from '../match/machine.js'
import { computeOutcome } from '../match/score.js'
import type { SeatScoreInput } from '../match/score.js'
import type { SettleReason, WinnerRef } from '../match/model.js'

/** 唤醒通道（AgentRunner.prompt 的结构化最小面）。 */
export interface SeatWaker {
  prompt(seatId: string, text: string): Promise<void>
}

/** arena 局 30s 状态唤醒文本（D4：pull report，零跨局信息——与 report 工具增量面配合）。 */
export const ARENA_STATUS_WAKE_TEXT =
  'Arena match in progress. Check your situation with the report tool and hot-update your code with submit_code if needed (changes take effect at the next tick). The match ends when a spawn is destroyed or the tick budget runs out.'

export interface MatchDriverOptions {
  /** 检查周期（ms，默认 500）。 */
  intervalMs?: number
  /** 唤醒文本构造（可注入定制；默认 world-rounds 语义）。 */
  wakeText?: (event: MatchEvent, machine: MatchMachine) => string
  /**
   * 计分快照（M2/S1）：roundBreak 相位机器在 advance 前 await 取分（roundsExhausted
   * 真实结算）。roundsExhausted 路径不发 round_resume 事件，此刻是唯一新鲜取分点；
   * 缺席/抛错 → advance 不带分（M0 全 0 draw），驱动循环不中断。
   */
  scoreSnapshot?: (m: MatchMachine) => Promise<Record<string, SeatScoreInput> | undefined>
  /**
   * arena 结算观察（M5/D5，B2 新增件）：form=arena 的 running 局每拍调用一次；返回
   * 决策则立即 settle（lastStanding / ticksExhausted）。抛错只记日志不中断循环。
   */
  arenaObserve?: (m: MatchMachine) => Promise<{ reason: SettleReason; outcome: { scores: Record<string, number>; winner: WinnerRef } } | undefined>
  /** arena 局状态唤醒周期（墙钟 ms，默认 30_000——D4：低频状态唤醒，不追 tick）。 */
  arenaStatusWakeMs?: number
  log?: (msg: string) => void
}

export class MatchDriver {
  private readonly machines = new Set<MatchMachine>()
  /** matchId → (seatId → waker)。per-match 归属：多对局并存时 waker 不互相覆盖。 */
  private readonly wakers = new Map<string, Map<string, SeatWaker>>()
  private readonly pendingWake = new Set<string>() // `${matchId}:${seatId}:${round}:${type}` 去重
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly intervalMs: number
  private readonly wakeText: NonNullable<MatchDriverOptions['wakeText']>
  private readonly scoreSnapshot: MatchDriverOptions['scoreSnapshot']
  private readonly arenaObserve: MatchDriverOptions['arenaObserve']
  private readonly arenaStatusWakeMs: number
  /** matchId → 上次 arena 状态唤醒墙钟（D4 节流）。 */
  private readonly arenaLastWake = new Map<string, number>()
  private readonly log: (msg: string) => void

  constructor(opts: MatchDriverOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 500
    this.wakeText =
      opts.wakeText ??
      ((event, m) => {
        const round = 'round' in event ? event.round : m.state.roundIndex
        if (event.type === 'round_break') {
          return (
            `Match ${m.id}: round ${round} has ended. The world is paused at the round boundary.\n` +
            'Review your situation and submit your next-round code with submit_code (commit = ready). ' +
            'The round resumes automatically once all seats are ready.'
          )
        }
        return `Match ${m.id}: round ${round} is starting. Your code is live — play the round.`
      })
    this.scoreSnapshot = opts.scoreSnapshot
    this.arenaObserve = opts.arenaObserve
    this.arenaStatusWakeMs = opts.arenaStatusWakeMs ?? 30_000
    this.log = opts.log ?? (() => {})
  }

  /** 注册对局（接线 MatchEvent → 唤醒）。幂等；同 matchId 重复 watch 合并 waker 表。 */
  watch(machine: MatchMachine, wakers: Record<string, SeatWaker>): void {
    this.machines.add(machine)
    let table = this.wakers.get(machine.id)
    if (!table) {
      table = new Map<string, SeatWaker>()
      this.wakers.set(machine.id, table)
    }
    for (const [seatId, waker] of Object.entries(wakers)) table.set(seatId, waker)
  }

  /** 解除 watch（settled 时调用）；同时清理该对局的 waker 表。 */
  unwatch(machine: MatchMachine): void {
    this.machines.delete(machine)
    this.wakers.delete(machine.id)
  }

  /** 启动常驻循环。幂等。 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 单拍（测试口）：advance 全部对局（roundBreak 相位先取计分快照）+ arena 结算观察
   *  + 状态唤醒节流 + 消费事件唤醒。 */
  async tick(): Promise<void> {
    for (const m of this.machines) {
      try {
        let outcome: { scores: Record<string, number>; winner: WinnerRef } | undefined
        if (m.phase === 'roundBreak' && this.scoreSnapshot) {
          try {
            const snap = await this.scoreSnapshot(m)
            if (snap) outcome = computeOutcome(snap)
          } catch (err) {
            this.log(`score snapshot ${m.id} failed: ${String(err)}`)
          }
        }
        m.advance(undefined, outcome)
      } catch (err) {
        this.log(`advance ${m.id} failed: ${String(err)}`)
      }
      // M5/D5：arena 局结算观察（form 分支隔离——world 局不进此路径）
      if (m.config.form === 'arena' && m.phase === 'running' && this.arenaObserve) {
        try {
          const decision = await this.arenaObserve(m)
          if (decision) {
            m.settle(decision.reason, Date.now(), decision.outcome)
            continue
          }
        } catch (err) {
          this.log(`arena observe ${m.id} failed: ${String(err)}`)
        }
        // D4：状态唤醒节流（30s 墙钟；串行守卫在途拒绝，非致命）
        const now = Date.now()
        const last = this.arenaLastWake.get(m.id) ?? now
        if (now - last >= this.arenaStatusWakeMs) {
          this.arenaLastWake.set(m.id, now)
          const table = this.wakers.get(m.id)
          for (const p of m.players) {
            const waker = table?.get(p.seatId)
            if (!waker) continue
            try {
              await waker.prompt(p.seatId, ARENA_STATUS_WAKE_TEXT)
            } catch (err) {
              this.log(`arena status wake ${p.seatId} failed: ${String(err)}`)
            }
          }
        }
      }
    }
  }

  /** 事件处理（server.ts 接线：machine 的 onEvent → 本方法）。 */
  async onEvent(machine: MatchMachine, event: MatchEvent): Promise<void> {
    const round = 'round' in event ? event.round : machine.state.roundIndex
    if (event.type === 'settled') {
      this.unwatch(machine)
      return
    }
    const table = this.wakers.get(machine.id)
    for (const p of machine.players) {
      const key = `${machine.id}:${p.seatId}:${round}:${event.type}`
      if (this.pendingWake.has(key)) continue
      this.pendingWake.add(key)
      const waker = table?.get(p.seatId)
      if (!waker) continue
      try {
        await waker.prompt(p.seatId, this.wakeText(event, machine))
      } catch (err) {
        this.log(`wake ${p.seatId} (${event.type}) failed: ${String(err)}`)
      } finally {
        this.pendingWake.delete(key)
      }
    }
  }
}

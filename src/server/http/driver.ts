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
import type { WinnerRef } from '../match/model.js'

/** 唤醒通道（AgentRunner.prompt 的结构化最小面）。 */
export interface SeatWaker {
  prompt(seatId: string, text: string): Promise<void>
}

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

  /** 单拍（测试口）：advance 全部对局（roundBreak 相位先取计分快照）+ 消费事件唤醒。 */
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

/**
 * 开发/验证用服务组装（M1/S4 驱动器接线的唯一落点）。
 *
 * 为什么单独成模块：`MatchDriver` 的接线（createMatch → driver.watch + waker）
 * 是真实运行路径上的关键环节，必须被 dev-server 与接线 IT **共用同一份代码**，
 * 否则单测里 watch 自证而真实路径漏接（M1 复审问题 3 的教训）。
 *
 * 语义（world-rounds）：createMatch 时即注册 watch + 逐席位 waker；
 * round_break/round_resume 事件 → waker.prompt 唤醒；tick 由 driver 常驻循环驱动。
 */
import { MatchDriver } from './driver.js'
import type { SeatWaker } from './driver.js'
import { MatchMachine } from '../match/machine.js'
import type { ArenaHttpServices } from './routes.js'
import type { SeatScoreInput } from '../match/score.js'

export interface DevServicesOptions {
  driver: MatchDriver
  /** 对局状态变更广播（WS 推送）。 */
  onBroadcast?: (event: { type: string; [k: string]: unknown }) => void
  /** 逐席位唤醒通道工厂（缺席位 → 无唤醒，仅推进时钟）。 */
  makeWaker?: (seatId: string) => SeatWaker
  /** mock 世界快照（默认空世界）。 */
  world?: () => Promise<unknown>
  terrain?: (rooms: string[]) => Promise<{ terrain: Record<string, string> }>
  console?: (user: string, since?: number) => Promise<{ lines: unknown[]; cursor: number; bound: boolean }>
  /** seatId → 真实用户名（mock 世界 = seatId 本身；可覆盖）。 */
  seatUsername?: (seatId: string) => string | undefined
  /** 计分快照（M2/S1；按 seatIds 取，mock 世界可回静态计数；缺席 → settle 维持 M0 draw）。 */
  scoreSnapshot?: (seatIds: string[]) => Promise<Record<string, SeatScoreInput> | undefined>
}

/**
 * 组装内存 mock 版 HTTP 服务面：createMatch 内部完成 driver.watch（真实接线）。
 * 返回的 `matches` 由调用方持有，供 list/get 查询。
 */
export function createArenaDevServices(opts: DevServicesOptions): {
  services: ArenaHttpServices
  machines: Map<string, MatchMachine>
} {
  const machines = new Map<string, MatchMachine>()
  const services: ArenaHttpServices = {
    matches: () => [...machines.values()],
    match: (id) => machines.get(id),
    createMatch: (input) => {
      const wakers: Record<string, SeatWaker> = {}
      if (opts.makeWaker) for (const p of input.players) wakers[p.seatId] = opts.makeWaker(p.seatId)
      const m = new MatchMachine({
        players: input.players,
        ...(input.config ? { config: input.config } : {}),
        onEvent: (e) => {
          // 单一来源接线：事件 → 驱动器唤醒 + WS 广播（顺序固定）
          void opts.driver.onEvent(m, e)
          opts.onBroadcast?.({
            type: 'match_state',
            match: m.id,
            phase: m.phase,
            roundIndex: m.state.roundIndex,
            event: e.type,
          })
        },
      })
      // 关键：把对局交给驱动器（否则 tick 不 advance、waker 永不触发——复审问题 3）
      if (opts.makeWaker) opts.driver.watch(m, wakers)
      else opts.driver.watch(m, {})
      machines.set(m.id, m)
      return m
    },
    getWorld: opts.world ?? (async () => ({ ok: true, gameTime: 0, users: [] })),
    getTerrain: opts.terrain ?? (async (rooms) => ({ terrain: Object.fromEntries(rooms.map((r) => [r, '0'.repeat(2500)])) })),
    consoleSince: opts.console ?? (async () => ({ lines: [], cursor: 0, bound: true })),
    seatUsername: opts.seatUsername ?? ((seatId) => seatId),
    ...(opts.scoreSnapshot ? { getScoreSnapshot: (seatIds: string[]) => opts.scoreSnapshot!(seatIds) } : {}),
  }
  return { services, machines }
}

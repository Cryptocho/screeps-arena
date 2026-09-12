/**
 * M3/D3 teardown 恢复扫描（从 main.ts 抽出，供 main 与 test:live IT 共用同一段代码）。
 * 启动时私服就绪后调用：对 history 中 teardown:pending 的记录，按记录内 seatUsers + rooms
 * 映射（journal.remove 后唯一可还原载体）幂等重放 removeUser/removeRoom，补完标 done。
 * 单席位失败入 onFail 可查面，其余继续；全部席位处理完才 markDone。
 */
export interface TeardownRecoveryDeps {
  system: (cmd: string, value?: unknown) => Promise<unknown>
  /** 待补拆解记录（只读）。 */
  pending: Array<{ id: string; seatUsers: Record<string, string>; rooms: Record<string, string> }>
  /** 补拆解完成后标记 done（同一记录）。 */
  markDone: (id: string) => void
  /** 单席位失败（实时可查面 + 日志）。 */
  onFail?: (matchId: string, seatId: string, error: string) => void
}

export async function recoverPendingTeardowns(deps: TeardownRecoveryDeps): Promise<number> {
  for (const rec of deps.pending) {
    for (const [seatId, username] of Object.entries(rec.seatUsers)) {
      try {
        await deps.system('removeUser', username)
      } catch (err) {
        deps.onFail?.(rec.id, seatId, `recover removeUser: ${String(err)}`)
      }
    }
    for (const [seatId, room] of Object.entries(rec.rooms)) {
      try {
        await deps.system('removeRoom', room)
      } catch (err) {
        deps.onFail?.(rec.id, seatId, `recover removeRoom: ${String(err)}`)
      }
    }
    deps.markDone(rec.id)
  }
  return deps.pending.length
}

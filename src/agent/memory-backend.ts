/**
 * 内存版 SeatRegistry + ArenaBackend（M0/S2 的注入实现，plan-M0 §3：
 * M0 用内存假实现，M1 换真实 arena API——接口面不变，只换实现）。
 *
 * 职责边界：本类不做 phase 语义（frozen/running 拒提交等）——那是对局状态机（S3）的事，
 * M0 阶段 submitCode 恒收；S3 接线后由状态机侧包一层 phase 检查再落位。
 */
import type { ArenaBackend, SeatRegistry } from './tools.js'

export interface SubmittedCode {
  seq: number
  modules: Record<string, string>
  at: number
}

export interface MemoryArenaOptions {
  /** console 假输出（默认回显 expression 摘要）；S4 IT 可注入确定性回复。 */
  consoleReply?: (username: string, expression: string) => string
  /** report 投影（默认最小行：用户名 + 已落位 seq + console 次数）。 */
  reportLine?: (username: string, view: { codeSeq: number; consoleCalls: number }) => string
}

/** 内存假实现：映射 + 落位 + console + 报告，全部按 username 隔离。 */
export class MemoryArena implements SeatRegistry, ArenaBackend {
  private readonly users = new Map<string, string>()
  private readonly code = new Map<string, SubmittedCode>()
  private readonly consoleCalls = new Map<string, string[]>()
  private seqCounter = 0
  private readonly opts: MemoryArenaOptions

  constructor(opts: MemoryArenaOptions = {}) {
    this.opts = opts
  }

  /** host 侧落映射（唯一写入口；工具面只读）。 */
  bindUser(seatId: string, username: string): void {
    this.users.set(seatId, username)
  }

  unbindUser(seatId: string): void {
    this.users.delete(seatId)
  }

  resolveUser(seatId: string): string | undefined {
    return this.users.get(seatId)
  }

  async submitCode(
    username: string,
    modules: Record<string, string>,
  ): Promise<{ ok: true; seq: number } | { ok: false; reason: string }> {
    this.seqCounter += 1
    this.code.set(username, { seq: this.seqCounter, modules: { ...modules }, at: Date.now() })
    return { ok: true, seq: this.seqCounter }
  }

  async runConsole(username: string, expression: string): Promise<string> {
    const log = this.consoleCalls.get(username) ?? []
    log.push(expression)
    this.consoleCalls.set(username, log)
    if (this.opts.consoleReply) return this.opts.consoleReply(username, expression)
    return `[console:${username}] ${expression}`
  }

  async report(username: string): Promise<string> {
    const code = this.code.get(username)
    if (this.opts.reportLine) {
      return this.opts.reportLine(username, { codeSeq: code?.seq ?? 0, consoleCalls: this.consoleCalls.get(username)?.length ?? 0 })
    }
    return `user=${username} codeSeq=${code?.seq ?? 0} consoleCalls=${this.consoleCalls.get(username)?.length ?? 0}`
  }

  /* ---- 测试/调试观察口（host 侧专用，不暴露给工具面） ---- */

  getCode(username: string): SubmittedCode | undefined {
    return this.code.get(username)
  }

  getConsoleLog(username: string): readonly string[] {
    return this.consoleCalls.get(username) ?? []
  }
}

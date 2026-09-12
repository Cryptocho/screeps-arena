/**
 * 对局历史（M3/S4，plan-M3 D7）——记账用全量历史（journal 只保留未完结局，语义不重叠）。
 *
 * - settle 时**先**写 pending（含 seatUsers + rooms 映射——journal.remove 后这是
 *   补拆解唯一可还原房间分配的载体），teardown 完成后原位更新为 done（D3）。
 * - 按 match id 幂等：append 前存在同 id 记录则替换（journal 先写 + 崩溃恢复再 settle
 *   的双条防线）。
 * - 写盘 = 读全量 → 替换 → tmp+rename 整文件原子重写（jsonl 无真原位改行，审查备注 1；
 *   与 journal save 同款原子语义）。历史量级小（每局一行），整写代价可忽略。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

export interface MatchHistoryRecord {
  id: string
  config: { seats: number; roundMs: number; roundBreakTimeoutMs: number; maxRounds: number }
  winner: unknown
  settleReason: string | null
  scores: Record<string, number> | null
  roundIndex: number
  createdAt: number
  settledAt: number | null
  seatUsers: Record<string, string>
  rooms: Record<string, string>
  teardown: 'pending' | 'done'
}

export class MatchHistory {
  private readonly file: string
  private records: MatchHistoryRecord[] = []

  constructor(dir: string) {
    this.file = path.join(dir, 'matches.jsonl')
    mkdirSync(dir, { recursive: true }) // journal 同款：目录不存在则建（首 settle 落盘不 ENOENT）
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    const lines = readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim() !== '')
    for (const line of lines) {
      try {
        this.records.push(JSON.parse(line) as MatchHistoryRecord)
      } catch {
        // 崩溃留下的残行：跳过不炸启动（jsonl append 的固有风险，整写后自愈）
      }
    }
  }

  list(): MatchHistoryRecord[] {
    return [...this.records]
  }

  /** 按 id 幂等 upsert（同 id 原位替换），随后整文件原子落盘。 */
  upsert(record: MatchHistoryRecord): void {
    const idx = this.records.findIndex((r) => r.id === record.id)
    if (idx >= 0) this.records[idx] = record
    else this.records.push(record)
    this.flush()
  }

  markDone(id: string): void {
    const rec = this.records.find((r) => r.id === id)
    if (!rec || rec.teardown === 'done') return
    rec.teardown = 'done'
    this.flush()
  }

  pending(): MatchHistoryRecord[] {
    return this.records.filter((r) => r.teardown === 'pending')
  }

  private flush(): void {
    const body = this.records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, body)
    renameSync(tmp, this.file)
  }
}

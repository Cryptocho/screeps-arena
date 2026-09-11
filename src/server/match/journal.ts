/**
 * 对局 journal（M2/S5，plan-M2 §2）—— interrupted 恢复的落盘/扫描层。
 *
 * 语义（平移自 reference/src/host/match 的 journal 先例，裁到 M2 最小闭环）：
 *   - 唯一写点 = 对局相位迁移事件回调内**同步**落盘（onEvent 已是单一来源接线，
 *     dev-services.ts 注释先例）——不在别处写，避免双写不一致；
 *   - 原子写 = tmp + rename（M0 store 先例）；
 *   - journal 记录含 **seatId→Screeps username 映射与 seatId→room 分配**：RealArena 的
 *     users Map 与游标全在内存（arena.ts L39-42），只落状态机不落映射 → 恢复局席位断链
 *     （plan-M2 复审 B4）；游标不落（重置 0，重启后 console 可能重放，文档已注明）；
 *   - settled 对局不保留（落盘点直接 remove）；扫描时 phase==='settled' 的条目跳过并清理。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { MatchConfig, MatchPlayer, MatchState, SettleReason, WinnerRef } from './model.js'

export interface MatchJournalRecord {
  id: string
  config: MatchConfig
  /** 全量 per-player 状态（含 code/ready/autoReady/submittedAt——恢复 code = 续跑根基）。 */
  players: MatchPlayer[]
  /** seatId → Screeps username（恢复时灌回 RealArena，跳过重复建号）。 */
  seatUsers: Record<string, string>
  /** seatId → 房间分配（恢复时灌回 RealArena，公平性重掷跳过——房间内容已发展）。 */
  rooms: Record<string, string>
  state: {
    createdAt: number
    phase: MatchState['phase']
    roundIndex: number
    roundBreakSince?: number
    roundStartedAt?: number
    settledAt?: number
    settleReason?: SettleReason
    winner?: WinnerRef
    scores?: Record<string, number>
    errors: string[]
  }
}

export class MatchJournal {
  constructor(private readonly dir: string) {}

  path(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }

  /** 原子写：tmp + rename。同步 API——事件回调内调用，保证相位迁移即落盘。 */
  save(record: MatchJournalRecord): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.path(record.id)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(record))
    fs.renameSync(tmp, this.path(record.id))
  }

  /** 全量扫描（损坏条目跳过——部分写被 rename 语义挡住，此处只防手改/磁盘意外）。 */
  list(): MatchJournalRecord[] {
    if (!fs.existsSync(this.dir)) return []
    const out: MatchJournalRecord[] = []
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as MatchJournalRecord)
      } catch {
        continue
      }
    }
    return out
  }

  remove(id: string): void {
    fs.rmSync(this.path(id), { force: true })
  }
}

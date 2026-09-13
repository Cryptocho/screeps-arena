/**
 * 锦标赛持久化（plan-M4/S2，D1）——每届一个 <id>.json，tmp+rename 原子写
 * （history flush 同款纪律）。内存持有全量 + 写透；构造期读回损坏文件跳过该届
 * （单届损坏不炸启动，恢复语义由调度器 D3-③ 接管）。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { Tournament } from './types.js'

export class TournamentStore {
  private readonly dir: string
  private readonly tournaments = new Map<string, Tournament>()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    this.load()
  }

  private load(): void {
    let entries: string[] = []
    try {
      entries = readdirSorted(this.dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const t = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8')) as Tournament
        if (t && typeof t.id === 'string') this.tournaments.set(t.id, t)
      } catch {
        // 崩溃残文件：跳过（与 history 残行同款容忍）
      }
    }
  }

  list(): Tournament[] {
    return [...this.tournaments.values()]
  }

  get(id: string): Tournament | undefined {
    return this.tournaments.get(id)
  }

  /** 写透持久化（tmp+rename 原子）。 */
  save(t: Tournament): void {
    this.tournaments.set(t.id, t)
    this.flush(t.id)
  }

  private flush(id: string): void {
    const t = this.tournaments.get(id)
    if (!t) return
    const file = path.join(this.dir, `${id}.json`)
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(t, null, 2))
    renameSync(tmp, file)
  }
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort()
}

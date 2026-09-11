/**
 * 测试专用 bot 注册表（2026-09-09 对齐修正：从产品路径摘除）。
 *
 * 对局参与者只能是 Agent（DSH 会话）——`bots/` 不随插件分发（package.json files 已移除），
 * 只供自动化测试/IT/headless 驱动对局走向（固定行为、确定性）。
 *
 * 设计决定（公平一致性）：测试 bot 与 Agent 玩家走同一条 createUser 通道，
 * 同样的用户类型、同样的代码上传路径——不注册进 mods.json 的 NPC bots 表。
 *
 * bot 代码在测试 fixture：`tests/fixtures/bots/<name>/main.js`（可扩展多模块目录）。
 * 目录注入化，单测不碰真实插件路径。
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export class BotError extends Error {
  constructor(public code: 'notFound' | 'noMain' | 'badName', message: string) {
    super(message)
    this.name = 'BotError'
  }
}

export interface BotInfo {
  name: string
  description: string
}

export class BotRegistry {
  constructor(readonly dir: string) {}

  /** 列出全部可用 bot（有 main.js 的目录才算）。 */
  async list(): Promise<BotInfo[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    const bots: BotInfo[] = []
    for (const entry of entries.sort()) {
      if (!/^[a-z][a-z0-9_-]*$/.test(entry)) continue
      try {
        const main = await readFile(path.join(this.dir, entry, 'main.js'), 'utf8')
        const meta = /@dsh-bot\s+(.+)/.exec(main)?.[1]?.trim()
        bots.push({ name: entry, description: meta ?? 'starter bot' })
      } catch {
        // 没有 main.js 的目录不是 bot
      }
    }
    return bots
  }

  /** 读取 bot 代码模块（Screeps modules 形状：文件名(无扩展名) → 源码）。 */
  async load(name: string): Promise<Record<string, string>> {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new BotError('badName', `bot name ${name} invalid`)
    let files: string[]
    try {
      files = (await readdir(path.join(this.dir, name))).filter(f => f.endsWith('.js'))
    } catch {
      throw new BotError('notFound', `bot ${name} not found in ${this.dir}`)
    }
    if (!files.includes('main.js')) throw new BotError('noMain', `bot ${name} has no main.js`)
    const modules: Record<string, string> = {}
    for (const file of files) {
      modules[file.slice(0, -3)] = await readFile(path.join(this.dir, name, file), 'utf8')
    }
    return modules
  }
}

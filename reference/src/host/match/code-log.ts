/**
 * M6 code-log —— per-match 代码提交记录（观战代码查看器的数据源）。
 *
 * 设计（plan-M6 §3.1，一审/二审吸收后定案）：
 * - 文件 = <dir>/<matchId>/codes.jsonl（dir 与 MatchStore.dir 同根），一行一条 JSON；
 *   DELETE /matches/:id 已整目录删除（store.ts rm recursive）→ 本文件清理自动成立。
 * - 记录点四处（tools.ts 三分支 + lifecycle.start 注入）；**第五个代码上服点不另记**：
 *   lifecycle.resumeNextRound 的 submitCode 真传内容与记录点 1（roundBreak commit）同份，
 *   观战语义无增量——不要当「漏记」修。
 * - 写入纪律：模块级 promise 链串行追加（tools 与 lifecycle 两个调用方并发不交错）；
 *   appendFile 单行；**记录失败只 log 不抛**——绝不阻塞对局主流程（单测钉死）。
 *   DELETE 与 in-flight append 并发 → ENOENT 自然落入失败只 log 路径，无害。
 * - seq：单局从 1 递增；内存计数器按 matchId 惰性播种 = 既有文件可解析行数（防同目录
 *   重启续写撞号；恢复语义 = interrupted 终态不续写，此为防御性）。
 * - 严禁携带 sessionId（schema 不含 + IT 全文断言兜底）；只记 Agent 主动提交/注入的代码本身，
 *   不记 Memory/console 内容（公平边界：观战公开视角，观察分层不变）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const CODES_FILE = 'codes.jsonl'

export type CodeSource = 'agent-submit' | 'start-injected'

/** 完整条目（内容端点返回 modules；列表端点只给元数据）。 */
export interface CodeEntry {
  seq: number
  ts: number
  username: string
  phase: string
  /** world-rounds 局：提交时所在周期（0 起；非 rounds 局缺省）。 */
  roundIndex?: number
  source: CodeSource
  /** modules 序列化字节数（列表轻量展示用）。 */
  size: number
  modules: Record<string, string>
}

/** 列表端点元数据（不含内容）。 */
export type CodeVersionMeta = Omit<CodeEntry, 'modules'>

export interface CodeListResult {
  versions: CodeVersionMeta[]
  /** 跳过的坏行数（单行 JSON 解析失败；不中断读取）。 */
  badLines: number
}

export interface CodeAppendInput {
  username: string
  phase: string
  roundIndex?: number
  source: CodeSource
  modules: Record<string, string>
}

/** 模块级串行链：跨实例单写者（tools 与 lifecycle 各持引用也不交错）。 */
let chain: Promise<unknown> = Promise.resolve()

function modulesSize(modules: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(modules), 'utf8')
}

export class CodeLog {
  /** matchId → 已播种 seq 计数器（首次 append 时从既有文件行数播种）。 */
  private counters = new Map<string, number>()

  constructor(
    readonly dir: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private filePath(matchId: string): string {
    return path.join(this.dir, matchId, CODES_FILE)
  }

  /** 解析全部行：坏行跳过并计数（读取路径永不抛——文件缺失 = 空列表）。 */
  private async parseAll(matchId: string): Promise<{ entries: CodeEntry[]; badLines: number }> {
    let text: string
    try {
      text = await readFile(this.filePath(matchId), 'utf8')
    } catch {
      return { entries: [], badLines: 0 }
    }
    const entries: CodeEntry[] = []
    let badLines = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed) as CodeEntry
        if (
          typeof parsed?.seq === 'number' &&
          typeof parsed?.ts === 'number' &&
          typeof parsed?.username === 'string' &&
          typeof parsed?.phase === 'string' &&
          (parsed?.source === 'agent-submit' || parsed?.source === 'start-injected') &&
          typeof parsed?.modules === 'object' &&
          parsed.modules !== null
        ) {
          entries.push(parsed)
        } else {
          badLines++
        }
      } catch {
        badLines++
      }
    }
    return { entries, badLines }
  }

  /**
   * 追加一条提交记录。**永不 reject**：任何失败（目录被删/磁盘错）只 log，
   * 调用方（对局主流程）无需也不得以本方法失败改变对局语义。
   */
  append(matchId: string, input: CodeAppendInput): Promise<void> {
    const run = chain.then(async () => {
      try {
        let seq = this.counters.get(matchId)
        if (seq === undefined) {
          const { entries } = await this.parseAll(matchId)
          seq = entries.length
          this.counters.set(matchId, seq)
        }
        seq += 1
        this.counters.set(matchId, seq)
        const entry: CodeEntry = {
          seq,
          ts: Date.now(),
          username: input.username,
          phase: input.phase,
          ...(input.roundIndex !== undefined ? { roundIndex: input.roundIndex } : {}),
          source: input.source,
          size: modulesSize(input.modules),
          modules: input.modules,
        }
        await mkdir(path.join(this.dir, matchId), { recursive: true })
        await appendFile(this.filePath(matchId), JSON.stringify(entry) + '\n', 'utf8')
      } catch (err) {
        this.log(`code-log append failed for ${matchId} (ignored, match flow unaffected): ${(err as Error).message}`)
      }
    })
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 版本列表（元数据，不含内容）。 */
  async list(matchId: string): Promise<CodeListResult> {
    const { entries, badLines } = await this.parseAll(matchId)
    return {
      versions: entries.map(({ modules: _modules, ...meta }) => meta),
      badLines,
    }
  }

  /** 单条内容：解析全文件后按 (username, seq) 过滤（勿用 URL username 拼路径）。 */
  async getEntry(matchId: string, username: string, seq: number): Promise<CodeEntry | undefined> {
    const { entries } = await this.parseAll(matchId)
    return entries.find(e => e.username === username && e.seq === seq)
  }

  /** 分组纯函数：HTTP 列表 DTO 的 players[].versions 形状（按输入顺序，稳定）。 */
  static groupVersions(versions: CodeVersionMeta[]): Array<{ username: string; versions: CodeVersionMeta[] }> {
    const order: string[] = []
    const byUser = new Map<string, CodeVersionMeta[]>()
    for (const v of versions) {
      let list = byUser.get(v.username)
      if (!list) {
        list = []
        byUser.set(v.username, list)
        order.push(v.username)
      }
      list.push(v)
    }
    return order.map(username => ({ username, versions: byUser.get(username)! }))
  }
}

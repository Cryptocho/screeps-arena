/**
 * ScreepsService 裁剪版（M1/S1，plan-M1 §3）—— managed 模式私服生命周期 + 七个最小面。
 * 对照 reference/src/host/service.ts 去 cordis/DSH 化：纯类 + 显式依赖注入，无插件上下文。
 *
 * 七面（plan-M1 一审修复项 1）：createUser / submitCode / getWorld / getTerrain /
 * consoleOutput / system / restart。system 含 setTickDuration/pause/resume/resetArena
 * （对局重置必须走 resetArena，勿用 resetAllData——会毁 v5 格式对象，m0-findings §2）；
 * ok:false 一律抛错（m0-flake 熔断纪律）。
 *
 * 生命周期坑平移（全部有 reference 实证）：
 *   - users.code 带 timestamp（VM 冻结坑，m0-flake §一.1——mod 侧已修，本层不重复）
 *   - 房间生成后 restart（runner 地形缓冲进程级缓存，S7a spike）
 *   - ensure 链内禁 ensureRunning（自死锁坑：await 自身 ensurePromise）
 *   - 进程组 exit guard + 停服先 await 在途 ensure（孤儿进程坑，m0-flake §一.4）
 *   - 停服序列 pause → 10.5s autosave 窗口 → SIGTERM → SIGKILL（launcher 内实现）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ensureNodeRuntime } from './node-runtime.js'
import type { NodeRuntime } from './node-runtime.js'
import { ensureScreepsServer, readArenaSecret } from './server-installer.js'
import type { ServerModFile } from './server-installer.js'
import { launchScreepsServer } from './server-launcher.js'
import type { RunningServer } from './server-launcher.js'

export type ScreepsServiceStatus = 'stopped' | 'provisioning' | 'running' | 'failed'

export interface ScreepsServiceConfig {
  /** 数据目录（私服 serverDir = <dataDir>/server）。 */
  dataDir: string
  /** managed 监听端口；0 = 自动选空闲端口。 */
  port?: number
  /** 便携 Node 主版本（默认 '22'）。 */
  nodeVersion?: string
  /** 覆盖：直接使用指定 node 可执行文件（ABI 必须匹配）。 */
  externalNodeBin?: string
  /** 对局默认 tick 间隔（ms）。 */
  tickDuration?: number
  /** 就绪超时（首次启动要生成世界结构）。 */
  readyTimeoutMs?: number
  /** 随包 mod 文件（arena-mod.cjs 由调用方注入——S2 平移后接线）。 */
  mods?: ServerModFile[]
  /** 安装超时（默认 20 分钟，native 编译慢）。 */
  installTimeoutMs?: number
}

export interface ScreepsWorldSnapshot {
  ok: boolean
  gameTime: number
  users: Array<{
    id: string
    username: string
    isBot: boolean
    cpu: number
    gcl: number
    ownedRooms: number
    rclTotal: number
    spawns: number
    creeps?: number
    rooms: Array<{ room: string; level: number; progress: number }>
  }>
}

export interface ConsoleOutputPage {
  lines: unknown[]
  cursor: number
  bound: boolean
}

export class ScreepsService {
  readonly config: Required<Pick<ScreepsServiceConfig, 'dataDir' | 'tickDuration' | 'readyTimeoutMs' | 'installTimeoutMs'>> &
    ScreepsServiceConfig
  private status: ScreepsServiceStatus = 'stopped'
  private statusDetail = ''
  private ensurePromise: Promise<void> | undefined
  private runtime: NodeRuntime | undefined
  private server: RunningServer | undefined
  private secret: string | undefined
  private exitGuard: (() => void) | undefined
  private readonly log: (msg: string, ...args: unknown[]) => void

  constructor(config: ScreepsServiceConfig, log: (msg: string, ...args: unknown[]) => void = () => {}) {
    this.config = {
      tickDuration: 200,
      readyTimeoutMs: 180_000,
      installTimeoutMs: 20 * 60_000,
      ...config,
    }
    this.log = log
  }

  get serverDir(): string {
    return path.join(this.config.dataDir, 'server')
  }

  get currentStatus(): ScreepsServiceStatus {
    return this.status
  }

  get statusDetailText(): string {
    return this.statusDetail
  }

  /** 幂等：返回时私服已就绪（arena API 可用）。并发调用共享同一次 ensure。 */
  async ensureRunning(): Promise<{ port: number; baseUrl: string }> {
    if (this.status === 'running' && this.server) {
      return { port: this.server.port, baseUrl: this.baseUrl() }
    }
    if (!this.ensurePromise) {
      this.ensurePromise = this.ensure().finally(() => {
        this.ensurePromise = undefined
      })
    }
    await this.ensurePromise
    if (this.status !== 'running' || !this.server) {
      throw new Error(`screeps server not running: ${this.status} ${this.statusDetail}`)
    }
    return { port: this.server.port, baseUrl: this.baseUrl() }
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${this.server!.port}`
  }

  private async ensure(): Promise<void> {
    this.status = 'provisioning'
    this.statusDetail = ''
    try {
      this.runtime = await ensureNodeRuntime({
        runtimeDir: path.join(this.config.dataDir, 'runtime'),
        versionSpec: this.config.nodeVersion ?? '22',
        ...(this.config.externalNodeBin ? { externalNodeBin: this.config.externalNodeBin } : {}),
      })
      this.log('runtime ready: %s', this.runtime.version)
      await ensureScreepsServer({
        serverDir: this.serverDir,
        runtime: this.runtime,
        mods: this.config.mods ?? [],
        simplebotVersion: false,
        installTimeoutMs: this.config.installTimeoutMs,
        onLog: (line) => this.log('%s', line),
      })
      this.secret = await readArenaSecret(this.serverDir)
      this.server = await launchScreepsServer({
        serverDir: this.serverDir,
        runtime: this.runtime,
        ...(this.config.port && this.config.port > 0 ? { port: this.config.port } : {}),
        readyTimeoutMs: this.config.readyTimeoutMs,
        onLog: (line) => this.log('%s', line),
      })
      this.installExitGuard(this.server)
      await this.server.waitReady()
      this.log('server ready on port %s', this.server.port)
      this.status = 'running'
      // 必须走直连 fetch——ensure 链内严禁经 ensureRunning()（await 自身 ensurePromise 自死锁，
      // 22:06 测试超时挂起的根因，reference service.ts 同款注释）。
      const body = (await this.arenaFetchDirect('/api/arena/system', {
        method: 'POST',
        body: JSON.stringify({ cmd: 'setTickDuration', value: this.config.tickDuration }),
      })) as { ok?: boolean; error?: string }
      if (!body?.ok) {
        this.log('setTickDuration failed: %s', body?.error ?? 'unknown')
      }
    } catch (err) {
      this.status = 'failed'
      this.statusDetail = String(err)
      throw err
    }
  }

  /* ---------------- arena 客户端（七面） ---------------- */

  /** 直连版：仅限 ensure 链内部（server 已就绪，不经 ensureRunning，避免自死锁）。 */
  private async arenaFetchDirect(pathname: string, init?: RequestInit): Promise<unknown> {
    if (!this.server) throw new Error('arenaFetchDirect called without a running server')
    return this.rawFetch(this.baseUrl(), pathname, init)
  }

  private async rawFetch(base: string, pathname: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(this.secret ? { 'x-arena-secret': this.secret } : {}),
        ...(init?.headers ?? {}),
      },
    })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`arena ${pathname} -> HTTP ${res.status} non-JSON: ${text.slice(0, 120)}`)
    }
    return body
  }

  private async arenaFetch(pathname: string, init?: RequestInit): Promise<unknown> {
    const { baseUrl } = await this.ensureRunning()
    return this.rawFetch(baseUrl, pathname, init)
  }

  /** 世界快照（观战投影 + 记分原料）。 */
  async getWorld(): Promise<ScreepsWorldSnapshot> {
    return (await this.arenaFetch('/api/arena/world')) as ScreepsWorldSnapshot
  }

  /** 地形位域串（观战坐标地图；2500 字符/房，索引 y*50+x，bit1=wall bit2=swamp）。 */
  async getTerrain(rooms: string[]): Promise<{ terrain: Record<string, string> }> {
    if (rooms.length === 0 || rooms.length > 64) throw new Error('getTerrain: rooms must contain 1..64 names')
    const body = (await this.arenaFetch(`/api/arena/terrain?rooms=${encodeURIComponent(rooms.join(','))}`)) as {
      terrain?: Record<string, string>
    }
    return { terrain: body.terrain ?? {} }
  }

  /** system 控制面（setTickDuration/pause/resume/resetArena/…）。ok:false 一律抛错（熔断纪律）。 */
  async system(cmd: string, value?: unknown): Promise<Record<string, unknown>> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd, ...(value !== undefined ? { value } : {}) }),
    })) as Record<string, unknown>
    if (body && body.ok === false) {
      throw new Error(`arena system ${cmd} failed: ${String(body.error ?? 'unknown')}`)
    }
    return body
  }

  /** 建用户（带 spawn 部署；mod 侧写 users.code 带 timestamp——VM 冻结坑在 mod 修）。 */
  async createUser(input: {
    username: string
    room: string
    code?: Record<string, string>
    cpu?: number
    gcl?: number
    x?: number
    y?: number
  }): Promise<{ id: string; username: string }> {
    const body = (await this.arenaFetch('/api/arena/users', {
      method: 'POST',
      body: JSON.stringify(input),
    })) as { ok: boolean; error?: string; user?: { id: string; username: string } }
    if (!body.ok || !body.user) throw new Error(`createUser failed: ${body.error ?? 'unknown'}`)
    return body.user
  }

  /** 上传/热更代码。branch 默认 '$activeWorld'（下一 tick 生效）。 */
  async submitCode(username: string, modules: Record<string, string>, branch = '$activeWorld'): Promise<{ timestamp: number }> {
    const token = await this.getToken(username)
    const { baseUrl } = await this.ensureRunning()
    const res = await fetch(`${baseUrl}/api/user/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-username': username, 'x-token': token },
      body: JSON.stringify({ branch, modules }),
    })
    const body = (await res.json()) as { ok?: number; error?: string; timestamp?: number }
    if (!res.ok || body.ok !== 1) {
      throw new Error(`submitCode failed: ${body.error ?? `HTTP ${res.status}`}`)
    }
    return { timestamp: body.timestamp ?? Date.now() }
  }

  /** 指定用户自上次游标以来的 console 消息（arena-mod ring buffer）。 */
  async consoleOutput(username: string, since?: number): Promise<ConsoleOutputPage> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd: 'consoleOutput', value: { user: username, since } }),
    })) as { ok: boolean; lines?: unknown[]; cursor?: number; bound?: boolean; error?: string }
    if (body.ok !== true) throw new Error(`consoleOutput failed: ${body.error ?? 'unknown'}`)
    return { lines: body.lines ?? [], cursor: body.cursor ?? 0, bound: body.bound ?? false }
  }

  private async getToken(username: string): Promise<string> {
    const body = (await this.arenaFetch('/api/arena/token', {
      method: 'POST',
      body: JSON.stringify({ username }),
    })) as { ok: boolean; token?: string }
    if (!body.ok || !body.token) throw new Error(`getToken failed for ${username}`)
    return body.token
  }

  /* ---------------- restart / shutdown ---------------- */

  /**
   * 重启私服（managed 模式）。必要性（S7a spike）：runner 把地形缓存进
   * staticTerrainData（进程级），generateRoom 之后新建的房间不在缓冲区 →
   * 该房所有用户 run 抛 "Could not load terrain data"。官方无刷新钩子，必须重启。
   */
  async restart(options: { resume?: boolean } = {}): Promise<void> {
    this.log('restarting server to refresh runner terrain cache')
    const server = this.server
    this.server = undefined
    if (server) {
      try {
        await server.stop()
      } finally {
        this.removeExitGuard()
        this.status = 'stopped'
      }
    }
    this.ensurePromise = undefined
    await this.ensureRunning()
    if (options.resume !== false) await this.system('resume')
  }

  /**
   * 优雅停服。顺序：先 await 在途 ensure（dispose 早于就绪时不漏半拉起的组——孤儿坑），
   * 再 stop()（pause → 10.5s autosave 窗口 → SIGTERM → SIGKILL，launcher 内），
   * 最后才注销 exit guard（stop 期间宿主退出仍有人 SIGKILL 进程组）。
   */
  async shutdown(): Promise<void> {
    if (this.ensurePromise) {
      await this.ensurePromise.catch(() => {})
    }
    const server = this.server
    if (!server) return
    this.server = undefined
    try {
      await server.stop()
    } finally {
      this.removeExitGuard()
      this.status = 'stopped'
    }
  }

  /** 宿主未走 shutdown 就退出时的兜底：同步 SIGKILL 整个进程组（不给 detached 组变孤儿）。 */
  private installExitGuard(server: RunningServer): void {
    this.removeExitGuard()
    const pgid = server.child.pid
    if (pgid === undefined) return
    const guard = (): void => {
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        /* 进程组已不存在 */
      }
    }
    this.exitGuard = guard
    process.on('exit', guard)
  }

  private removeExitGuard(): void {
    if (this.exitGuard) {
      process.off('exit', this.exitGuard)
      this.exitGuard = undefined
    }
  }
}

/** 供调用方构造 mod 文件（S2 平移后接线用）。 */
export function modFileFromContent(name: string, content: string): ServerModFile {
  if (name.includes('/') || name.includes('..')) throw new Error(`mod file name must be flat: "${name}"`)
  return { name, content }
}

/** re-export：调用方（S3/S4）需要的类型与函数。 */
export { ensureNodeRuntime, ensureScreepsServer, readArenaSecret, launchScreepsServer }
export type { NodeRuntime, RunningServer, ServerModFile }
export const _fs = fs

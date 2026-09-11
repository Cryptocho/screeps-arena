/**
 * S3 服务器启动器：以独立进程组拉起 Screeps 私服，等待健康，优雅停止。
 *
 * 生命周期（AGENTS.md 红线）：
 *   spawn（detached，进程组 leader）→ 轮询 /api/game/time 至 200 → 运行
 *   stop(): POST /api/arena/system pause（尽力而为）→ SIGTERM 进程组 → 超时 SIGKILL
 *
 * 已验证事实：
 * - launcher 从 cwd 读取 .screepsrc（故 spawn cwd 必须是 serverDir）；
 * - 端口用 CLI 参数覆盖 .screepsrc（README 记载的 start 选项）；
 * - linux 上 storage 走 unix socket，cli 端口 = port+1；
 * - isolated-vm 等原生模块只在便携 Node ABI 下可用，必须用 runtime.nodeBin 启动。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import type { NodeRuntime } from './node-runtime.ts'
import { readArenaSecret } from './server-installer.ts'

export type LaunchErrorCode = 'spawn-failed' | 'not-ready' | 'stop-failed'

export class LaunchError extends Error {
  constructor(
    public readonly code: LaunchErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'LaunchError'
  }
}

export interface ServerLaunchOptions {
  serverDir: string
  runtime: NodeRuntime
  /** 默认取空闲端口。 */
  port?: number
  /** 就绪超时，默认 120s（首次启动要生成世界结构）。 */
  readyTimeoutMs?: number
  onLog?: (line: string) => void
}

export interface RunningServer {
  port: number
  cliPort: number
  /** launcher 进程（进程组 leader）。 */
  child: ChildProcess
  waitReady(): Promise<void>
  /** 优雅停止：pause → SIGTERM 进程组 → 超时 SIGKILL。幂等。 */
  stop(): Promise<void>
  /** 进程组是否仍存活。 */
  isAlive(): boolean
}

/** 取一个当前空闲的 TCP 端口（本地开发足够；存在理论竞态，接受）。 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const { port } = address
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new LaunchError('spawn-failed', 'no port from listen(0)')))
      }
    })
  })
}

export async function launchScreepsServer(options: ServerLaunchOptions): Promise<RunningServer> {
  const { serverDir, runtime } = options
  if (!existsSync(path.join(serverDir, '.screepsrc'))) {
    throw new LaunchError('spawn-failed', `${serverDir} is not an initialized server dir (missing .screepsrc)`)
  }
  const port = options.port ?? (await findFreePort())
  const cliPort = port + 1
  const onLog = options.onLog ?? (() => {})
  await mkdir(path.join(serverDir, 'logs'), { recursive: true })

  // node <screeps bin> start --port ...；bin/screeps.js 转发到 @screeps/launcher
  const screepsBin = path.join(serverDir, 'node_modules', '@screeps', 'launcher', 'bin', 'screeps.js')
  const entry = existsSync(screepsBin)
    ? screepsBin
    : path.join(serverDir, 'node_modules', '.bin', 'screeps')
  if (!existsSync(entry)) {
    throw new LaunchError('spawn-failed', `screeps launcher entry not found under ${serverDir}/node_modules`)
  }

  const child = spawn(runtime.nodeBin, [entry, 'start', '--port', String(port), '--cli_host', '127.0.0.1'], {
    cwd: serverDir,
    detached: true, // 独立进程组：launcher + storage + backend + runners 全在 -pid 组里
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${runtime.binDir}${path.delimiter}${process.env.PATH ?? ''}` },
  })

  const logStream = async (chunk: Buffer, isErr: boolean): Promise<void> => {
    for (const line of chunk.toString().split('\n')) {
      if (line.length > 0) onLog(`[screeps${isErr ? ':err' : ''}] ${line}`)
    }
    const { appendFile } = await import('node:fs/promises')
    await appendFile(path.join(serverDir, 'logs', 'server.log'), chunk).catch(() => {})
  }
  child.stdout?.on('data', (chunk: Buffer) => void logStream(chunk, false))
  child.stderr?.on('data', (chunk: Buffer) => void logStream(chunk, true))

  let exited = new Promise<void>(resolve => {
    child.on('exit', () => resolve())
  })
  child.on('error', err => onLog(`[screeps] spawn error: ${String(err)}`))

  const secret = await readArenaSecret(serverDir)
  let stopPromise: Promise<void> | undefined

  async function waitReady(): Promise<void> {
    const timeoutMs = options.readyTimeoutMs ?? 120_000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new LaunchError('not-ready', `screeps exited (code=${child.exitCode}) before becoming ready`)
      }
      if (await probeTime(port)) return
      await sleep(500)
    }
    throw new LaunchError('not-ready', `screeps not ready within ${timeoutMs}ms (port ${port})`)
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      // 1) 尽力而为：暂停世界（新 tick 不再开始）
      let paused = false
      try {
        await fetch(`http://127.0.0.1:${port}/api/arena/system`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(secret ? { 'x-arena-secret': secret } : {}),
          },
          body: JSON.stringify({ cmd: 'pause' }),
          signal: AbortSignal.timeout(3000),
        }).then(r => r.json())
        paused = true
      } catch {
        onLog('[screeps] pause before stop failed (server may already be down)')
      }
      // 2) 持久化窗口：LokiJS autosave 间隔 10s（storage/lib/db.js dbOptions），pause 后
      //    等一个完整周期，保证最近的写入（建用户/代码上传）已落盘，否则重启丢数据。
      if (paused) {
        onLog('[screeps] waiting 10.5s for storage autosave before kill')
        await sleep(10_500)
      }
      // 3) SIGTERM 进程组
      if (isAlive()) {
        try {
          process.kill(-child.pid!, 'SIGTERM')
        } catch {
          onLog('[screeps] SIGTERM to process group failed')
        }
      }
      // 4) 有界等待：5s 宽限 → SIGKILL 进程组 → 再给 3s；全程有限时间，绝不挂起
      const graceDeadline = Date.now() + 5000
      while (isAlive() && Date.now() < graceDeadline) await sleep(100)
      if (isAlive()) {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          /* 已经死了 */
        }
      }
      const hardDeadline = Date.now() + 3000
      while (isAlive() && Date.now() < hardDeadline) await sleep(100)
      onLog(isAlive() ? '[screeps] stop: still alive after SIGKILL?!' : '[screeps] stopped')
    })()
    return stopPromise
  }

  function isAlive(): boolean {
    if (child.pid === undefined) return false
    if (child.exitCode !== null) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch {
      return false
    }
  }

  return { port, cliPort, child, waitReady, stop, isAlive }
}

async function probeTime(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/game/time`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return false
    const data = (await res.json()) as { time?: number }
    return typeof data.time === 'number' && data.time > 0
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

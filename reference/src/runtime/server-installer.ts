/**
 * S2 私服安装器：在插件数据目录里准备一个可运行的 Screeps 私服。
 *
 * 职责（幂等，可反复调用）：
 * 1. 写服务器目录的基础文件：package.json / .screepsrc / mods.json / arena mod / 空目录；
 * 2. 工具链预检（python3 + make + g++ + git——isolated-vm 是 GitHub 依赖，git 必须可用）；
 * 3. 用 S1 便携运行时执行 `npm install`（原生编译都发生在便携 ABI 下）；
 * 4. 校验原生编译产物与 webpack 产物；
 * 5. 用 `@screeps/storage` 自带的 db.original.json 模板播种初始世界（仅当 db.json 不存在）。
 *
 * 设计约束：
 * - 端口等启动参数不写死在 .screepsrc（S3 启动时用 CLI 参数覆盖），.screepsrc 只承载静态默认值；
 * - npm install 按 {screepsVersion, nodeVersion} 指纹跳过；mod 文件与 mods.json 每次都重写；
 * - 安装日志落盘 serverDir/install.log，同时通过 onLog 回调外送。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { NodeRuntime } from './node-runtime.ts'

const execFileP = promisify(execFileCb)

export const DEFAULT_SCREEPS_VERSION = '4.3.0'
export const DEFAULT_SIMPLEBOT_VERSION = '1.0.1'

export type InstallErrorCode =
  | 'toolchain-missing'
  | 'npm-install-failed'
  | 'artifact-missing'
  | 'seed-failed'

export class InstallError extends Error {
  constructor(
    public readonly code: InstallErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'InstallError'
  }
}

export interface ServerModFile {
  /** 相对 serverDir 的文件名，如 'arena-mod.js'。 */
  name: string
  content: string
}

export interface ServerInstallOptions {
  serverDir: string
  runtime: NodeRuntime
  screepsVersion?: string
  simplebotVersion?: string | false
  /** 随包分发的 mod 文件（每次重写）。 */
  mods?: ServerModFile[]
  /** 注册进 mods.json bots 字段的静态 AI：botAiName → 相对 serverDir 的路径。 */
  bots?: Record<string, string>
  installTimeoutMs?: number
  onLog?: (line: string) => void
}

export interface ServerInstallResult {
  serverDir: string
  nodeModules: string
  artifacts: string[]
  screepsVersion: string
  installSkipped: boolean
}

/* ------------------------------------------------------------------ */
/* 配置文件内容                                                        */
/* ------------------------------------------------------------------ */

export function screepsrcContent(): string {
  return [
    '; dsh-screeps managed private server (generated)',
    '; 端口在启动时通过 CLI 参数注入，这里只写静态默认值。',
    'steam_api_key = dsh-screeps-placeholder',
    'host = 127.0.0.1',
    'cli_host = 127.0.0.1',
    'password =',
    'runners_cnt = 1',
    'runner_threads = 2',
    'processors_cnt = 1',
    'logdir = logs',
    'modfile = mods.json',
    'assetdir = assets',
    'db = db.json',
    'log_console = false',
    'log_rotate_keep = 5',
    'storage_disabled = false',
    '',
  ].join('\n')
}

export function serverPackageJson(screepsVersion: string, simplebotVersion: string | false): string {
  const deps: Record<string, string> = { screeps: screepsVersion }
  if (simplebotVersion !== false) deps['@screeps/simplebot'] = simplebotVersion
  return `${JSON.stringify({ name: 'dsh-screeps-server', version: '0.0.0', private: true, dependencies: deps }, null, 2)}\n`
}

export function modsJsonContent(modNames: string[], bots: Record<string, string>): string {
  return `${JSON.stringify({ mods: modNames, bots }, null, 2)}\n`
}

/* ------------------------------------------------------------------ */
/* 工具链预检                                                          */
/* ------------------------------------------------------------------ */

export async function checkToolchain(): Promise<Record<string, string>> {
  const tools = ['python3', 'make', 'g++', 'git'] as const
  const found: Record<string, string> = {}
  const missing: string[] = []
  for (const tool of tools) {
    try {
      const { stdout } = await execFileP(tool, ['--version'], { encoding: 'utf8' })
      found[tool] = stdout.split('\n')[0]?.trim() ?? 'ok'
    } catch {
      missing.push(tool)
    }
  }
  if (missing.length > 0) {
    throw new InstallError(
      'toolchain-missing',
      `native module compilation requires: ${missing.join(', ')}. ` +
        'Install build tools first (Debian/Ubuntu: apt install build-essential python3 git; macOS: xcode-select --install).',
    )
  }
  return found
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export async function ensureScreepsServer(options: ServerInstallOptions): Promise<ServerInstallResult> {
  const { serverDir, runtime } = options
  const screepsVersion = options.screepsVersion ?? DEFAULT_SCREEPS_VERSION
  const simplebotVersion = options.simplebotVersion ?? DEFAULT_SIMPLEBOT_VERSION
  const mods = options.mods ?? []
  const bots = options.bots ?? {}
  const log = options.onLog ?? (() => {})

  await mkdir(serverDir, { recursive: true })
  await mkdir(path.join(serverDir, 'assets'), { recursive: true })
  // generateRoom 会往 assets/map/[zoomN/]<room>.png 写地图预览（WriteStream ENOENT 会崩掉 backend）
  await mkdir(path.join(serverDir, 'assets', 'map', 'zoom2'), { recursive: true })
  await mkdir(path.join(serverDir, 'assets', 'map', 'zoom4'), { recursive: true })
  await mkdir(path.join(serverDir, 'assets', 'map', 'zoom8'), { recursive: true })
  await mkdir(path.join(serverDir, 'logs'), { recursive: true })

  // 基础文件每次都重写（它们是插件的产物，不是用户数据）
  await writeFile(path.join(serverDir, 'package.json'), serverPackageJson(screepsVersion, simplebotVersion))
  await writeFile(path.join(serverDir, '.screepsrc'), screepsrcContent())
  await writeFile(path.join(serverDir, 'mods.json'), modsJsonContent(mods.map(m => m.name), bots))
  for (const mod of mods) {
    if (mod.name.includes('/') || mod.name.includes('..')) {
      throw new InstallError('seed-failed', `mod file name must be flat: "${mod.name}"`)
    }
    await writeFile(path.join(serverDir, mod.name), mod.content)
  }

  // db.json 播种：仅当不存在（绝不覆盖已有世界）
  const dbPath = path.join(serverDir, 'db.json')
  if (!existsSync(dbPath)) {
    const template = path.join(serverDir, 'node_modules', '@screeps', 'storage', 'db.original.json')
    if (existsSync(template)) {
      await copyFile(template, dbPath)
      log('seeded db.json from @screeps/storage db.original.json')
    }
    // 首次安装时 node_modules 还不存在——播种在 npm install 之后由第二次调用或本函数末尾补做
  }

  // npm install 指纹判断
  const nodeModules = path.join(serverDir, 'node_modules')
  const markerPath = path.join(nodeModules, '.dsh-screeps-server.json')
  const fingerprint = JSON.stringify({
    screepsVersion,
    simplebot: simplebotVersion === false ? null : simplebotVersion,
    nodeVersion: runtime.version,
  })
  let installSkipped = false
  if (existsSync(markerPath)) {
    try {
      const existing = await readFile(markerPath, 'utf8')
      installSkipped = existing.trim() === fingerprint
      if (installSkipped) log(`npm install skipped (fingerprint matches: ${fingerprint})`)
    } catch {
      // 损坏的 marker → 重装
    }
  }

  if (!installSkipped) {
    await checkToolchain()
    await runNpmInstall(serverDir, runtime, options.installTimeoutMs ?? 20 * 60_000, log)
  }

  const artifacts = await verifyArtifacts(nodeModules, log)

  // [M2 fix] Screeps engine runtime.bundle.js 在 VM _start 里调 JSON.parse(data.accessibleRooms)，
  // 当 storage env key ACCESSIBLE_ROOMS 丢失（storage daemon 不跨重启存活、或时序竞争）时，
  // data.accessibleRooms 为 undefined → JSON.parse(undefined) 抛 '"undefined" is not valid JSON'。
  // 补丁：加 fallback `|| "[]"`，让引擎在未设 accessibleRooms 时退化为空房间列表而非崩溃。
  // ISC 许可下对 @screeps/driver 的修改需保留版权声明（webpack bundle 不嵌入许可证文本，
  // 但 README/LICENSE.txt 原样保留 + patch 仅修改 JS 字节、不触动许可证文件；改动记录在 LOG）。
  await patchDriverBundle(nodeModules, log, runtime)

  // 播种（npm install 后 node_modules 必然存在）
  if (!existsSync(dbPath)) {
    const template = path.join(nodeModules, '@screeps', 'storage', 'db.original.json')
    if (!existsSync(template)) {
      throw new InstallError('seed-failed', `db template not found at ${template}`)
    }
    await copyFile(template, dbPath)
    log('seeded db.json from @screeps/storage db.original.json')
  }

  if (!installSkipped) {
    await writeFile(markerPath, fingerprint)
  }

  // arena 控制面共享密钥：host 与 mod 共享；只生成，绝不覆盖
  const secretPath = path.join(serverDir, '.dsh-arena-secret')
  if (!existsSync(secretPath)) {
    await writeFile(secretPath, randomBytes(24).toString('hex'))
    log('generated .dsh-arena-secret')
  }

  return { serverDir, nodeModules, artifacts, screepsVersion, installSkipped }
}

/** 读取 arena 控制面共享密钥（host 侧调用）。 */
export async function readArenaSecret(serverDir: string): Promise<string | undefined> {
  try {
    const content = await readFile(path.join(serverDir, '.dsh-arena-secret'), 'utf8')
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

async function runNpmInstall(serverDir: string, runtime: NodeRuntime, timeoutMs: number, log: (line: string) => void): Promise<void> {
  const logPath = path.join(serverDir, 'install.log')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  // 便携 bin 目录放最前：node-gyp / npm / node 都解析到便携运行时
  env.PATH = `${runtime.binDir}${path.delimiter}${env.PATH ?? ''}`

  // 直接用 node 执行 npm-cli.js，避免依赖 shebang/执行位
  const npmCli = path.join(runtime.binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const [npmFile, npmArgs] = existsSync(npmCli)
    ? [runtime.nodeBin, [npmCli]]
    : [runtime.npmBin, []]

  log(`npm install starting in ${serverDir} (node ${runtime.version})`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmFile, [...npmArgs, 'install', '--foreground-scripts', '--no-audit', '--no-fund', '--loglevel', 'warn'], {
      cwd: serverDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timer: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new InstallError('npm-install-failed', `npm install timed out after ${timeoutMs}ms (see ${logPath})`))
    }, timeoutMs)

    const logStream = async (chunk: Buffer, isErr = false): Promise<void> => {
      const text = chunk.toString()
      for (const line of text.split('\n')) {
        if (line.length > 0) log(`[npm]${isErr ? '[err]' : ''} ${line}`)
      }
      const { appendFile } = await import('node:fs/promises')
      await appendFile(logPath, text).catch(() => {})
    }
    child.stdout.on('data', (chunk: Buffer) => void logStream(chunk))
    child.stderr.on('data', (chunk: Buffer) => void logStream(chunk, true))
    child.on('error', err => {
      cleanup()
      reject(new InstallError('npm-install-failed', `failed to spawn npm: ${String(err)}`, { cause: err }))
    })
    child.on('exit', (code, signal) => {
      cleanup()
      if (code === 0) {
        log('npm install finished')
        resolve()
      } else {
        reject(
          new InstallError(
            'npm-install-failed',
            `npm install exited with code=${code} signal=${signal ?? 'null'} (full log: ${logPath})`,
          ),
        )
      }
    })
  })
}

/** 编译产物校验：driver native / isolated-vm / pathfinding 包 / driver webpack bundle。 */
export async function verifyArtifacts(nodeModules: string, log: (line: string) => void): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const found: string[] = []

  const findRec = async (dir: string, match: (f: string) => boolean, depth = 0): Promise<string[]> => {
    if (depth > 6) return []
    const out: string[] = []
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await findRec(full, match, depth + 1)))
      else if (match(entry.name)) out.push(full)
    }
    return out
  }

  const checks: Array<{ label: string; root: string; match: (f: string) => boolean }> = [
    // 真正需要原生编译的只有两处：driver native 与 isolated-vm（nan 链，ABI 敏感）
    {
      label: 'driver native addon',
      root: path.join(nodeModules, '@screeps', 'driver', 'native', 'build'),
      match: f => f.endsWith('.node'),
    },
    {
      label: 'isolated-vm addon',
      root: path.join(nodeModules, 'isolated-vm'),
      match: f => f.endsWith('.node'),
    },
    // pathfinding 是纯 JS（PathFinding.js fork），只验证包本体存在
    {
      label: 'pathfinding package',
      root: path.join(nodeModules, '@screeps', 'pathfinding'),
      match: f => f === 'index.js',
    },
    {
      label: 'driver webpack bundle',
      root: path.join(nodeModules, '@screeps', 'driver', 'build'),
      match: f => f.endsWith('.js'),
    },
  ]

  for (const check of checks) {
    const hits = await findRec(check.root, check.match)
    if (hits.length === 0) {
      throw new InstallError('artifact-missing', `post-install verification failed: ${check.label} not found under ${check.root}`)
    }
    found.push(...hits)
    log(`verified ${check.label}: ${hits[0]}`)
  }
  return found
}

/**
 * [M2 fix] 给 @screeps/driver runtime.bundle.js 打补丁防止 storage env 缺失时崩服：
 * 把 `JSON.parse(<expr>.accessibleRooms)` 调成 `JSON.parse(<expr>.accessibleRooms || "[]")`。
 * 见 server-installer.ts L205-209 + LOG M2 条目。
 *
 * 工作流：
 *   1. bundle patch（加 fallback；幂等，命中 0 视为 driver 升级，跳过 patch）
 *   2. snapshot 重建：`make-runtime-snapshot.js`（V8 isolate cache from bundle；
 *      driver/lib/runtime/user-vm.js L154 消费；不重建 → VM 仍跑 pre-patch 字节码。
 *      证据：tools.it 报 `Unexpected end of JSON input at <runtime>:16017` —
 *      那行原值 `JSON.parse(data.accessibleRooms)` 已被 patch 加 fallback，但
 *      snapshot 由 patch 前的 bundle 序列化而来，仍是 pre-patch 字节码。）
 *   3. 写 marker `<driverDir>/.dsh-screeps-driver-patched`：含 patched hash + 时间戳。
 *
 * 幂等：sentinel `// dsh-screeps patch: accessibleRooms-fallback` 写在 bundle 末尾 +
 * marker hash + snapshot mtime。三层中任一缺失都触发 action；全齐且 hash 匹配 → skip。
 *
 * 安装期不抛 InstallError：patch/snapshot 任一失败仅记日志，install 仍按 npm 状态推进；
 * 失败信号靠 probe——这不是合法的 SILENT 退路。
 *
 * ISC：webpack bundle 不内嵌许可证文本，需保留的是源码包的 LICENSE.txt/README.md（不动）；
 * 本函数只改 JS 字节，不重打包；改动记录在 LOG。
 */
export async function patchDriverBundle(
  nodeModules: string,
  log: (line: string) => void,
  runtime?: NodeRuntime,
): Promise<void> {
  const driverDir = path.join(nodeModules, '@screeps', 'driver')
  const bundlePath = path.join(driverDir, 'build', 'runtime.bundle.js')
  const snapshotPath = path.join(driverDir, 'build', 'runtime.snapshot.bin')
  const markerPath = path.join(driverDir, '.dsh-screeps-driver-patched')
  const sentinel = '// dsh-screeps patch: accessibleRooms-fallback'
  if (!existsSync(bundlePath)) {
    log(`patchDriverBundle: bundle not found at ${bundlePath} (skip)`)
    return
  }
  let source: string
  try {
    source = await readFile(bundlePath, 'utf8')
  } catch (err) {
    log(`patchDriverBundle: read failed: ${String(err)} (skip)`)
    return
  }

  let patchedBundle = false
  let hitCount = 0
  const pattern = /JSON\.parse\(([A-Za-z_$][\w$]*\.accessibleRooms)\)(?!\s*\|\|)/g
  if (source.includes(sentinel)) {
    log('patchDriverBundle: bundle sentinel present — skip patch step')
  } else {
    // 匹配 `JSON.parse(<identifier>.accessibleRooms)`（避免重写已打过补丁的 `... || "[]")`）。
    hitCount = source.match(pattern)?.length ?? 0
    const hasFallbacks =
      source.includes('JSON.parse(data.accessibleRooms || "[]")') &&
      source.includes('JSON.parse(runtimeData.accessibleRooms || "[]")')
    if (hitCount === 0 && !hasFallbacks) {
      log(`patchDriverBundle: no JSON.parse(.accessibleRooms) hit in ${bundlePath} and fallback is absent (driver upgraded; skip)`)
      return
    }
    if (hitCount > 0) {
      const patched = source.replace(pattern, (_match, expr: string) => `JSON.parse(${expr} || "[]")`)
      const banner = `\n// @screeps/driver ISC license preserved; see node_modules/@screeps/driver/LICENSE.txt for original notice.\n${sentinel}\n`
      try {
        await writeFile(bundlePath, patched + banner, 'utf8')
        source = patched + banner
        patchedBundle = true
        log(`patchDriverBundle: patched ${hitCount} call site(s) in ${bundlePath}`)
      } catch (err) {
        log(`patchDriverBundle: write failed: ${String(err)} (skip)`)
        return
      }
    } else {
      log('patchDriverBundle: fallback already present without local sentinel — rebuilding snapshot')
    }
  }

  // plain data.js 也有一个必须修的 in-flight cache 竞态：两个用户首 tick 并发进入
  // getAccessibleRooms() 时，第二个调用会直接拿到尚未 resolve 的 undefined，随后
  // runtimeData.get() 的 `result[7] || []` 把它变成 []，VM 再 JSON.parse([]) 崩溃。
  // 该文件不进 runtime snapshot，单独做幂等文本补丁。
  await patchAccessibleRoomsInflight(driverDir, log)

  // 重建 snapshot — 三条件：marker 缺 / hash mismatch / snapshot 比 bundle 旧 / snapshot 缺
  const currentHash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const recorded = await readMarker(markerPath).catch(() => null)
  const snapshotFresh = existsSync(snapshotPath) && snapshotMtimeNewer(snapshotPath, bundlePath)
  if (!patchedBundle && recorded?.bundleHash === currentHash && snapshotFresh) {
    log('patchDriverBundle: bundle + marker + snapshot in sync — skip')
    return
  }

  if (!runtime) {
    log('patchDriverBundle: runtime not provided — skipping snapshot rebuild (next install will redo)')
    return
  }
  const snapshotScript = path.join(driverDir, 'make-runtime-snapshot.js')
  if (!existsSync(snapshotScript)) {
    log(`patchDriverBundle: make-runtime-snapshot.js not found at ${snapshotScript} (skip snapshot)`)
    return
  }
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const child = spawn(runtime.nodeBin, [snapshotScript], {
      cwd: driverDir,
      env: { ...process.env, PATH: `${runtime.binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) if (line.length > 0) log(`[snapshot] ${line}`)
    })
    child.stderr?.on('data', (buf: Buffer) => log(`[snapshot][err] ${buf.toString().trimEnd()}`))
    child.on('exit', (code, signal) => resolve({ code, signal }))
    child.on('error', (err) => {
      log(`patchDriverBundle: spawn failed: ${String(err)}`)
      resolve({ code: -1, signal: null })
    })
  })
  if (result.code !== 0) {
    log(`patchDriverBundle: snapshot rebuild exited code=${result.code} signal=${result.signal} (skip marker)`)
    return
  }
  try {
    await writeFile(
      markerPath,
      JSON.stringify({ patchedAt: new Date().toISOString(), bundleHash: currentHash, hitCount }, null, 2),
      'utf8',
    )
    log(`patchDriverBundle: snapshot regenerated + marker written (hash=${currentHash})`)
  } catch (err) {
    log(`patchDriverBundle: marker write failed: ${String(err)} (skip)`)
  }
}

async function readMarker(file: string): Promise<{ bundleHash?: string } | null> {
  try {
    const txt = await readFile(file, 'utf8')
    return JSON.parse(txt) as { bundleHash?: string }
  } catch {
    return null
  }
}

function snapshotMtimeNewer(snapshotPath: string, bundlePath: string): boolean {
  try {
    const s = statSync(snapshotPath)
    const b = statSync(bundlePath)
    return s.mtimeMs >= b.mtimeMs
  } catch {
    return false
  }
}

/**
 * @screeps/driver data.js 的 accessibleRooms cache 原本没有 in-flight 复用：
 * 同一首 tick 并发 get() 时，第二个调用会在第一个 env.get() resolve 前拿到 undefined。
 * 这是 M2 tools.it 的实测根因（同一 runner：tool_b 得到字符串、tool_a 得到 []）。
 */
async function patchAccessibleRoomsInflight(driverDir: string, log: (line: string) => void): Promise<void> {
  const file = path.join(driverDir, 'lib', 'runtime', 'data.js')
  const marker = '// dsh-screeps patch: accessibleRooms-inflight'
  if (!existsSync(file)) {
    log(`patchDriverBundle: data.js not found at ${file} (skip in-flight patch)`)
    return
  }
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch (err) {
    log(`patchDriverBundle: data.js read failed: ${String(err)} (skip in-flight patch)`)
    return
  }
  if (source.includes(marker)) {
    log('patchDriverBundle: accessibleRooms in-flight patch already present — skip')
    return
  }
  const oldCache = `    accessibleRoomsCache = {\n        timestamp: 0\n    },`
  const newCache = `    accessibleRoomsCache = {\n        timestamp: 0,\n        pending: null\n    },`
  const oldFunction = `function getAccessibleRooms() {\n    if(Date.now() > accessibleRoomsCache.timestamp + 60*1000) {\n        accessibleRoomsCache.timestamp = Date.now();\n        return env.get(env.keys.ACCESSIBLE_ROOMS).then(data => {\n            accessibleRoomsCache.data = data;\n            return accessibleRoomsCache.data;\n        });\n    }\n    return q.when(accessibleRoomsCache.data);\n}`
  const newFunction = `function getAccessibleRooms() {\n    // Share the first env.get promise across concurrent users. Without this, a second\n    // caller observes cache.data === undefined while the first RPC is still pending.\n    if (accessibleRoomsCache.pending) return accessibleRoomsCache.pending;\n    if(Date.now() > accessibleRoomsCache.timestamp + 60*1000) {\n        accessibleRoomsCache.timestamp = Date.now();\n        accessibleRoomsCache.pending = env.get(env.keys.ACCESSIBLE_ROOMS).then(data => {\n            accessibleRoomsCache.data = data;\n            accessibleRoomsCache.pending = null;\n            return accessibleRoomsCache.data;\n        }, err => {\n            accessibleRoomsCache.pending = null;\n            throw err;\n        });\n        return accessibleRoomsCache.pending;\n    }\n    return q.when(accessibleRoomsCache.data);\n}\n${marker}`
  if (!source.includes(oldCache) || !source.includes(oldFunction)) {
    log(`patchDriverBundle: data.js accessibleRooms shape changed; skip in-flight patch`)
    return
  }
  try {
    await writeFile(file, source.replace(oldCache, newCache).replace(oldFunction, newFunction), 'utf8')
    log(`patchDriverBundle: applied accessibleRooms in-flight patch to ${file}`)
  } catch (err) {
    log(`patchDriverBundle: data.js write failed: ${String(err)} (skip in-flight patch)`)
  }
}

/** 供 S6 组合：把仓库内的 mod 源文件读成 ServerModFile。 */
export async function modFileFromPath(filePath: string, name?: string): Promise<ServerModFile> {
  return { name: name ?? path.basename(filePath), content: await readFile(filePath, 'utf8') }
}

export function modContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

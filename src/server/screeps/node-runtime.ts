/**
 * S1 便携 Node 运行时供给。
 *
 * 私服（screeps 4.3.x）的原生编译链（isolated-vm@nan / driver native / pathfinding）
 * 只能在 Node 22/24 ABI 下编译与运行；宿主机可能是 Node 26（本机实测不兼容）。
 * 因此插件默认从 nodejs.org dist 下载 pinned LTS 的官方二进制，缓存到插件数据目录，
 * 私服的安装与启动全部使用这套便携运行时。
 *
 * 设计约束：
 * - 纯 Node 标准库，零 npm 依赖；
 * - 下载器与进程执行可注入，单测不依赖网络；
 * - 幂等：已就绪的运行时（marker + `node -v` 校验）直接复用；
 * - 并发：进程内按指纹去重，多个 fiber 同时进入只下载一次；
 * - 原子性：下载写 .part 后 rename，解压进 staging 目录后 rename（no-clobber）。
 */
import { createHash } from 'node:crypto'
import { execFile as execFileCb } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFileCb)

export const DEFAULT_DIST_MIRROR = 'https://nodejs.org/dist'

export type ProvisionErrorCode =
  | 'unsupported-platform'
  | 'invalid-version-spec'
  | 'version-not-found'
  | 'checksum-mismatch'
  | 'external-bin-invalid'
  | 'external-bin-version-mismatch'
  | 'download-failed'
  | 'extract-failed'
  | 'runtime-verify-failed'

export class ProvisionError extends Error {
  constructor(
    public readonly code: ProvisionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ProvisionError'
  }
}

export interface NodeRuntimeOptions {
  /** 运行时根目录；便携 Node 解压在 `<runtimeDir>/node-v<ver>-<key>/`。必填。 */
  runtimeDir: string
  /** 语义化版本前缀：'22' | '22.20' | '22.20.0'。默认 '22'。 */
  versionSpec?: string
  /** dist 镜像，默认官方 nodejs.org/dist，可指向镜像站。 */
  distMirror?: string
  /** 指定已有 node 可执行文件（如系统 node）时跳过下载；主版本必须匹配 versionSpec。 */
  externalNodeBin?: string
}

export interface NodeRuntime {
  nodeBin: string
  npmBin: string
  npxBin: string
  binDir: string
  /** 完整版本号，带 v 前缀，如 'v22.20.0'。 */
  version: string
  source: 'external' | 'portable'
}

export interface NodeRuntimeIO {
  fetchText(url: string): Promise<string>
  fetchBinary(url: string): Promise<Uint8Array>
  execFile(file: string, args: string[]): Promise<{ stdout: string }>
}

export function defaultNodeRuntimeIO(): NodeRuntimeIO {
  return {
    async fetchText(url) {
      const res = await fetch(url)
      if (!res.ok) throw new ProvisionError('download-failed', `GET ${url} -> ${res.status}`)
      return res.text()
    },
    async fetchBinary(url) {
      const res = await fetch(url)
      if (!res.ok) throw new ProvisionError('download-failed', `GET ${url} -> ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
    async execFile(file, args) {
      return execFileP(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    },
  }
}

/* ------------------------------------------------------------------ */
/* 纯函数                                                              */
/* ------------------------------------------------------------------ */

export interface VersionSpec {
  major: number
  minor?: number
  patch?: number
}

export function parseVersionSpec(spec: string): VersionSpec {
  const parts = spec.split('.')
  if (parts.length === 0 || parts.length > 3) throwInvalid(spec)
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throwInvalid(spec)
    nums.push(Number(part))
  }
  const [major, minor, patch] = nums
  if (major === undefined || major === 0) throwInvalid(spec)
  return {
    major,
    ...(minor !== undefined ? { minor } : {}),
    ...(patch !== undefined ? { patch } : {}),
  }
}

function throwInvalid(spec: string): never {
  throw new ProvisionError('invalid-version-spec', `invalid version spec: "${spec}" (expected "22" | "22.20" | "22.20.0")`)
}

/** nodejs.org dist 的平台-架构键名。 */
export function distKeyFor(platform: string, arch: string): string {
  const plat =
    platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : undefined
  if (!plat) {
    throw new ProvisionError(
      'unsupported-platform',
      `unsupported platform "${platform}" (portable runtime supports linux/darwin only in Phase 1)`,
    )
  }
  const archKey = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined
  if (!archKey) {
    throw new ProvisionError('unsupported-platform', `unsupported architecture "${arch}"`)
  }
  return `${plat}-${archKey}`
}

export function tarballFile(version: string, key: string): string {
  return `node-${version}-${key}.tar.gz`
}

export interface DistEntry {
  version: string
  lts: string | false
  date: string
  security?: boolean
}

function parseVersion(version: string): [number, number, number] | undefined {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return undefined
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function specMatches(spec: VersionSpec, triple: [number, number, number]): boolean {
  const [major, minor, patch] = triple
  if (major !== spec.major) return false
  if (spec.minor !== undefined && minor !== spec.minor) return false
  if (spec.patch !== undefined && patch !== spec.patch) return false
  return true
}

/** 从 dist index 里挑出匹配 spec 的最高版本。 */
export function pickLatestVersion(index: readonly DistEntry[], spec: VersionSpec): string {
  let best: { version: string; triple: [number, number, number] } | undefined
  for (const entry of index) {
    const triple = parseVersion(entry.version)
    if (!triple || !specMatches(spec, triple)) continue
    if (!best || compareTriples(triple, best.triple) > 0) best = { version: entry.version, triple }
  }
  if (!best) {
    throw new ProvisionError('version-not-found', `no dist entry matches spec "${spec.major}${spec.minor !== undefined ? `.${spec.minor}` : ''}${spec.patch !== undefined ? `.${spec.patch}` : ''}"`)
  }
  return best.version
}

function compareTriples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const diff = a[i]! - b[i]!
    if (diff !== 0) return diff
  }
  return 0
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 从 SHASUMS256.txt 内容里取出目标文件的 hash。 */
export function expectedSha256FromSums(sums: string, fileName: string): string {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m && m[2] === fileName) return m[1]!
  }
  throw new ProvisionError('checksum-mismatch', `SHASUMS256.txt has no entry for ${fileName}`)
}

export function runtimeFingerprint(version: string, key: string): string {
  return `${version}-${key}`
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function runNode(binDir: string, io: NodeRuntimeIO): Promise<string> {
  const { stdout } = await io.execFile(path.join(binDir, 'node'), ['-v'])
  return stdout.trim()
}

async function resolveExternal(externalNodeBin: string, spec: VersionSpec, io: NodeRuntimeIO): Promise<NodeRuntime> {
  let stdout: string
  try {
    ;({ stdout } = await io.execFile(externalNodeBin, ['-v']))
  } catch (err) {
    throw new ProvisionError('external-bin-invalid', `cannot execute externalNodeBin "${externalNodeBin}"`, { cause: err })
  }
  const version = stdout.trim()
  const triple = parseVersion(version)
  if (!triple) throw new ProvisionError('external-bin-invalid', `externalNodeBin printed unrecognized version: "${version}"`)
  if (triple[0] !== spec.major) {
    throw new ProvisionError(
      'external-bin-version-mismatch',
      `externalNodeBin is ${version}, which does not match versionSpec major ${spec.major} (native modules are ABI-bound)`,
    )
  }
  const binDir = path.dirname(externalNodeBin)
  return {
    nodeBin: externalNodeBin,
    npmBin: path.join(binDir, 'npm'),
    npxBin: path.join(binDir, 'npx'),
    binDir,
    version,
    source: 'external',
  }
}

export async function ensureNodeRuntime(
  options: NodeRuntimeOptions,
  io: NodeRuntimeIO = defaultNodeRuntimeIO(),
): Promise<NodeRuntime> {
  const spec = parseVersionSpec(options.versionSpec ?? '22')
  if (options.externalNodeBin) return resolveExternal(options.externalNodeBin, spec, io)
  const key = distKeyFor(process.platform, process.arch)
  return dedupe(`portable:${options.versionSpec ?? '22'}:${key}:${options.runtimeDir}:${options.distMirror ?? ''}`, () =>
    ensurePortable(options, spec, key, io),
  )
}

const inflight = new Map<string, Promise<NodeRuntime>>()

function dedupe(fingerprint: string, run: () => Promise<NodeRuntime>): Promise<NodeRuntime> {
  const existing = inflight.get(fingerprint)
  if (existing) return existing
  const promise = run().finally(() => inflight.delete(fingerprint))
  inflight.set(fingerprint, promise)
  return promise
}

async function ensurePortable(
  options: NodeRuntimeOptions,
  spec: VersionSpec,
  key: string,
  io: NodeRuntimeIO,
): Promise<NodeRuntime> {
  const mirror = (options.distMirror ?? DEFAULT_DIST_MIRROR).replace(/\/+$/, '')
  const specText = `${spec.major}${spec.minor !== undefined ? `.${spec.minor}` : ''}${spec.patch !== undefined ? `.${spec.patch}` : ''}`
  const pointerPath = path.join(options.runtimeDir, '.screeps-arena-resolved.json')

  // 已解析指针命中 → 跳过 index 拉取（复用路径完全离线）
  let version: string | undefined
  try {
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as { specText?: string; key?: string; version?: string }
    if (pointer.specText === specText && pointer.key === key && typeof pointer.version === 'string') {
      version = pointer.version
    }
  } catch (err) {
    // 指针缺失视为未解析；其他读取错误（权限/损坏 JSON）同样走 dist index 重解析，不静默吞实现 bug
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT') {
      try {
        await rm(pointerPath, { force: true })
      } catch {
        // 清理失败不阻塞主流程
      }
    }
  }
  if (version === undefined) {
    version = pickLatestVersion(
      JSON.parse(await io.fetchText(`${mirror}/index.json`)) as DistEntry[],
      spec,
    )
  }

  const dirName = `node-${version}-${key}`
  const target = path.join(options.runtimeDir, dirName)
  const marker = path.join(target, '.screeps-arena-ok')
  const binDir = path.join(target, 'bin')

  // 幂等复用
  if (existsSync(marker)) {
    const observed = await runNode(binDir, io).catch(() => undefined)
    if (observed === version && existsSync(path.join(binDir, 'npm'))) {
      return runtimeOf(binDir, version)
    }
    // marker 在但校验不过：视为损坏，重装
    await rm(target, { recursive: true, force: true })
  }

  const fileName = tarballFile(version, key)
  const sumsUrl = `${mirror}/${version}/SHASUMS256.txt`
  const expected = expectedSha256FromSums(await io.fetchText(sumsUrl), fileName)

  const tarballPath = path.join(options.runtimeDir, fileName)
  await mkdir(options.runtimeDir, { recursive: true })
  const cachedOk = existsSync(tarballPath) && (await sha256File(tarballPath)) === expected
  if (!cachedOk) {
    const data = await io.fetchBinary(`${mirror}/${version}/${fileName}`)
    if (sha256Hex(data) !== expected) {
      throw new ProvisionError('checksum-mismatch', `checksum mismatch for ${fileName} from ${mirror}`)
    }
    const partPath = `${tarballPath}.part`
    await writeFile(partPath, data)
    await rename(partPath, tarballPath)
  }

  // 解压到 staging 再 rename，避免半解压状态
  const stage = path.join(options.runtimeDir, `.stage-${process.pid}-${Date.now()}`)
  await mkdir(stage, { recursive: true })
  try {
    await io.execFile('tar', ['-xzf', tarballPath, '-C', stage])
    const extracted = path.join(stage, dirName)
    await stat(extracted)
    if (existsSync(target)) await rm(target, { recursive: true, force: true })
    await rename(extracted, target)
  } catch (err) {
    throw new ProvisionError('extract-failed', `failed to extract ${fileName}`, { cause: err })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }

  const observed = await runNode(binDir, io).catch(err => {
    throw new ProvisionError('runtime-verify-failed', `extracted runtime failed smoke check (node -v)`, { cause: err })
  })
  if (observed !== version) {
    throw new ProvisionError('runtime-verify-failed', `extracted runtime reported ${observed}, expected ${version}`)
  }
  await writeFile(marker, JSON.stringify({ version, key, fingerprint: runtimeFingerprint(version, key), createdAt: new Date().toISOString() }))
  await writeFile(
    path.join(options.runtimeDir, '.screeps-arena-resolved.json'),
    JSON.stringify({ specText, key, version, resolvedAt: new Date().toISOString() }),
  )
  return runtimeOf(binDir, version)
}

function runtimeOf(binDir: string, version: string): NodeRuntime {
  return {
    nodeBin: path.join(binDir, 'node'),
    npmBin: path.join(binDir, 'npm'),
    npxBin: path.join(binDir, 'npx'),
    binDir,
    version,
    source: 'portable',
  }
}

/** 便携运行时缓存目录的规范位置（供 config 默认值使用）。 */
export function defaultRuntimeDir(dataDir: string): string {
  return path.join(dataDir, 'runtime')
}

import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  distKeyFor,
  ensureNodeRuntime,
  expectedSha256FromSums,
  parseVersionSpec,
  pickLatestVersion,
  ProvisionError,
  sha256Hex,
  tarballFile,
  type DistEntry,
  type NodeRuntimeIO,
} from './node-runtime.ts'

const INDEX: DistEntry[] = [
  { version: 'v22.19.0', lts: 'jod', date: '2025-04-01', security: false },
  { version: 'v22.20.0', lts: 'jod', date: '2025-07-15', security: false },
  { version: 'v22.9.0', lts: 'jod', date: '2024-10-01', security: false },
  { version: 'v24.1.0', lts: false, date: '2025-05-01', security: false },
  { version: 'v26.3.0', lts: false, date: '2025-09-01', security: false },
]

const VERSION = 'v22.20.0'
const KEY = distKeyFor(process.platform, process.arch)
const FILE = tarballFile(VERSION, KEY)
// 任意稳定内容的 sha256，测试里只要求“下载内容与 SHASUMS 声明一致”
const CONTENT = Buffer.from('fake node tarball bytes for tests\n')
const HASH = sha256Hex(new Uint8Array(CONTENT))
const SUMS = `${HASH}  ${FILE}\n0000  node-${VERSION}-headers.tar.gz\n`

interface FakeState {
  textGets: string[]
  binaryGets: string[]
  execCalls: Array<{ file: string; args: string[] }>
}

function fakeIO(state: FakeState, opts: { failChecksum?: boolean } = {}): NodeRuntimeIO {
  return {
    async fetchText(url) {
      state.textGets.push(url)
      if (url.endsWith('/index.json')) return JSON.stringify(INDEX)
      if (url.endsWith('/SHASUMS256.txt')) return SUMS
      throw new Error(`unexpected text GET ${url}`)
    },
    async fetchBinary(url) {
      state.binaryGets.push(url)
      if (url.endsWith(`/${FILE}`)) {
        return new Uint8Array(opts.failChecksum ? Buffer.from('tampered') : CONTENT)
      }
      throw new Error(`unexpected binary GET ${url}`)
    },
    async execFile(file, args) {
      state.execCalls.push({ file, args })
      if (args[0] === '-v') return { stdout: `${VERSION}\n` }
      if (file === 'tar' && args[0] === '-xzf') {
        // 模拟 tar：在 -C 目录下创建 dist 应解出的目录结构
        const cIdx = args.indexOf('-C')
        const stage = args[cIdx + 1]!
        const { mkdirSync, writeFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        const bin = join(stage, `node-${VERSION}-${KEY}`, 'bin')
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, 'node'), '#!/bin/sh\n')
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\n')
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\n')
        return { stdout: '' }
      }
      throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
    },
  }
}

describe('parseVersionSpec', () => {
  it('accepts major / major.minor / major.patch forms', () => {
    expect(parseVersionSpec('22')).toEqual({ major: 22 })
    expect(parseVersionSpec('22.20')).toEqual({ major: 22, minor: 20 })
    expect(parseVersionSpec('22.20.1')).toEqual({ major: 22, minor: 20, patch: 1 })
  })
  it('rejects malformed specs', () => {
    for (const bad of ['', 'abc', '22.x', '0', '1.2.3.4', '-1']) {
      expect(() => parseVersionSpec(bad)).toThrowError(ProvisionError)
    }
  })
})

describe('distKeyFor', () => {
  it('maps linux/darwin x64/arm64', () => {
    expect(distKeyFor('linux', 'x64')).toBe('linux-x64')
    expect(distKeyFor('linux', 'arm64')).toBe('linux-arm64')
    expect(distKeyFor('darwin', 'arm64')).toBe('darwin-arm64')
  })
  it('rejects win32 in phase 1', () => {
    expect(() => distKeyFor('win32', 'x64')).toThrowError(/unsupported platform/i)
  })
})

describe('pickLatestVersion', () => {
  it('picks the highest matching major', () => {
    expect(pickLatestVersion(INDEX, parseVersionSpec('22'))).toBe('v22.20.0')
  })
  it('honors minor/patch constraints', () => {
    expect(pickLatestVersion(INDEX, parseVersionSpec('22.19'))).toBe('v22.19.0')
    expect(pickLatestVersion(INDEX, parseVersionSpec('22.19.0'))).toBe('v22.19.0')
  })
  it('throws version-not-found when nothing matches', () => {
    expect(() => pickLatestVersion(INDEX, parseVersionSpec('99'))).toThrowError(/no dist entry/)
  })
})

describe('expectedSha256FromSums', () => {
  it('matches the binary and spaces/two-space formats', () => {
    expect(expectedSha256FromSums(SUMS, FILE)).toBe(HASH)
  })
  it('throws when entry missing', () => {
    expect(() => expectedSha256FromSums(SUMS, 'other.tar.gz')).toThrowError(/no entry/)
  })
})

describe('ensureNodeRuntime (portable, fake io)', () => {
  it('downloads, verifies, extracts and returns the runtime', async () => {
    const state: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    const dir = tmpDir()
    const rt = await ensureNodeRuntime({ runtimeDir: dir }, fakeIO(state))
    expect(rt.version).toBe(VERSION)
    expect(rt.source).toBe('portable')
    expect(rt.nodeBin.endsWith('/bin/node')).toBe(true)
    expect(state.binaryGets).toEqual([`https://nodejs.org/dist/${VERSION}/${FILE}`])
  })

  it('is idempotent: second call makes no network requests', async () => {
    const dir = tmpDir()
    const state1: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    await ensureNodeRuntime({ runtimeDir: dir }, fakeIO(state1))
    const state2: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    const rt2 = await ensureNodeRuntime({ runtimeDir: dir }, fakeIO(state2))
    expect(rt2.version).toBe(VERSION)
    expect(state2.textGets).toEqual([])
    expect(state2.binaryGets).toEqual([])
  })

  it('rejects tampered downloads and leaves no target dir', async () => {
    const dir = tmpDir()
    const state: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    await expect(ensureNodeRuntime({ runtimeDir: dir }, fakeIO(state, { failChecksum: true }))).rejects.toMatchObject({
      code: 'checksum-mismatch',
    })
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    expect(existsSync(join(dir, `node-${VERSION}-${KEY}`))).toBe(false)
  })

  it('reuses a matching cached tarball without re-downloading', async () => {
    const dir = tmpDir()
    const state1: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    await ensureNodeRuntime({ runtimeDir: dir }, fakeIO(state1))
    // 删掉解压目录但保留 tarball 缓存 → 只应重新解压，不应重新下载
    const { rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    rmSync(join(dir, `node-${VERSION}-${KEY}`), { recursive: true })
    const state2: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    const rt2 = await ensureNodeRuntime({ runtimeDir: dir }, fakeIO(state2))
    expect(rt2.version).toBe(VERSION)
    expect(state2.binaryGets).toEqual([])
    expect(state2.textGets).toHaveLength(1) // 仅 SHASUMS；index 由解析指针缓存命中跳过
  })

  it('dedupes concurrent calls', async () => {
    const dir = tmpDir()
    const state: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    const [a, b] = await Promise.all([
      ensureNodeRuntime({ runtimeDir: dir }, fakeIO(state)),
      ensureNodeRuntime({ runtimeDir: dir }, fakeIO(state)),
    ])
    expect(a.version).toBe(b.version)
    expect(state.binaryGets).toHaveLength(1)
  })

  it('honors a custom dist mirror', async () => {
    const dir = tmpDir()
    const state: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    await ensureNodeRuntime({ runtimeDir: dir, distMirror: 'https://mirror.example/dist' }, fakeIO(state))
    expect(state.textGets[0]).toBe('https://mirror.example/dist/index.json')
  })
})

describe('ensureNodeRuntime (external bin)', () => {
  it('accepts a matching-major external node', async () => {
    const state: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    const rt = await ensureNodeRuntime(
      { runtimeDir: tmpDir(), externalNodeBin: '/usr/bin/node22', versionSpec: '22' },
      fakeIO(state),
    )
    expect(rt.source).toBe('external')
    expect(rt.version).toBe(VERSION)
    expect(rt.npmBin).toBe('/usr/bin/npm')
  })

  it('rejects version mismatch', async () => {
    const state: FakeState = { textGets: [], binaryGets: [], execCalls: [] }
    const io = fakeIO(state)
    io.execFile = async () => ({ stdout: 'v26.3.0\n' })
    await expect(
      ensureNodeRuntime({ runtimeDir: tmpDir(), externalNodeBin: '/usr/bin/node', versionSpec: '22' }, io),
    ).rejects.toMatchObject({ code: 'external-bin-version-mismatch' })
  })
})

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-screeps-node-runtime-'))
}

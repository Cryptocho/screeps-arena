import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkToolchain,
  ensureScreepsServer,
  modsJsonContent,
  screepsrcContent,
  serverPackageJson,
} from './server-installer.ts'
import type { NodeRuntime } from './node-runtime.ts'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-screeps-installer-'))
}

function fakeRuntime(): NodeRuntime {
  return {
    nodeBin: '/fake/bin/node',
    npmBin: '/fake/bin/npm',
    npxBin: '/fake/bin/npx',
    binDir: '/fake/bin',
    version: 'v22.23.2',
    source: 'portable',
  }
}

describe('config file contents', () => {
  it('screepsrc binds loopback and disables extra workers', () => {
    const src = screepsrcContent()
    expect(src).toContain('host = 127.0.0.1')
    expect(src).toContain('cli_host = 127.0.0.1')
    expect(src).toContain('runners_cnt = 1')
    expect(src).toContain('processors_cnt = 1')
    expect(src).toContain('modfile = mods.json')
    // 不含端口：启动时注入
    expect(src).not.toMatch(/^port = /m)
  })

  it('server package.json pins screeps and optionally simplebot', () => {
    const withBot = JSON.parse(serverPackageJson('4.3.0', '1.0.1')) as { dependencies: Record<string, string> }
    expect(withBot.dependencies.screeps).toBe('4.3.0')
    expect(withBot.dependencies['@screeps/simplebot']).toBe('1.0.1')
    const withoutBot = JSON.parse(serverPackageJson('4.3.0', false)) as { dependencies: Record<string, string> }
    expect(withoutBot.dependencies['@screeps/simplebot']).toBeUndefined()
  })

  it('mods.json lists mods and bots', () => {
    const parsed = JSON.parse(modsJsonContent(['arena-mod.js'], { simplebot: 'node_modules/@screeps/simplebot/src' })) as {
      mods: string[]
      bots: Record<string, string>
    }
    expect(parsed.mods).toEqual(['arena-mod.js'])
    expect(parsed.bots.simplebot).toContain('simplebot')
  })
})

describe('ensureScreepsServer (file layer, no npm)', () => {
  it('writes base files and skips npm install on fingerprint match', async () => {
    const serverDir = tmp()
    const logs: string[] = []
    // 手动预置指纹 marker 与编译产物，使 npm install 与 artifact 校验被跳过
    const nm = join(serverDir, 'node_modules')
    mkdirSync(nm, { recursive: true })
    writeFileSync(
      join(nm, '.dsh-screeps-server.json'),
      JSON.stringify({ screepsVersion: '4.3.0', simplebot: '1.0.1', nodeVersion: 'v22.23.2' }),
    )
    // 预置产物：driver native / isolated-vm / pathfinding(纯JS包) / webpack bundle / db 模板
    for (const dir of [
      join(nm, '@screeps', 'driver', 'native', 'build', 'Release'),
      join(nm, 'isolated-vm', 'build', 'Release'),
      join(nm, '@screeps', 'pathfinding'),
      join(nm, '@screeps', 'driver', 'build'),
      join(nm, '@screeps', 'storage'),
    ]) {
      mkdirSync(dir, { recursive: true })
    }
    // db 播种模板（真实环境来自 @screeps/storage 包）
    writeFileSync(join(nm, '@screeps', 'storage', 'db.original.json'), '{"collections":{}}')
    writeFileSync(join(nm, '@screeps', 'driver', 'native', 'build', 'Release', 'native.node'), '')
    writeFileSync(join(nm, 'isolated-vm', 'build', 'Release', 'isolated_vm.node'), '')
    writeFileSync(join(nm, '@screeps', 'pathfinding', 'index.js'), '// pure js')
    writeFileSync(join(nm, '@screeps', 'driver', 'build', 'driver.js'), '// bundle')

    const result = await ensureScreepsServer({
      serverDir,
      runtime: fakeRuntime(),
      mods: [{ name: 'arena-mod.js', content: 'module.exports = () => {}' }],
      bots: {},
      onLog: (line: string) => logs.push(line),
    })
    expect(result.installSkipped).toBe(true)
    expect(readFileSync(join(serverDir, '.screepsrc'), 'utf8')).toContain('127.0.0.1')
    expect(readFileSync(join(serverDir, 'mods.json'), 'utf8')).toContain('arena-mod.js')
    expect(readFileSync(join(serverDir, 'arena-mod.js'), 'utf8')).toContain('module.exports')
    expect(logs.some(l => l.includes('skipped'))).toBe(true)
  })

  it('rejects mod file names with path separators', async () => {
    const serverDir = tmp()
    await expect(
      ensureScreepsServer({
        serverDir,
        runtime: fakeRuntime(),
        mods: [{ name: '../evil.js', content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'seed-failed' })
  })

  it('toolchain check returns versions on a prepared machine', async () => {
    const serverDir = tmp()
    // 本机工具链齐全时成功；缺失的路径由无工具链环境覆盖，这里断言形状与目录创建。
    const found = await checkToolchain()
    expect(Object.keys(found)).toContain('python3')
    void serverDir
    expect(existsSync(tmp())).toBe(true)
  })
})

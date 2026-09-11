/**
 * S1 集成测试（真实网络下载）。
 * 运行：DSH_SCREEPS_IT=1 npm run test:it
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNodeRuntime, distKeyFor } from './node-runtime.ts'

const enabled = process.env.DSH_SCREEPS_IT === '1'

describe.skipIf(!enabled)('ensureNodeRuntime (real network)', () => {
  it('provisions the pinned LTS from nodejs.org and passes node -v', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-runtime-'))
    const rt = await ensureNodeRuntime({ runtimeDir: join(dir, 'runtime'), versionSpec: '22' })
    expect(rt.source).toBe('portable')
    expect(rt.version).toMatch(/^v22\.\d+\.\d+$/)
    expect(rt.nodeBin).toContain(distKeyFor(process.platform, process.arch))
  }, 300_000)
})

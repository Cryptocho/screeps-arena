import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotError, BotRegistry } from './bot-registry.ts'

function makeRegistry(): { registry: BotRegistry; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-screeps-bots-'))
  return { registry: new BotRegistry(join(root, 'bots')), root }
}
function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true })
}

describe('BotRegistry', () => {
  it('lists bots with @dsh-bot metadata from main.js', async () => {
    const { registry, root } = makeRegistry()
    try {
      mkdirSync(join(registry.dir, 'harvester'), { recursive: true })
      writeFileSync(join(registry.dir, 'harvester', 'main.js'), '// @dsh-bot 采集升级型基线\nmodule.exports.loop=()=>{}')
      const bots = await registry.list()
      expect(bots).toEqual([{ name: 'harvester', description: '采集升级型基线' }])
    } finally {
      cleanup(root)
    }
  })

  it('ignores directories without main.js and invalid names', async () => {
    const { registry, root } = makeRegistry()
    try {
      mkdirSync(join(registry.dir, 'empty'), { recursive: true })
      mkdirSync(join(registry.dir, 'Bad Name'), { recursive: true })
      writeFileSync(join(registry.dir, 'Bad Name', 'main.js'), 'x')
      expect(await registry.list()).toEqual([])
    } finally {
      cleanup(root)
    }
  })

  it('loads modules keyed by filename without extension', async () => {
    const { registry, root } = makeRegistry()
    try {
      mkdirSync(join(registry.dir, 'twin'), { recursive: true })
      writeFileSync(join(registry.dir, 'twin', 'main.js'), 'A')
      writeFileSync(join(registry.dir, 'twin', 'util.js'), 'B')
      const modules = await registry.load('twin')
      expect(modules).toEqual({ main: 'A', util: 'B' })
    } finally {
      cleanup(root)
    }
  })

  it('rejects missing bots, missing main, and bad names', async () => {
    const { registry, root } = makeRegistry()
    try {
      await expect(registry.load('ghost')).rejects.toMatchObject({ code: 'notFound' })
      await expect(registry.load('../etc')).rejects.toMatchObject({ code: 'badName' })
      mkdirSync(join(registry.dir, 'headless'), { recursive: true })
      writeFileSync(join(registry.dir, 'headless', 'helper.js'), 'x')
      await expect(registry.load('headless')).rejects.toMatchObject({ code: 'noMain' })
    } finally {
      cleanup(root)
    }
  })
})

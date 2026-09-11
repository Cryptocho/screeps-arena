/**
 * M6 code-log 单测（plan-M6 §4-A）：追加串行/失败不抛/坏行容错/seq 播种/DELETE 并发无害/分组。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodeLog } from './code-log.ts'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-screeps-codelog-'))
}

const CODE = { main: 'module.exports.loop = function () {}' }

describe('CodeLog', () => {
  it('appends and lists versions (meta without modules), seq starts at 1', async () => {
    const dir = await makeDir()
    const log = new CodeLog(dir)
    await log.append('m1', { username: 'alice', phase: 'creating', source: 'agent-submit', modules: CODE })
    await log.append('m1', { username: 'alice', phase: 'roundBreak', roundIndex: 0, source: 'agent-submit', modules: CODE })
    const list = await log.list('m1')
    expect(list.badLines).toBe(0)
    expect(list.versions.map(v => v.seq)).toEqual([1, 2])
    expect(list.versions[0]).toMatchObject({ username: 'alice', phase: 'creating', source: 'agent-submit', size: modulesSizeOf(CODE) })
    expect(list.versions[1]).toMatchObject({ phase: 'roundBreak', roundIndex: 0 })
    expect(list.versions[0]).not.toHaveProperty('modules')
    await rm(dir, { recursive: true, force: true })
  })

  it('getEntry filters by (username, seq) after parsing the whole file', async () => {
    const dir = await makeDir()
    const log = new CodeLog(dir)
    await log.append('m1', { username: 'alice', phase: 'creating', source: 'agent-submit', modules: { main: 'A' } })
    await log.append('m1', { username: 'bob', phase: 'creating', source: 'agent-submit', modules: { main: 'B' } })
    const a1 = await log.getEntry('m1', 'alice', 1)
    expect(a1?.modules).toEqual({ main: 'A' })
    const b2 = await log.getEntry('m1', 'bob', 2)
    expect(b2?.modules).toEqual({ main: 'B' })
    expect(await log.getEntry('m1', 'alice', 2)).toBeUndefined()
    expect(await log.getEntry('m1', 'carol', 1)).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  it('tolerates bad lines: skipped + counted; seq seeds from valid lines', async () => {
    const dir = await makeDir()
    await mkdir(join(dir, 'm1'), { recursive: true })
    const good1 = JSON.stringify({ seq: 1, ts: 1, username: 'a', phase: 'creating', source: 'agent-submit', size: 3, modules: CODE })
    const good2 = JSON.stringify({ seq: 2, ts: 2, username: 'a', phase: 'creating', source: 'agent-submit', size: 3, modules: CODE })
    await writeFile(join(dir, 'm1', 'codes.jsonl'), `${good1}\nnot-json-at-all\n${good2}\n{"seq":3,"broken":true}\n`, 'utf8')
    const log = new CodeLog(dir)
    const list = await log.list('m1')
    expect(list.versions.map(v => v.seq)).toEqual([1, 2])
    expect(list.badLines).toBe(2)
    // 播种 = 可解析行数 → 下一条 seq=3（不与既有行撞号）
    await log.append('m1', { username: 'b', phase: 'creating', source: 'agent-submit', modules: CODE })
    const after = await log.list('m1')
    expect(after.versions.map(v => v.seq)).toEqual([1, 2, 3])
    expect(after.versions[2]?.username).toBe('b')
    await rm(dir, { recursive: true, force: true })
  })

  it('append never rejects on write failure (match flow unaffected); later appends still work', async () => {
    const dir = await makeDir()
    const log = new CodeLog(dir)
    // matchId 路径被一个同名常规文件占位 → mkdir(recursive) 失败 → append 内部吞掉
    await writeFile(join(dir, 'm-broken'), 'not a dir', 'utf8')
    await expect(log.append('m-broken', { username: 'a', phase: 'creating', source: 'agent-submit', modules: CODE })).resolves.toBeUndefined()
    await expect(log.append('m-broken', { username: 'a', phase: 'creating', source: 'agent-submit', modules: CODE })).resolves.toBeUndefined()
    // 正常 matchId 不受失败影响
    await log.append('m-ok', { username: 'a', phase: 'creating', source: 'agent-submit', modules: CODE })
    expect((await log.list('m-ok')).versions.map(v => v.seq)).toEqual([1])
    await rm(dir, { recursive: true, force: true })
  })

  it('concurrent DELETE + append lands in fail-safe path (ENOENT swallowed), no throw', async () => {
    const dir = await makeDir()
    const log = new CodeLog(dir)
    await log.append('m1', { username: 'a', phase: 'creating', source: 'agent-submit', modules: CODE })
    // 模拟 DELETE /matches/:id（整目录 rm）与 in-flight append 并发：先删目录再 append
    await rm(join(dir, 'm1'), { recursive: true, force: true })
    await expect(log.append('m1', { username: 'a', phase: 'creating', source: 'agent-submit', modules: CODE })).resolves.toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  it('serializes concurrent appends: seq strictly 1..N in call order', async () => {
    const dir = await makeDir()
    const log = new CodeLog(dir)
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => log.append('m1', { username: `u${i}`, phase: 'creating', source: 'agent-submit', modules: CODE })),
    )
    const list = await log.list('m1')
    expect(list.versions.map(v => v.seq)).toEqual([1, 2, 3, 4, 5])
    await rm(dir, { recursive: true, force: true })
  })

  it('groupVersions keeps first-appearance order per username', () => {
    const v = (username: string, seq: number) => ({ seq, ts: 1, username, phase: 'creating', source: 'agent-submit' as const, size: 3 })
    const grouped = CodeLog.groupVersions([v('a', 1), v('b', 2), v('a', 3)])
    expect(grouped.map(g => g.username)).toEqual(['a', 'b'])
    expect(grouped[0]!.versions.map(x => x.seq)).toEqual([1, 3])
    expect(grouped[1]!.versions.map(x => x.seq)).toEqual([2])
  })
})

function modulesSizeOf(modules: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(modules), 'utf8')
}

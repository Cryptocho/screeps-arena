import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdmissionStore } from './store.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-admission-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AdmissionStore', () => {
  it('acquire writes a held reservation; a second different operation conflicts', async () => {
    const store = new AdmissionStore(path.join(dir, 'admission'))
    const r = await store.acquire('tournament-create', 'op-1', 't1')
    expect(r.state).toBe('held')
    expect((await store.currentLock())?.operationId).toBe('op-1')
    await expect(store.acquire('legacy-spawn', 'op-2', 'legacy-1')).rejects.toMatchObject({ code: 'conflict' })
    // 幂等：同 operation 重试 → 返回原锁
    const again = await store.acquire('tournament-create', 'op-1', 't1')
    expect(again.reservationId).toBe(r.reservationId)
  })

  it('release frees the lock so the next operation can acquire', async () => {
    const store = new AdmissionStore(path.join(dir, 'admission'))
    const r = await store.acquire('tournament-create', 'op-1', 't1')
    const released = await store.release(r.reservationId, 't1')
    expect(released.state).toBe('released')
    expect(released.releasedAt).toBeGreaterThan(0)
    expect(await store.currentLock()).toBeNull()
    const next = await store.acquire('legacy-spawn', 'op-2', 'legacy-1')
    expect(next.operationId).toBe('op-2')
    // release 幂等 / 已释放后再 release 幂等
    await expect(store.release(next.reservationId, 't1')).rejects.toMatchObject({ code: 'badState' })
    await expect(store.release(r.reservationId, 't1')).resolves.toMatchObject({ state: 'released' })
  })

  it('acquireRecovery takes the lock exclusively; conflicts with a held business reservation', async () => {
    const store = new AdmissionStore(path.join(dir, 'admission'))
    const r = await store.acquireRecovery()
    expect(r.kind).toBe('recovery')
    expect(r.state).toBe('held')
    // recovery 幂等
    const again = await store.acquireRecovery()
    expect(again.reservationId).toBe(r.reservationId)
    await store.release(r.reservationId, 'recovery')
    // 有业务锁时 recovery conflict
    const biz = await store.acquire('tournament-create', 'op-1', 't1')
    await expect(store.acquireRecovery()).rejects.toMatchObject({ code: 'conflict' })
    await store.release(biz.reservationId, 't1')
  })

  it('markRecovery converts a held owner-lost reservation to recovery state', async () => {
    const store = new AdmissionStore(path.join(dir, 'admission'))
    const r = await store.acquire('tournament-create', 'op-1', 't1')
    const rec = await store.markRecovery(r.reservationId, 'owner lost during process restart')
    expect(rec.state).toBe('recovery')
    expect(rec.error).toContain('owner lost')
    // 幂等
    await expect(store.markRecovery(r.reservationId, 'again')).resolves.toMatchObject({ state: 'recovery' })
    // 标 recovery 后其它 acquire 仍被挡
    await expect(store.acquire('legacy-spawn', 'op-2', 'x')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('persists across instances (durable lock, not just memory)', async () => {
    const base = path.join(dir, 'admission')
    const store1 = new AdmissionStore(base)
    await store1.acquire('tournament-create', 'op-1', 't1')
    const store2 = new AdmissionStore(base) // 新实例（重启模拟）
    expect((await store2.currentLock())?.operationId).toBe('op-1')
    await expect(store2.acquire('legacy-spawn', 'op-2', 'x')).rejects.toMatchObject({ code: 'conflict' })
  })
})

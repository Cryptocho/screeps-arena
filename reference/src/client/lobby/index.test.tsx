// @vitest-environment jsdom
/**
 * 对局大厅 client 测试（S12 H 步，兜底自造 fake）：
 *
 * 官方 @deepseek-ai/dsh-client-test-runtime@0.1.1-rc.2 有打包 bug——其 lib 直接
 * `from "@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts"`，但 rc.2 发布物
 * files 不含 src/（exports["./src/*"] 悬空）→ 官方 lane 在 rc.2 跑不了。
 * 按计划 H 步「自造 fake services 兜底」：用真实 cordis Context + 最小 slots 桩
 * 断言注册语义与清理。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerLobby } from './index.tsx'

/** 最小 slots 桩：record inject/register + inject 回调立即执行（模拟声明已存在）。 */
function makeSlotsStub() {
  const registrations: { name: string; id?: string }[] = []
  const disposers: Array<() => void> = []
  return {
    registrations,
    slots: {
      inject: vi.fn((_key: string, cb: () => () => void) => {
        const dispose = cb()
        disposers.push(dispose)
        return dispose
      }),
      register: vi.fn((spec: { name: string; id?: string }) => {
        registrations.push({ name: spec.name, id: spec.id })
        const entry = registrations[registrations.length - 1]!
        return () => {
          const idx = registrations.indexOf(entry)
          if (idx >= 0) registrations.splice(idx, 1)
        }
      }),
    },
    disposers,
  }
}

let contexts: Context[] = []

afterEach(() => {
  for (const ctx of contexts) {
    // 触发 fiber dispose，验证清理（ctx.dispose 是内部 API，测试里用 as any 触达）
    void (ctx as unknown as { dispose?: () => void }).dispose?.()
  }
  contexts = []
})

describe('lobby (sidebar.footer.action) 注册语义（fake slots）', () => {
  it('registers one sidebar.footer.action entry with id screeps-lobby, wrapped in inject', async () => {
    const stub = makeSlotsStub()
    const ctx = new Context()
    contexts.push(ctx)
    // 注入最小 sessions service（apply 里的 ctx.sessions.list）
    ctx.provide('sessions' as never, {
      list: {
        getSnapshot: () => ({ current: undefined, rows: [] }),
      },
      open: () => {},
    } as never)
    // 注入 slots stub
    ctx.provide('slots' as never, stub.slots as never)

    registerLobby(ctx as never)
    // ctx.effect 同步执行注册闭包？slots.inject 被调用即执行 cb → register 已跑
    expect(stub.slots.inject).toHaveBeenCalledWith('sidebar.footer.action', expect.any(Function))
    expect(stub.slots.register).toHaveBeenCalledTimes(1)
    const firstCall = stub.slots.register.mock.calls[0]?.[0] as { name: string; id?: string } | undefined
    expect(firstCall).toBeDefined()
    const spec = firstCall!
    expect(spec.name).toBe('sidebar.footer.action')
    expect(spec.id).toBe('screeps-lobby')
  })

  it('dispose cleanup removes the registration', async () => {
    const stub = makeSlotsStub()
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessions' as never, {
      list: { getSnapshot: () => ({ current: undefined, rows: [] }) },
      open: () => {},
    } as never)
    ctx.provide('slots' as never, stub.slots as never)

    registerLobby(ctx as never)
    expect(stub.registrations).toHaveLength(1)

    // 触发 inject 返回的 disposer（插件卸载链路）
    for (const d of stub.disposers) d()
    for (const d of stub.disposers) d() // 幂等
    expect(stub.registrations).toHaveLength(0)
  })
})
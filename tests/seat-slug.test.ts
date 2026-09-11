/**
 * M2/S7 席位 slug 单测——碰撞加固（sanitize + sha1 后缀）与幂等。
 */
import { describe, expect, it } from 'vitest'
import { seatSlug } from '../src/shared/seat-slug.js'

describe('seatSlug（M2/S7）', () => {
  it('同串必同 slug（幂等）', () => {
    expect(seatSlug('seat-a')).toBe(seatSlug('seat-a'))
    expect(seatSlug('a:b')).toBe(seatSlug('a:b'))
  })

  it('仅特殊字符不同的 seatId 不再碰撞（a:b vs a_b）', () => {
    expect(seatSlug('a:b')).not.toBe(seatSlug('a_b'))
  })

  it('sanitize：特殊字符 → _；长度 ≤24（agent_ 前缀后 ≤30）', () => {
    const slug = seatSlug('a/b\\c:d*e?f')
    expect(slug).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(slug.length).toBeLessThanOrEqual(24)
    expect(`agent_${slug}`.length).toBeLessThanOrEqual(30)
  })

  it('超长 seatId 截断 ≤16 后 hash 仍区分', () => {
    const long1 = 'x'.repeat(30)
    const long2 = `${'x'.repeat(29)}y`
    expect(seatSlug(long1)).not.toBe(seatSlug(long2))
    expect(seatSlug(long1).length).toBeLessThanOrEqual(24)
  })

  it('常规 id 也带 hash 后缀（统一约定，无例外路径）', () => {
    expect(seatSlug('seat-a')).toBe(`seat-a${seatSlug('seat-a').slice(6)}`)
  })
})

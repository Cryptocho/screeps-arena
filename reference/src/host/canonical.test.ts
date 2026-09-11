import { describe, expect, it } from 'vitest'
import { canonicalize, CanonicalError, hashV1, HASH_VERSION } from './canonical.ts'

describe('canonicalize (hashVersion=1)', () => {
  it('sorts object keys in UTF-16 code-unit order recursively', () => {
    // 'Z' (0x5A) < 'a' (0x61) < 'b' (0x62)
    expect(canonicalize({ b: 1, Z: 2, a: 3 })).toBe('{"Z":2,"a":3,"b":1}')
    expect(canonicalize({ x: { c: 1, b: 2 }, a: 0 })).toBe('{"a":0,"x":{"b":2,"c":1}}')
  })

  it('keeps array order and does not sort array items', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalize({ list: [{ b: 1 }, { a: 2 }] })).toBe('{"list":[{"b":1},{"a":2}]}')
  })

  it('is insertion-order independent for objects', () => {
    const a = { x: 1, y: { m: 1, n: 2 }, z: [1, 2] }
    const b = { z: [1, 2], y: { n: 2, m: 1 }, x: 1 }
    expect(canonicalize(a)).toBe(canonicalize(b))
    expect(hashV1(a)).toBe(hashV1(b))
  })

  it('does not omit null, empty arrays or empty objects', () => {
    expect(canonicalize({ a: null, b: [], c: {} })).toBe('{"a":null,"b":[],"c":{}}')
    expect(canonicalize([])).toBe('[]')
    expect(canonicalize({})).toBe('{}')
  })

  it('serializes strings with standard JSON escaping', () => {
    expect(canonicalize({ s: 'a"b\\c\n' })).toBe('{"s":"a\\"b\\\\c\\n"}')
  })

  it('normalizes numbers to their JSON representation (1 vs 1.0 same)', () => {
    expect(canonicalize({ a: 1 })).toBe(canonicalize({ a: 1.0 }))
    expect(canonicalize({ a: 0.1 })).toBe('{"a":0.1}')
    expect(canonicalize({ a: 1e21 })).toBe('{"a":1e+21}')
  })

  it('rejects NaN, Infinity and -0', () => {
    for (const bad of [NaN, Infinity, -Infinity, -0]) {
      expect(() => canonicalize({ a: bad })).toThrow(CanonicalError)
    }
  })

  it('rejects undefined, functions, symbols, bigint and non-plain objects', () => {
    expect(() => canonicalize(undefined)).toThrow(CanonicalError)
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalError)
    expect(() => canonicalize([undefined])).toThrow(CanonicalError)
    expect(() => canonicalize({ a: () => 1 })).toThrow(CanonicalError)
    expect(() => canonicalize({ a: Symbol('x') })).toThrow(CanonicalError)
    expect(() => canonicalize({ a: 1n })).toThrow(CanonicalError)
    expect(() => canonicalize({ a: new Date(0) })).toThrow(CanonicalError)
    expect(() => canonicalize({ a: new Map() })).toThrow(CanonicalError)
  })

  it('rejects circular references', () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    expect(() => canonicalize(obj)).toThrow(CanonicalError)
  })

  it('produces deterministic sha-256 hex hashes', () => {
    expect(hashV1({ resultId: 'm1', winner: { kind: 'participant', participantId: 'p1' } })).toMatch(/^[0-9a-f]{64}$/)
    expect(hashV1('')).not.toBe(hashV1({}))
    expect(HASH_VERSION).toBe(1)
  })
})

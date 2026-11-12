import { describe, expect, it } from 'vitest'
import { mulberry32 } from './prng.js'

describe('mulberry32', () => {
  it('returns floats in [0, 1)', () => {
    const rng = mulberry32(42)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('is deterministic — same seed produces the same sequence', () => {
    const a = mulberry32(0xdeadbeef)
    const b = mulberry32(0xdeadbeef)
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  it('different seeds produce different sequences', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    // Statistically impossible for 20 consecutive values to match by chance.
    const seqA = Array.from({ length: 20 }, () => a.next())
    const seqB = Array.from({ length: 20 }, () => b.next())
    expect(seqA).not.toEqual(seqB)
  })

  it('nextInt returns integers within [lo, hi]', () => {
    const rng = mulberry32(99)
    for (let i = 0; i < 500; i++) {
      const v = rng.nextInt(3, 7)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(7)
    }
  })

  it('seed coerces to uint32 — negative and float seeds are stable', () => {
    // -1 >>> 0 === 4294967295; calling twice with same effective seed matches.
    const a = mulberry32(-1)
    const b = mulberry32(0xffffffff)
    expect(a.next()).toBe(b.next())
  })

  it('produces reasonable statistical spread (chi-squared smoke test)', () => {
    const rng = mulberry32(7)
    const buckets = new Array(10).fill(0)
    const N = 10_000
    for (let i = 0; i < N; i++) {
      buckets[Math.floor(rng.next() * 10)]++
    }
    // Each bucket should have roughly N/10 = 1000 hits; allow ±30%.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(700)
      expect(count).toBeLessThan(1300)
    }
  })
})

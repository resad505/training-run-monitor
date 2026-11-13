import { describe, expect, it } from 'vitest'
import { createLinearScale, createLogScale, formatTickNumber } from './scale.js'

describe('formatTickNumber — round-trip guarantee', () => {
  it('round-trips integers', () => {
    for (const n of [0, 1, 10, 100, 500, 1000000]) {
      const formatted = formatTickNumber(n)
      expect(Number(formatted)).toBe(n)
    }
  })

  it('round-trips decimal fractions', () => {
    for (const n of [0.5, 0.25, 0.1, 0.01, 0.005, 0.0001, 2.5, 12.34]) {
      const formatted = formatTickNumber(n)
      expect(Number(formatted)).toBe(n)
    }
  })

  it('round-trips scientific notation for very small/large numbers', () => {
    for (const n of [1e-5, 1e-6, 1e9, 2.5e-5]) {
      const formatted = formatTickNumber(n)
      expect(Number(formatted)).toBe(n)
    }
  })
})

describe('createLinearScale — Issue #12', () => {
  const linear = createLinearScale({
    domain: [0, 100],
    range: [0, 500],
  })

  it('projects in-domain values correctly', () => {
    expect(linear.scale(0)).toBe(0)
    expect(linear.scale(50)).toBe(250)
    expect(linear.scale(100)).toBe(500)
  })

  it('handles inverted ranges (typical for Canvas Y axis)', () => {
    const yScale = createLinearScale({
      domain: [0, 10],
      range: [400, 0],
    })
    expect(yScale.scale(0)).toBe(400)
    expect(yScale.scale(5)).toBe(200)
    expect(yScale.scale(10)).toBe(0)
  })

  it('never returns non-finite coordinates for non-finite inputs', () => {
    expect(linear.scale(NaN)).toBeNull()
    expect(linear.scale(Infinity)).toBeNull()
    expect(linear.scale(-Infinity)).toBeNull()
    expect(linear.scale(null)).toBeNull()
    expect(linear.scale(undefined)).toBeNull()
  })

  it('isPlottable reports truthfulness', () => {
    expect(linear.isPlottable(0)).toBe(true)
    expect(linear.isPlottable(-50)).toBe(true)
    expect(linear.isPlottable(1000)).toBe(true)
    expect(linear.isPlottable(NaN)).toBe(false)
    expect(linear.isPlottable(Infinity)).toBe(false)
    expect(linear.isPlottable(-Infinity)).toBe(false)
  })

  it('inverts pixels back to domain values', () => {
    expect(linear.invert(0)).toBe(0)
    expect(linear.invert(250)).toBe(50)
    expect(linear.invert(500)).toBe(100)
    expect(linear.invert(NaN)).toBeNull()
  })

  it('ticks lie strictly within domain bounds', () => {
    const ticks = linear.ticks(5)
    expect(ticks.length).toBeGreaterThan(0)
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThanOrEqual(100)
    }
  })

  it('tick labels round-trip to the tick value', () => {
    const ticks = linear.ticks(8)
    for (const t of ticks) {
      const label = linear.tickFormat(t)
      expect(Number(label)).toBe(t)
    }
  })

  it('handles zero-span domain without dividing by zero', () => {
    const flat = createLinearScale({ domain: [5, 5], range: [0, 200] })
    expect(flat.scale(5)).toBe(100)
    expect(Number.isFinite(flat.scale(5))).toBe(true)
    expect(flat.ticks()).toEqual([5])
  })
})

describe('createLogScale — Issue #12', () => {
  const logScale = createLogScale({
    domain: [0.01, 100],
    range: [0, 400],
    base: 10,
  })

  it('projects positive values logarithmically', () => {
    expect(logScale.scale(0.01)).toBeCloseTo(0)
    expect(logScale.scale(1)).toBeCloseTo(200) // 2 decades from 0.01 out of 4 decades total
    expect(logScale.scale(100)).toBeCloseTo(400)
  })

  it('CRITICAL: values <= 0 are reported as not plottable and return null, never silently clamped', () => {
    expect(logScale.isPlottable(0)).toBe(false)
    expect(logScale.isPlottable(-1)).toBe(false)
    expect(logScale.isPlottable(-100)).toBe(false)

    // Must return null, NOT clamped to range[0]
    expect(logScale.scale(0)).toBeNull()
    expect(logScale.scale(-1)).toBeNull()
    expect(logScale.scale(-100)).toBeNull()
  })

  it('never returns non-finite coordinates for NaN, Infinity, -Infinity', () => {
    expect(logScale.scale(NaN)).toBeNull()
    expect(logScale.scale(Infinity)).toBeNull()
    expect(logScale.scale(-Infinity)).toBeNull()
  })

  it('inverts pixels back to positive domain values', () => {
    expect(logScale.invert(0)).toBeCloseTo(0.01)
    expect(logScale.invert(200)).toBeCloseTo(1)
    expect(logScale.invert(400)).toBeCloseTo(100)
    expect(logScale.invert(NaN)).toBeNull()
  })

  it('ticks lie strictly within domain bounds', () => {
    const ticks = logScale.ticks()
    expect(ticks.length).toBeGreaterThan(0)
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(0.01)
      expect(t).toBeLessThanOrEqual(100)
    }
  })

  it('tick labels round-trip to the tick value', () => {
    const ticks = logScale.ticks()
    for (const t of ticks) {
      const label = logScale.tickFormat(t)
      expect(Number(label)).toBeCloseTo(t, 6)
    }
  })

  it('narrow log domain produces intermediate sub-ticks', () => {
    const narrow = createLogScale({ domain: [1, 5], range: [0, 100] })
    const ticks = narrow.ticks()
    expect(ticks).toEqual([1, 2, 5])
  })
})

describe('scale hardening', () => {
  it('scientific-notation labels round-trip exactly', () => {
    for (const v of [1.23456789e-5, 1.234567890123e12, -7.777777e-9, 1e-5, 2.5e12]) {
      expect(Number(formatTickNumber(v))).toBe(v)
    }
  })

  it('round-trips random values across magnitudes', () => {
    let seed = 7
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    for (let k = 0; k < 5000; k++) {
      const v = (rand() - 0.5) * 10 ** Math.floor(rand() * 40 - 20)
      expect(Number(formatTickNumber(v))).toBe(v)
    }
  })

  it('log scale rejects a non-positive domain instead of substituting one', () => {
    expect(() => createLogScale({ domain: [0, 10], range: [0, 100] })).toThrow(RangeError)
    expect(() => createLogScale({ domain: [-1, 10], range: [0, 100] })).toThrow(RangeError)
  })

  it('linear scale rejects a non-finite domain', () => {
    expect(() => createLinearScale({ domain: [0, Infinity], range: [0, 100] })).toThrow(RangeError)
  })

  it('narrow log domains still get in-domain ticks', () => {
    const ticks = createLogScale({ domain: [0.6, 0.9], range: [0, 100] }).ticks()
    expect(ticks.length).toBeGreaterThan(0)
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(0.6)
      expect(t).toBeLessThanOrEqual(0.9)
    }
  })
})

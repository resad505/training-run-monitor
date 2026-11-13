import { describe, expect, it } from 'vitest'
import { formatInteger, formatNumber, formatTickNumber, formatUtcTime } from './formatters.js'

describe('deterministic formatters', () => {
  it('uses en-US grouping and preserves non-finite labels', () => {
    expect(formatNumber(1234567.89)).toBe('1,234,600')
    expect(formatNumber(NaN)).toBe('NaN')
    expect(formatNumber(Infinity)).toBe('+Infinity')
    expect(formatNumber(-Infinity)).toBe('-Infinity')
  })

  it('formats integers consistently', () => {
    expect(formatInteger(1000000)).toBe('1,000,000')
  })

  it('renders UTC with an explicit suffix', () => {
    expect(formatUtcTime('2026-01-02T03:04:05.000Z')).toBe('Jan 02, 2026, 03:04:05 UTC')
  })

  it('renders midnight as 00, never 24', () => {
    expect(formatUtcTime('2026-01-02T00:04:05.000Z')).toBe('Jan 02, 2026, 00:04:05 UTC')
  })

  it('keeps chart ticks round-trippable', () => {
    const tick = 0.00025
    expect(Number(formatTickNumber(tick))).toBe(tick)
  })
})

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

describe('formatter edge cases', () => {
  it('labels non-finite integers instead of printing 0 or a blank', () => {
    expect(formatInteger(NaN)).toBe('NaN')
    expect(formatInteger(Infinity)).toBe('+Infinity')
    expect(formatInteger(-Infinity)).toBe('-Infinity')
    expect(formatNumber(undefined)).toBe('Unknown')
    expect(formatNumber(null)).toBe('Unknown')
  })

  it('keeps a real zero distinguishable from missing data', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(NaN)).not.toBe(formatNumber(0))
  })

  it('labels an unparseable time', () => {
    expect(formatUtcTime('not a date')).toBe('Invalid time (UTC)')
  })

  it('renders the same instant identically whatever offset it was written in', () => {
    expect(formatUtcTime('2026-01-02T05:04:05+02:00')).toBe(formatUtcTime('2026-01-02T03:04:05Z'))
  })

  it('round-trips ticks across magnitudes', () => {
    for (const tick of [0, 1, -2.5, 500000, 1e-7, 3.3e-5, 1.5e12, 0.1 + 0.2]) {
      expect(Number(formatTickNumber(tick))).toBe(tick)
    }
    expect(formatTickNumber(NaN)).toBe('NaN')
  })
})

describe('single formatter module', () => {
  // Locale- or timezone-dependent formatting is only allowed in formatters.js.
  const forbidden = /\.toLocale\w*\(|\.toFixed\(|\bIntl\.|\.getHours\(|\.getTimezoneOffset\(/
  const files = Object.entries(
    import.meta.glob(['./**/*.js', '!./**/*.test.js', '!./formatters.js'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )

  it('finds the source files', () => {
    expect(files.map(([path]) => path)).toContain('./main.js')
    expect(files.map(([path]) => path)).toContain('./chart/interaction.js')
  })

  it.each(files)('%s formats nothing on its own', (_path, source) => {
    expect(source).not.toMatch(forbidden)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { install, milestone, record, reset, summary, timed } from './perf.js'

describe('perf instrumentation', () => {
  beforeEach(() => reset())

  it('summarises samples with nearest-rank percentiles', () => {
    for (let ms = 1; ms <= 100; ms++) record('redraw', ms)

    expect(summary().redraw).toEqual({ count: 100, median: 50, p95: 95, max: 100, total: 5050 })
  })

  it('handles a single sample', () => {
    record('once', 7)

    expect(summary().once).toEqual({ count: 1, median: 7, p95: 7, max: 7, total: 7 })
  })

  it('times a function and returns its result', () => {
    expect(timed('work', () => 42)).toBe(42)
    expect(summary().work.count).toBe(1)
    expect(summary().work.max).toBeGreaterThanOrEqual(0)
  })

  it('records the duration even when the function throws', () => {
    expect(() =>
      timed('boom', () => {
        throw new Error('fail')
      }),
    ).toThrow('fail')
    expect(summary().boom.count).toBe(1)
  })

  it('records a milestone only once', () => {
    milestone('first-render')
    milestone('first-render')

    expect(summary()['first-render'].count).toBe(1)
  })

  it('keeps a bounded number of samples', () => {
    for (let i = 0; i < 2500; i++) record('many', i)

    expect(summary().many.count).toBe(2000)
    expect(summary().many.max).toBe(2499)
  })

  it('resets one name or everything', () => {
    record('a', 1)
    record('b', 1)
    reset('a')
    expect(Object.keys(summary())).toEqual(['b'])
    reset()
    expect(summary()).toEqual({})
  })

  it('installs a reader on the given target', () => {
    const target = {}
    install(target)
    record('x', 3)

    expect(target.__perf.summary().x.count).toBe(1)
  })
})

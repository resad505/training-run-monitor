import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * WCAG 2.1 AA contrast for the colour pairs the UI actually uses.
 * Each pair names the file that declares the foreground colour; the test
 * fails if that colour is no longer there, so the list cannot silently drift
 * away from the stylesheet or the canvas renderer.
 */
const sources = {
  css: readFileSync(new URL('./style.css', import.meta.url), 'utf8'),
  renderer: readFileSync(new URL('./chart/renderer.js', import.meta.url), 'utf8'),
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const PAGE = '#f5f7fb'
const CARD = '#ffffff'

// [what, foreground, background, source of the foreground colour]
const TEXT_PAIRS = [
  ['body text on page', '#172033', PAGE, 'css'],
  ['headings on page', '#111827', PAGE, 'css'],
  ['muted text on card', '#53617a', CARD, 'css'],
  ['muted text on page', '#53617a', PAGE, 'css'],
  ['status chip', '#1d4ed8', '#e6eefb', 'css'],
  ['button label', '#1d4ed8', CARD, 'css'],
  ['anomaly badge', '#be123c', '#fff1f2', 'css'],
  ['clean badge', '#047857', '#ecfdf5', 'css'],
  ['stale indicator', '#9a3412', '#fff7ed', 'css'],
  ['axis tick labels', '#64748b', CARD, 'renderer'],
  ['NaN badge text', '#ffffff', '#b91c1c', 'renderer'],
  ['infinity badge text', '#ffffff', '#b45309', 'renderer'],
  ['log <= 0 badge text', '#ffffff', '#6d28d9', 'renderer'],
]

const NON_TEXT_PAIRS = [
  ['focus ring on card', '#1d4ed8', CARD, 'css'],
  ['focus ring on page', '#1d4ed8', PAGE, 'css'],
  ['input border', '#64748b', CARD, 'css'],
  ['smoothed line', '#2563eb', CARD, 'renderer'],
  ['anomaly diamond', '#ef4444', CARD, 'renderer'],
]

describe('WCAG AA contrast', () => {
  it('computes the reference ratios correctly', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5)
  })

  it.each(TEXT_PAIRS)('%s reaches 4.5:1', (_what, fg, bg, source) => {
    expect(sources[source]).toContain(fg === '#ffffff' ? bg : fg)
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(NON_TEXT_PAIRS)('%s reaches 3:1', (_what, fg, bg, source) => {
    expect(sources[source]).toContain(fg)
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3)
  })
})

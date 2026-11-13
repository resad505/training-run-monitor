const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 5,
})

const integerFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

const utcTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function formatNumber(value) {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return '+Infinity'
  if (value === -Infinity) return '-Infinity'
  if (!Number.isFinite(value)) return 'Unknown'
  return numberFormatter.format(value)
}

export function formatInteger(value) {
  if (!Number.isFinite(value)) return formatNumber(value)
  return integerFormatter.format(value)
}

export function formatUtcTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return 'Invalid time (UTC)'
  return `${utcTimeFormatter.format(date)} UTC`
}

/**
 * Format a finite tick so Number(label) remains exactly the original value.
 * Deliberately not Intl.NumberFormat: grouping separators and significant-digit
 * rounding would break that round trip. String() and toExponential() are
 * defined by ECMAScript without reference to the viewer's locale, so the
 * output is still deterministic.
 */
export function formatTickNumber(value) {
  if (!Number.isFinite(value)) return formatNumber(value)
  if (value === 0) return '0'

  const abs = Math.abs(value)
  if (abs >= 1e9 || (abs < 1e-4 && abs > 0)) {
    for (let digits = 0; digits <= 16; digits++) {
      const candidate = value.toExponential(digits)
      if (Number(candidate) === value) return candidate
    }
    return String(value)
  }

  const rounded = Number(value.toPrecision(10))
  const candidate = String(rounded)
  return Number(candidate) === value ? candidate : String(value)
}

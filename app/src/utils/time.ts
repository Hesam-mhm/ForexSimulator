// All simulation timestamps are UTC (matches the broker-server convention baked into the data).
// We deliberately avoid `new Date(str)` / `Date#getFullYear` here since those read the
// browser's local timezone, which would silently shift the jump target for anyone not on UTC.

export function msToUtcInputValue(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}`
}

export function utcInputValueToMs(value: string): number {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return NaN
  const [, y, mo, d, h, mi] = m
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
}

export function formatUtc(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`
}

export function formatUtcShort(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}`
}

import type { Bar } from '../types'

export type SessionLevelsSettings = {
  historyDays: number
  tokyoOpen: string
  londonOpen: string
  nyOpen: string
  nyClose: string
  windowHours: number
  lineWidth: number
  showLabels: boolean
  labelsHistory: boolean
  showSessionLines: boolean
  showTimePoints: boolean
  showBands: boolean
  showPreviousDay: boolean
  showAsia: boolean
  showLondon: boolean
  showNYClose: boolean
  showPreviousWeek: boolean
  bandLon1Opacity: number
  bandLon2Opacity: number
  bandNY1Opacity: number
  bandNY2Opacity: number
  labelFontSize: number
  colAsia: string
  colLondon: string
  colPD: string
  colPW: string
  colNYC: string
  colBandLon1: string
  colBandLon2: string
  colBandNY1: string
  colBandNY2: string
}

export const DEFAULT_SESSION_SETTINGS: SessionLevelsSettings = {
  historyDays: 10,
  tokyoOpen: '09:00',
  londonOpen: '08:00',
  nyOpen: '08:00',
  nyClose: '17:00',
  windowHours: 3,
  lineWidth: 1,
  showLabels: true,
  labelsHistory: false,
  showSessionLines: true,
  showTimePoints: true,
  showBands: true,
  showPreviousDay: true,
  showAsia: true,
  showLondon: true,
  showNYClose: true,
  showPreviousWeek: true,
  bandLon1Opacity: 15,
  bandLon2Opacity: 15,
  bandNY1Opacity: 15,
  bandNY2Opacity: 15,
  labelFontSize: 8,
  colAsia: '#1E90FF',
  colLondon: '#32CD32',
  colPD: '#FFFFFF',
  colPW: '#FFFFFF',
  colNYC: '#FF0000',
  colBandLon1: '#1E90FF',
  colBandLon2: '#9370DB',
  colBandNY1: '#FFA500',
  colBandNY2: '#FF69B4',
}

export type SessionLevelSegment = {
  id: string
  name: string
  from: number
  to: number
  price: number
  color: string
  width: number
  dashed: boolean
  labelAt: number | null
}
export type SessionVertical = { id: string; time: number; color: string }
export type SessionBand = { id: string; from: number; to: number; color: string; opacity: number }
export type SessionLevels = {
  segments: SessionLevelSegment[]
  verticals: SessionVertical[]
  bands: SessionBand[]
  labelFontSize: number
}

export function loadSessionLevelsSettings(): SessionLevelsSettings {
  try {
    const raw = localStorage.getItem('fps_session_levels_settings_v1')
    const parsed = raw ? JSON.parse(raw) as Partial<SessionLevelsSettings> : null
    return { ...DEFAULT_SESSION_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SESSION_SETTINGS }
  }
}

type LocalDate = { year: number; month: number; day: number }
const NY = 'America/New_York'
const LONDON = 'Europe/London'
const TOKYO = 'Asia/Tokyo'
const DATE_PARTS = (timeZone: string) => new Intl.DateTimeFormat('en-US', {
  timeZone,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
})
const DATE_FORMATTERS = new Map([[NY, DATE_PARTS(NY)], [LONDON, DATE_PARTS(LONDON)], [TOKYO, DATE_PARTS(TOKYO)]])

function localParts(ms: number, zone: string) {
  const parts = DATE_FORMATTERS.get(zone)!.formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

function weekday(date: LocalDate) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

function nextWeekday(date: LocalDate): LocalDate {
  let next = addDays(date, 1)
  while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1)
  return next
}

function previousWeekday(date: LocalDate): LocalDate {
  let prev = addDays(date, -1)
  while (weekday(prev) === 0 || weekday(prev) === 6) prev = addDays(prev, -1)
  return prev
}

/** Convert a local wall-clock time to UTC, accounting for the zone's DST offset. */
function zonedTimestamp(zone: string, date: LocalDate, hour: number, minute: number): number {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  let guess = target
  const formatter = DATE_FORMATTERS.get(zone)!
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(guess))
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
    const correction = target - represented
    guess += correction
    if (correction === 0) break
  }
  return guess
}

function parseClock(value: string, fallback: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return parseClock(fallback, '08:00')
  const hour = Math.max(0, Math.min(23, Number(match[1])))
  const minute = Math.max(0, Math.min(59, Number(match[2])))
  return { hour, minute }
}

function lowerBound(bars: Bar[], time: number, end: number) {
  let lo = 0
  let hi = end
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (bars[mid].time < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(bars: Bar[], time: number, end: number) {
  let lo = 0
  let hi = end
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (bars[mid].time <= time) lo = mid + 1
    else hi = mid
  }
  return lo
}

function normalizedSettings(settings: SessionLevelsSettings): SessionLevelsSettings {
  return {
    ...settings,
    historyDays: Math.max(1, Math.min(100, Math.floor(settings.historyDays) || 1)),
    windowHours: Math.max(0.25, Math.min(8, Number(settings.windowHours) || 3)),
    lineWidth: Math.max(1, Math.min(5, Math.floor(settings.lineWidth) || 1)),
    bandLon1Opacity: Math.max(0, Math.min(100, Number(settings.bandLon1Opacity) || 0)),
    bandLon2Opacity: Math.max(0, Math.min(100, Number(settings.bandLon2Opacity) || 0)),
    bandNY1Opacity: Math.max(0, Math.min(100, Number(settings.bandNY1Opacity) || 0)),
    bandNY2Opacity: Math.max(0, Math.min(100, Number(settings.bandNY2Opacity) || 0)),
    labelFontSize: Math.max(6, Math.min(40, Math.floor(settings.labelFontSize) || 8)),
  }
}

/** Calculate session levels using only source bars fully closed by simTime. */
export function calculateSessionLevels(
  bars: Bar[],
  intervalMs: number,
  simTime: number,
  rawSettings: SessionLevelsSettings,
): SessionLevels {
  const settings = normalizedSettings(rawSettings)
  const empty: SessionLevels = {
    segments: [],
    verticals: [],
    bands: [],
    labelFontSize: settings.labelFontSize,
  }
  if (bars.length < 20 || intervalMs <= 0) return empty

  const closedCount = upperBound(bars, simTime - intervalMs, bars.length)
  if (closedCount < 2) return empty
  const nowParts = localParts(simTime, NY)
  const today: LocalDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day }
  const close = parseClock(settings.nyClose, '17:00')
  const nowSeconds = nowParts.hour * 3600 + nowParts.minute * 60
  let currentTradingDate = today
  if (nowSeconds >= close.hour * 3600 + close.minute * 60) currentTradingDate = nextWeekday(currentTradingDate)
  while (weekday(currentTradingDate) === 0 || weekday(currentTradingDate) === 6) {
    currentTradingDate = nextWeekday(currentTradingDate)
  }

  const tokyo = parseClock(settings.tokyoOpen, '09:00')
  const london = parseClock(settings.londonOpen, '08:00')
  const nyOpen = parseClock(settings.nyOpen, '08:00')
  const windowMs = settings.windowHours * 3_600_000
  const closeAt = (date: LocalDate) => zonedTimestamp(NY, date, close.hour, close.minute)
  const rangeHL = (from: number, to: number) => {
    const start = lowerBound(bars, from, closedCount)
    const end = Math.min(lowerBound(bars, to, closedCount), closedCount)
    if (end <= start) return null
    let high = -Infinity
    let low = Infinity
    for (let i = start; i < end; i++) {
      high = Math.max(high, bars[i].high)
      low = Math.min(low, bars[i].low)
    }
    return { high, low }
  }
  const segments: SessionLevelSegment[] = []
  const verticals: SessionVertical[] = []
  const bands: SessionBand[] = []
  let previousWeekDrawn = ''

  for (let offset = settings.historyDays; offset >= 0; offset--) {
    let date = currentTradingDate
    for (let i = 0; i < offset; i++) date = previousWeekday(date)
    const isCurrentDate = offset === 0
    const previousDate = previousWeekday(date)
    const twoDaysBack = previousWeekday(previousDate)
    const dayStart = closeAt(previousDate)
    const dayEnd = closeAt(date)
    const dateParts = { year: date.year, month: date.month, day: date.day }
    const londonOpen = zonedTimestamp(LONDON, dateParts, london.hour, london.minute)
    const newYorkOpen = zonedTimestamp(NY, dateParts, nyOpen.hour, nyOpen.minute)
    const asiaStart = zonedTimestamp(TOKYO, dateParts, tokyo.hour, tokyo.minute)
    const labelTime = isCurrentDate && simTime < dayEnd ? simTime : dayEnd
    const addLevel = (name: string, price: number, from: number, to: number, color: string, dashed = false) => {
      if (to <= from) return
      segments.push({
        id: `${date.year}-${date.month}-${date.day}-${name}-${from}`,
        name,
        from,
        to,
        price,
        color,
        width: settings.lineWidth,
        dashed,
        labelAt: settings.showLabels && (isCurrentDate || settings.labelsHistory) ? labelTime : null,
      })
    }

    if (settings.showPreviousDay) {
      const pd = rangeHL(closeAt(twoDaysBack), dayStart)
      if (pd) {
        addLevel('PDH', pd.high, dayStart, dayEnd, settings.colPD)
        addLevel('PDL', pd.low, dayStart, dayEnd, settings.colPD)
      }
    }

    if (settings.showNYClose) {
      const closeIndex = lowerBound(bars, dayStart, closedCount) - 1
      if (closeIndex >= 0 && closeIndex < closedCount && bars[closeIndex].time >= dayStart - Math.max(3_600_000, intervalMs)) {
        addLevel('NYC', bars[closeIndex].close, dayStart, dayEnd, settings.colNYC)
      }
    }

    const mondayOffset = (weekday(date) + 6) % 7
    const friday = addDays(date, 4 - mondayOffset)
    const weekKey = `${friday.year}-${friday.month}-${friday.day}`
    if (settings.showPreviousWeek && previousWeekDrawn !== weekKey) {
      const weekStart = closeAt(addDays(friday, -7))
      const weekEnd = closeAt(friday)
      const previousWeek = rangeHL(closeAt(addDays(friday, -14)), weekStart)
      if (previousWeek) {
        addLevel('PWH', previousWeek.high, weekStart, weekEnd, settings.colPW, true)
        addLevel('PWL', previousWeek.low, weekStart, weekEnd, settings.colPW, true)
      }
      previousWeekDrawn = weekKey
    }

    if (simTime >= londonOpen && settings.showAsia) {
      const asia = rangeHL(asiaStart, londonOpen)
      if (asia) {
        addLevel('AH', asia.high, londonOpen, londonOpen + windowMs, settings.colAsia)
        addLevel('AL', asia.low, londonOpen, londonOpen + windowMs, settings.colAsia)
      }
    }
    if (simTime >= newYorkOpen && settings.showLondon) {
      const londonRange = rangeHL(londonOpen, newYorkOpen)
      if (londonRange) {
        addLevel('LH', londonRange.high, newYorkOpen, newYorkOpen + windowMs, settings.colLondon)
        addLevel('LL', londonRange.low, newYorkOpen, newYorkOpen + windowMs, settings.colLondon)
      }
    }

    if (settings.showSessionLines) {
      verticals.push({ id: `lon-open-${dayStart}`, time: londonOpen, color: settings.colAsia })
      verticals.push({ id: `lon-window-${dayStart}`, time: londonOpen + windowMs, color: settings.colAsia })
      verticals.push({ id: `ny-open-${dayStart}`, time: newYorkOpen, color: settings.colLondon })
      verticals.push({ id: `ny-window-${dayStart}`, time: newYorkOpen + windowMs, color: settings.colLondon })
    }
    if (settings.showTimePoints) {
      const points = [
        londonOpen - 2 * 3_600_000,
        londonOpen - 3_600_000,
        londonOpen + 3_600_000,
        londonOpen + 2 * 3_600_000,
        newYorkOpen + 3_600_000,
        newYorkOpen + 1.5 * 3_600_000,
        newYorkOpen + 2.5 * 3_600_000,
      ]
      points.forEach((time, i) => verticals.push({ id: `time-${dayStart}-${i}`, time, color: '#FFFFFF' }))
    }
    if (settings.showBands) {
      bands.push({ id: `lon-band-1-${dayStart}`, from: londonOpen, to: londonOpen + 1.5 * 3_600_000, color: settings.colBandLon1, opacity: settings.bandLon1Opacity / 100 })
      bands.push({ id: `lon-band-2-${dayStart}`, from: londonOpen + 1.5 * 3_600_000, to: londonOpen + 3 * 3_600_000, color: settings.colBandLon2, opacity: settings.bandLon2Opacity / 100 })
      bands.push({ id: `ny-band-1-${dayStart}`, from: newYorkOpen, to: newYorkOpen + 1.5 * 3_600_000, color: settings.colBandNY1, opacity: settings.bandNY1Opacity / 100 })
      bands.push({ id: `ny-band-2-${dayStart}`, from: newYorkOpen + 1.5 * 3_600_000, to: newYorkOpen + 3 * 3_600_000, color: settings.colBandNY2, opacity: settings.bandNY2Opacity / 100 })
    }
  }

  return {
    segments,
    verticals,
    bands,
    labelFontSize: settings.labelFontSize,
  }
}

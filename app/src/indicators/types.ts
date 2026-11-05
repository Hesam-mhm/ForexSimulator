export type IndicatorId = 'vwap' | 'ema' | 'rsi' | 'atr' | 'sessions'
export type IndicatorKind = 'overlay' | 'pane'

export type IndicatorDef = {
  id: IndicatorId
  label: string
  kind: IndicatorKind
  color: string
  hasPeriod: boolean
  defaultPeriod?: number
  /** For pane indicators: fixed y-axis bounds to draw as reference lines (e.g. RSI 30/70). */
  refLines?: number[]
  paneMin?: number
  paneMax?: number
}

// New indicators just need an entry here + a case in PriceChart's compute switch —
// the toggle menu and pane/overlay plumbing are generic.
export const INDICATOR_DEFS: IndicatorDef[] = [
  { id: 'vwap', label: 'VWAP', kind: 'overlay', color: '#e8c94a', hasPeriod: false },
  { id: 'ema', label: 'EMA', kind: 'overlay', color: '#ff7043', hasPeriod: true, defaultPeriod: 20 },
  {
    id: 'rsi',
    label: 'RSI',
    kind: 'pane',
    color: '#c78ce8',
    hasPeriod: true,
    defaultPeriod: 14,
    refLines: [30, 70],
    paneMin: 0,
    paneMax: 100,
  },
  { id: 'atr', label: 'ATR', kind: 'pane', color: '#5fb0d6', hasPeriod: true, defaultPeriod: 14 },
  { id: 'sessions', label: 'Sessions & Key Levels', kind: 'overlay', color: '#e8c94a', hasPeriod: false },
]

export type IndicatorState = Record<IndicatorId, { enabled: boolean; period: number }>

export function defaultIndicatorState(): IndicatorState {
  const state = {} as IndicatorState
  for (const def of INDICATOR_DEFS) {
    state[def.id] = { enabled: def.id === 'sessions', period: def.defaultPeriod ?? 14 }
  }
  return state
}

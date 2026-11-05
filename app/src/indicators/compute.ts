import type { Candle } from '../engine/priceEngine'

export type IndicatorPoint = { time: number; value: number }

export function sma(candles: Candle[], period: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = []
  let sum = 0
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close
    if (i >= period) sum -= candles[i - period].close
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period })
  }
  return out
}

export function ema(candles: Candle[], period: number): IndicatorPoint[] {
  const k = 2 / (period + 1)
  let prev: number | null = null
  const out: IndicatorPoint[] = []
  for (const c of candles) {
    prev = prev === null ? c.close : c.close * k + prev * (1 - k)
    out.push({ time: c.time, value: prev })
  }
  return out
}

export function rsi(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = []
  if (candles.length < 2) return out
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    if (i <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (i === period) out.push({ time: candles[i].time, value: rsiFromAvg(avgGain, avgLoss) })
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      out.push({ time: candles[i].time, value: rsiFromAvg(avgGain, avgLoss) })
    }
  }
  return out
}
function rsiFromAvg(avgGain: number, avgLoss: number) {
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export function atr(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = []
  if (!candles.length) return out
  let prevClose = candles[0].close
  const trs: number[] = []
  let atrPrev: number | null = null
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const tr = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    prevClose = c.close
    if (atrPrev === null) {
      trs.push(tr)
      if (trs.length === period) {
        atrPrev = trs.reduce((a, b) => a + b, 0) / period
        out.push({ time: c.time, value: atrPrev })
      }
    } else {
      atrPrev = (atrPrev * (period - 1) + tr) / period
      out.push({ time: c.time, value: atrPrev })
    }
  }
  return out
}

/**
 * Session VWAP (resets each UTC day). We don't carry real per-candle volume
 * through the aggregation pipeline, so activity is approximated with each
 * candle's (high-low) range as a weight — busier/wider candles pull the
 * average more, which behaves closer to real VWAP than a flat unweighted
 * average, but it is an approximation, not textbook volume-weighted price.
 */
export function vwap(candles: Candle[]): IndicatorPoint[] {
  const out: IndicatorPoint[] = []
  let cumPV = 0
  let cumWeight = 0
  let curDay = ''
  for (const c of candles) {
    const day = new Date(c.time * 1000).toISOString().slice(0, 10)
    if (day !== curDay) {
      curDay = day
      cumPV = 0
      cumWeight = 0
    }
    const typicalPrice = (c.high + c.low + c.close) / 3
    const weight = Math.max(c.high - c.low, 0.01)
    cumPV += typicalPrice * weight
    cumWeight += weight
    out.push({ time: c.time, value: cumPV / cumWeight })
  }
  return out
}

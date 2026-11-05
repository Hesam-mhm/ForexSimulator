import type { Candle } from '../engine/priceEngine'
import type { IndicatorPoint } from './compute'

export type IncrementalIndicatorKind = 'vwap' | 'ema' | 'rsi' | 'atr'

export type IncrementalIndicatorCache = {
  kind: IncrementalIndicatorKind
  period: number
  inputLength: number
  firstOutputIndex: number
  points: IndicatorPoint[]
  stateA: number[]
  stateB: number[]
  stateC: number[]
}

function rsiFromAvg(avgGain: number, avgLoss: number) {
  if (avgLoss === 0) return 100
  const relativeStrength = avgGain / avgLoss
  return 100 - 100 / (1 + relativeStrength)
}

function candleDay(time: number) {
  return Math.floor(time / 86_400)
}

export function buildIndicatorCache(
  kind: IncrementalIndicatorKind,
  candles: Candle[],
  period = 14,
): IncrementalIndicatorCache {
  const safePeriod = Math.max(1, Math.floor(period))
  const cache: IncrementalIndicatorCache = {
    kind,
    period: safePeriod,
    inputLength: candles.length,
    firstOutputIndex: kind === 'rsi' ? safePeriod : kind === 'atr' ? safePeriod - 1 : 0,
    points: [],
    stateA: new Array(candles.length),
    stateB: new Array(candles.length),
    stateC: new Array(candles.length),
  }

  if (kind === 'ema') {
    const alpha = 2 / (safePeriod + 1)
    let previous: number | null = null
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]
      previous = previous == null ? candle.close : candle.close * alpha + previous * (1 - alpha)
      cache.stateA[i] = previous
      cache.points.push({ time: candle.time, value: previous })
    }
    return cache
  }

  if (kind === 'rsi') {
    let averageGain = 0
    let averageLoss = 0
    cache.stateA[0] = 0
    cache.stateB[0] = 0
    for (let i = 1; i < candles.length; i++) {
      const change = candles[i].close - candles[i - 1].close
      const gain = Math.max(change, 0)
      const loss = Math.max(-change, 0)
      if (i <= safePeriod) {
        averageGain += gain / safePeriod
        averageLoss += loss / safePeriod
      } else {
        averageGain = (averageGain * (safePeriod - 1) + gain) / safePeriod
        averageLoss = (averageLoss * (safePeriod - 1) + loss) / safePeriod
      }
      cache.stateA[i] = averageGain
      cache.stateB[i] = averageLoss
      if (i >= safePeriod) {
        cache.points.push({ time: candles[i].time, value: rsiFromAvg(averageGain, averageLoss) })
      }
    }
    return cache
  }

  if (kind === 'atr') {
    let previousClose = candles[0]?.close ?? 0
    let trueRangeSum = 0
    let previousAtr: number | null = null
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]
      const trueRange = i === 0
        ? candle.high - candle.low
        : Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose))
      previousClose = candle.close
      if (previousAtr == null) {
        trueRangeSum += trueRange
        if (i + 1 === safePeriod) {
          previousAtr = trueRangeSum / safePeriod
          cache.points.push({ time: candle.time, value: previousAtr })
        }
      } else {
        previousAtr = (previousAtr * (safePeriod - 1) + trueRange) / safePeriod
        cache.points.push({ time: candle.time, value: previousAtr })
      }
      cache.stateA[i] = previousAtr ?? 0
      cache.stateB[i] = trueRangeSum
    }
    return cache
  }

  let currentDay = -1
  let cumulativePriceWeight = 0
  let cumulativeWeight = 0
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const day = candleDay(candle.time)
    if (day !== currentDay) {
      currentDay = day
      cumulativePriceWeight = 0
      cumulativeWeight = 0
    }
    const typicalPrice = (candle.high + candle.low + candle.close) / 3
    const weight = Math.max(candle.high - candle.low, 0.01)
    cumulativePriceWeight += typicalPrice * weight
    cumulativeWeight += weight
    cache.stateA[i] = cumulativePriceWeight
    cache.stateB[i] = cumulativeWeight
    cache.stateC[i] = day
    cache.points.push({ time: candle.time, value: cumulativePriceWeight / cumulativeWeight })
  }
  return cache
}

/** Recalculate just the forming/appended candle using cached state for its predecessor. */
export function updateLastIndicator(
  cache: IncrementalIndicatorCache,
  candles: Candle[],
): IndicatorPoint | null {
  const index = candles.length - 1
  if (index < 0 || (cache.inputLength !== candles.length && cache.inputLength !== index)) return null

  const { kind, period } = cache
  cache.points.length = Math.max(0, index - cache.firstOutputIndex)
  cache.stateA.length = index
  cache.stateB.length = index
  cache.stateC.length = index
  const candle = candles[index]
  const previousIndex = index - 1
  let value: number | null = null

  if (kind === 'ema') {
    const alpha = 2 / (period + 1)
    const previous = previousIndex >= 0 ? cache.stateA[previousIndex] : null
    value = previous == null ? candle.close : candle.close * alpha + previous * (1 - alpha)
    cache.stateA[index] = value
  } else if (kind === 'rsi') {
    if (index === 0) {
      cache.stateA[index] = 0
      cache.stateB[index] = 0
    } else {
      const change = candle.close - candles[previousIndex].close
      const gain = Math.max(change, 0)
      const loss = Math.max(-change, 0)
      const previousGain = cache.stateA[previousIndex] ?? 0
      const previousLoss = cache.stateB[previousIndex] ?? 0
      const averageGain = index <= period
        ? previousGain + gain / period
        : (previousGain * (period - 1) + gain) / period
      const averageLoss = index <= period
        ? previousLoss + loss / period
        : (previousLoss * (period - 1) + loss) / period
      cache.stateA[index] = averageGain
      cache.stateB[index] = averageLoss
      if (index >= period) value = rsiFromAvg(averageGain, averageLoss)
    }
  } else if (kind === 'atr') {
    const previousClose = previousIndex >= 0 ? candles[previousIndex].close : candle.close
    const trueRange = index === 0
      ? candle.high - candle.low
      : Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose))
    if (index < period) {
      const sum = (cache.stateB[previousIndex] ?? 0) + trueRange
      cache.stateB[index] = sum
      if (index === period - 1) {
        value = sum / period
        cache.stateA[index] = value
      } else {
        cache.stateA[index] = 0
      }
    } else {
      const previousAtr = cache.stateA[previousIndex]
      if (previousAtr == null) return null
      value = (previousAtr * (period - 1) + trueRange) / period
      cache.stateA[index] = value
      cache.stateB[index] = cache.stateB[previousIndex] ?? 0
    }
  } else {
    const day = candleDay(candle.time)
    const previousDay = previousIndex >= 0 ? cache.stateC[previousIndex] : -1
    const cumulativePriceWeight = day === previousDay && previousIndex >= 0 ? cache.stateA[previousIndex] : 0
    const cumulativeWeight = day === previousDay && previousIndex >= 0 ? cache.stateB[previousIndex] : 0
    const typicalPrice = (candle.high + candle.low + candle.close) / 3
    const weight = Math.max(candle.high - candle.low, 0.01)
    cache.stateA[index] = cumulativePriceWeight + typicalPrice * weight
    cache.stateB[index] = cumulativeWeight + weight
    cache.stateC[index] = day
    value = cache.stateA[index] / cache.stateB[index]
  }

  cache.inputLength = candles.length
  if (value == null) return null
  const point = { time: candle.time, value }
  cache.points.push(point)
  return point
}

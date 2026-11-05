import type { Bar, Speed } from '../types'

const DEFAULT_BAR_MS = 15 * 60 * 1000
const MINUTE_MS = 60 * 1000


export type Candle = {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
}

export type EngineTick = {
  simTime: number
  mid: number
  bid: number
  ask: number
  newsSpike: boolean
  isRealData: boolean
}

export type RealTick = { t: number; bid: number; ask: number }

/** Columnar, zero-copy view of an FXTK daily tape. */
export type TickTape = {
  dayStartMs: number
  count: number
  priceScale: number
  dataOffset: number
  view: DataView
}

// deterministic PRNG seeded per-bar so scrubbing/replaying is stable
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministic intra-bar price path: open -> (low/high in a plausible order) -> close, plus noise.
 * News bars front-load the move into the first ~1-2 minutes (like a real release reaction)
 * instead of drifting evenly across the full 15 minutes.
 */
function priceAtFraction(bar: Bar, frac: number, isNews: boolean): number {
  const f = Math.max(0, Math.min(1, frac))
  const bullish = bar.close >= bar.open
  const mid1 = bullish ? bar.low : bar.high
  const mid2 = bullish ? bar.high : bar.low
  const [t1, t2] = isNews ? [0.1, 0.25] : [0.35, 0.7]
  const keypoints: [number, number][] = [
    [0, bar.open],
    [t1, mid1],
    [t2, mid2],
    [1, bar.close],
  ]

  let base = bar.close
  for (let i = 0; i < keypoints.length - 1; i++) {
    const [t0, p0] = keypoints[i]
    const [t1, p1] = keypoints[i + 1]
    if (f >= t0 && f <= t1) {
      const localT = t1 === t0 ? 0 : (f - t0) / (t1 - t0)
      base = p0 + (p1 - p0) * localT
      break
    }
  }

  const rng = mulberry32(Math.floor(bar.time / 1000))
  const seed1 = rng() * 1000
  const seed2 = rng() * 1000
  const range = Math.max(bar.high - bar.low, 0.01)
  const noise =
    Math.sin(f * 23 + seed1) * range * 0.035 + Math.sin(f * 71 + seed2) * range * 0.018

  const value = base + noise
  return Math.min(bar.high, Math.max(bar.low, value))
}

type Listener = (tick: EngineTick) => void
type CandleListener = (candle: Candle, isNew: boolean) => void
type BulkCandleListener = (candles: Candle[]) => void
type StateListener = () => void

export class PriceEngine {
  private bars: Bar[] = []
  private barIntervalMs = DEFAULT_BAR_MS
  private simTime = 0
  private playing = false
  private speed: Speed = 300
  private spread = 0.22
  private rafId: number | null = null
  private lastFrameAt = 0
  private lastMinuteBucket = -1
  private tickListeners = new Set<Listener>()
  private candleListeners = new Set<CandleListener>()
  private bulkCandleListeners = new Set<BulkCandleListener>()
  private bulkSink: Candle[] | null = null
  private stateListeners = new Set<StateListener>()
  private ready = false
  private globalAvgRange = Infinity
  private newsFlags: boolean[] = []
  private realTicks: RealTick[] | null = null
  private realTickTapes = new Map<number, TickTape>()
  private realEventMs = 0

  /** Set a short news-event tick window, which takes priority over daily tapes. */
  setRealTicks(ticks: RealTick[] | null, eventMs = 0) {
    this.realTicks = ticks && ticks.length ? ticks : null
    this.realEventMs = eventMs
  }

  /** Attach the selected day's tape without expanding it into JS objects. */
  setRealTickTape(tape: TickTape | null, eventMs = 0) {
    this.realTicks = null
    this.realTickTapes.clear()
    if (tape && tape.count) this.realTickTapes.set(tape.dayStartMs, tape)
    this.realEventMs = eventMs
  }

  hasRealTickTape(dayStartMs: number) {
    return this.realTickTapes.has(dayStartMs)
  }

  /** Add a neighboring day as playback approaches it. */
  addRealTickTape(tape: TickTape) {
    if (!tape.count) return
    this.realTickTapes.delete(tape.dayStartMs)
    this.realTickTapes.set(tape.dayStartMs, tape)
    while (this.realTickTapes.size > 4) {
      const oldestDay = this.realTickTapes.keys().next().value
      if (oldestDay == null) break
      this.realTickTapes.delete(oldestDay)
    }
  }

  private interpolateRealTicks(ticks: RealTick[], simTime: number): { bid: number; ask: number } | null {
    const first = ticks[0]
    const last = ticks[ticks.length - 1]
    if (simTime < first.t || simTime > last.t) return null
    if (simTime === first.t) return { bid: first.bid, ask: first.ask }
    if (simTime === last.t) return { bid: last.bid, ask: last.ask }
    let lo = 0
    let hi = ticks.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ticks[mid].t <= simTime) lo = mid
      else hi = mid - 1
    }
    const a = ticks[lo]
    const b = ticks[Math.min(lo + 1, ticks.length - 1)]
    const span = b.t - a.t
    const localT = span > 0 ? (simTime - a.t) / span : 0
    return {
      bid: a.bid + (b.bid - a.bid) * localT,
      ask: a.ask + (b.ask - a.ask) * localT,
    }
  }

  private realTickAt(simTime: number): { bid: number; ask: number } | null {
    const ticks = this.realTicks
    if (ticks && simTime >= ticks[0].t && simTime <= ticks[ticks.length - 1].t) {
      return this.interpolateRealTicks(ticks, simTime)
    }

    const dayStartMs = Math.floor(simTime / 86_400_000) * 86_400_000
    const tape = this.realTickTapes.get(dayStartMs)
    if (tape) {
      const { view, dataOffset, dayStartMs, count, priceScale } = tape
      const offsetAt = (index: number) => view.getUint32(dataOffset + index * 12, true)
      const priceAt = (index: number, fieldOffset: number) =>
        view.getInt32(dataOffset + index * 12 + fieldOffset, true) / priceScale
      const firstOffset = offsetAt(0)
      const lastOffset = offsetAt(count - 1)
      const offset = simTime - dayStartMs
      if (offset < firstOffset || offset > lastOffset) return null
      if (offset === firstOffset) return { bid: priceAt(0, 4), ask: priceAt(0, 8) }
      if (offset === lastOffset) return { bid: priceAt(count - 1, 4), ask: priceAt(count - 1, 8) }

      let lo = 0
      let hi = count - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (offsetAt(mid) <= offset) lo = mid
        else hi = mid - 1
      }
      const next = Math.min(lo + 1, count - 1)
      const leftOffset = offsetAt(lo)
      const rightOffset = offsetAt(next)
      const span = rightOffset - leftOffset
      const localT = span > 0 ? (offset - leftOffset) / span : 0
      const bid = priceAt(lo, 4)
      const ask = priceAt(lo, 8)
      return {
        bid: bid + (priceAt(next, 4) - bid) * localT,
        ask: ask + (priceAt(next, 8) - ask) * localT,
      }
    }

    return null
  }

  /** Emit every real quote crossed during a playback interval, while the chart
   * itself can batch candle updates once per frame / step. */
  private processRealTickEvents(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0
    const tapeCursors: { tape: TickTape; index: number; lastOffset: number }[] = []

    for (const tape of this.realTickTapes.values()) {
      const firstOffset = tape.view.getUint32(tape.dataOffset, true)
      const lastIndex = tape.count - 1
      const lastOffset = tape.view.getUint32(tape.dataOffset + lastIndex * 12, true)
      const fromOffset = Math.max(firstOffset, fromMs - tape.dayStartMs)
      const toOffset = Math.min(lastOffset, toMs - tape.dayStartMs)
      if (toOffset < fromOffset) continue

      let lo = 0
      let hi = tape.count
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        const offset = tape.view.getUint32(tape.dataOffset + mid * 12, true)
        if (offset <= fromMs - tape.dayStartMs) lo = mid + 1
        else hi = mid
      }
      if (lo < tape.count) tapeCursors.push({ tape, index: lo, lastOffset: toOffset })
    }

    const newsTicks = this.realTicks
    let newsIndex = 0
    if (newsTicks?.length) {
      let lo = 0
      let hi = newsTicks.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (newsTicks[mid].t <= fromMs) lo = mid + 1
        else hi = mid
      }
      newsIndex = lo
    }

    const newsStart = newsTicks?.[0]?.t ?? Infinity
    const newsEnd = newsTicks?.[newsTicks.length - 1]?.t ?? -Infinity
    let processed = 0

    while (true) {
      let sourceTape: (typeof tapeCursors)[number] | null = null
      let sourceTime = Infinity
      for (const cursor of tapeCursors) {
        if (cursor.index >= cursor.tape.count) continue
        const offset = cursor.tape.view.getUint32(cursor.tape.dataOffset + cursor.index * 12, true)
        if (offset > cursor.lastOffset) continue
        const timestamp = cursor.tape.dayStartMs + offset
        if (timestamp < sourceTime) {
          sourceTime = timestamp
          sourceTape = cursor
        }
      }

      const sourceNews = newsTicks && newsIndex < newsTicks.length ? newsTicks[newsIndex] : null
      if (sourceNews && sourceNews.t <= toMs && sourceNews.t < sourceTime) {
        sourceTime = sourceNews.t
        sourceTape = null
      } else if (sourceNews && sourceNews.t <= toMs && sourceNews.t === sourceTime) {
        // Prefer the event-specific quote over the daily tape at matching times.
        sourceTime = sourceNews.t
        sourceTape = null
      }

      if (!Number.isFinite(sourceTime) || sourceTime > toMs) break
      let quote: { bid: number; ask: number }
      if (sourceTape) {
        const { tape, index } = sourceTape
        const recordOffset = tape.dataOffset + index * 12
        const offset = tape.view.getUint32(recordOffset, true)
        sourceTape.index++
        const timestamp = tape.dayStartMs + offset
        if (timestamp >= newsStart && timestamp <= newsEnd) continue
        quote = {
          bid: tape.view.getInt32(recordOffset + 4, true) / tape.priceScale,
          ask: tape.view.getInt32(recordOffset + 8, true) / tape.priceScale,
        }
      } else {
        newsIndex++
        quote = { bid: sourceNews!.bid, ask: sourceNews!.ask }
      }

      this.simTime = sourceTime
      this.tick(true, quote)
      processed++
    }

    return processed
  }

  setBars(bars: Bar[], intervalMs = DEFAULT_BAR_MS) {
    this.bars = bars
    this.barIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_BAR_MS
    this.ready = bars.length > 0
    this.newsFlags = new Array(bars.length).fill(false)
    if (bars.length) {
      const ranges = new Array<number>(bars.length)
      let totalRange = 0
      for (let i = 0; i < bars.length; i++) {
        ranges[i] = bars[i].high - bars[i].low
        totalRange += ranges[i]
      }
      this.globalAvgRange = totalRange / bars.length

      let previousRangeSum = 0
      for (let i = 0; i < bars.length; i++) {
        if (i > 0) previousRangeSum += ranges[i - 1]
        if (i > 20) previousRangeSum -= ranges[i - 21]
        const previousCount = Math.min(i, 20)
        if (previousCount > 0) {
          const localAvgRange = previousRangeSum / previousCount
          this.newsFlags[i] = ranges[i] > Math.max(localAvgRange * 2.5, this.globalAvgRange * 2.5)
        }
      }
    }
    this.emitState()
  }

  isReady() {
    return this.ready
  }

  getBars() {
    return this.bars
  }

  getBarIntervalMs() {
    return this.barIntervalMs
  }

  getRange(): [number, number] | null {
    if (!this.bars.length) return null
    return [this.bars[0].time, this.bars[this.bars.length - 1].time + this.barIntervalMs]
  }

  private findBarIndex(t: number): number {
    const bars = this.bars
    if (!bars.length) return -1
    let lo = 0
    let hi = bars.length - 1
    if (t < bars[0].time) return 0
    if (t >= bars[hi].time + this.barIntervalMs) return hi
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (bars[mid].time <= t) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  getBarAt(t: number): Bar | null {
    const idx = this.findBarIndex(t)
    return idx >= 0 ? this.bars[idx] : null
  }

  private nextMinuteCandleTime(after: number): number | null {
    const candidate = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS
    const range = this.getRange()
    if (!range) return null
    const [, end] = range
    if (candidate >= end) return after < end - 1 ? end - 1 : null

    const idx = this.findBarIndex(candidate)
    const bar = this.bars[idx]
    if (bar && candidate >= bar.time && candidate < bar.time + this.barIntervalMs) return candidate

    let lo = 0
    let hi = this.bars.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.bars[mid].time < candidate) lo = mid + 1
      else hi = mid
    }
    return lo < this.bars.length ? this.bars[lo].time : null
  }

  private previousMinuteCandleTime(before: number): number | null {
    const candidate = Math.floor(before / MINUTE_MS) * MINUTE_MS - MINUTE_MS
    if (!this.bars.length || candidate < this.bars[0].time) return null

    const idx = this.findBarIndex(candidate)
    const bar = this.bars[idx]
    if (bar && candidate >= bar.time && candidate < bar.time + this.barIntervalMs) return candidate
    if (bar && candidate >= bar.time + this.barIntervalMs) return bar.time + this.barIntervalMs - MINUTE_MS
    return null
  }

  /**
   * A bar reads as "news" when its high-low range blows out well past its own
   * recent neighborhood (not a flat global average — quiet Asian-session hours
   * and busy London/NY overlaps have wildly different baselines, so a global
   * threshold either misses real spikes or false-flags normal busy hours).
   * Range turns out to separate real releases far more cleanly than tick count.
   */
  private isNewsBar(idx: number): boolean {
    const bar = this.bars[idx]
    if (this.realTicks) {
      const first = this.realTicks[0]
      const last = this.realTicks[this.realTicks.length - 1]
      if (bar.time < last.t && bar.time + this.barIntervalMs > first.t) return false
    }
    for (const tape of this.realTickTapes.values()) {
      const firstMs = tape.dayStartMs + tape.view.getUint32(tape.dataOffset, true)
      const lastOffset = tape.dataOffset + (tape.count - 1) * 12
      const lastMs = tape.dayStartMs + tape.view.getUint32(lastOffset, true)
      if (bar.time < lastMs && bar.time + this.barIntervalMs > firstMs) return false
    }
    return this.newsFlags[idx] ?? false
  }

  /** Return tick-derived native M1 bars directly, or synthesize M1 from wider OHLC bars. */
  private buildMinuteCandles(barIdx: number): Candle[] {
    const bar = this.bars[barIdx]
    if (this.barIntervalMs === MINUTE_MS) {
      return [{
        time: bar.time / 1000,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      }]
    }

    const isNews = this.isNewsBar(barIdx)
    const samplesPerMinute = 6
    const totalMinutes = this.barIntervalMs / MINUTE_MS
    const candles: Candle[] = []
    for (let m = 0; m < totalMinutes; m++) {
      const minuteStart = bar.time + m * MINUTE_MS
      let open = 0
      let high = -Infinity
      let low = Infinity
      let close = 0
      for (let s = 0; s < samplesPerMinute; s++) {
        const t = minuteStart + (s / samplesPerMinute) * MINUTE_MS
        const price = priceAtFraction(bar, (t - bar.time) / this.barIntervalMs, isNews)
        if (s === 0) open = price
        close = price
        high = Math.max(high, price)
        low = Math.min(low, price)
      }
      candles.push({ time: minuteStart / 1000, open, high, low, close })
    }
    return candles
  }

  private minuteCandleAt(timeMs: number): Candle | null {
    const idx = this.findBarIndex(timeMs)
    const bar = this.bars[idx]
    if (!bar || timeMs < bar.time || timeMs >= bar.time + this.barIntervalMs) return null
    if (this.barIntervalMs === MINUTE_MS) return this.buildMinuteCandles(idx)[0] ?? null
    const minuteIndex = Math.floor((timeMs - bar.time) / MINUTE_MS)
    return this.buildMinuteCandles(idx)[minuteIndex] ?? null
  }

  jumpTo(t: number, contextBars?: number, emitPartialCandle = true) {
    const idx = this.findBarIndex(t)
    if (idx < 0) return
    // keep the exact requested time (not snapped to the 15-min bar boundary) so we can
    // land precisely e.g. 1 minute before a news release
    this.simTime = t
    this.lastMinuteBucket = -1
    this.emitCandleReset(idx, contextBars, t)
    this.tick(emitPartialCandle)
    this.emitState()
  }

  private emitCandleReset(idx: number, contextBars: number | undefined, uptoMs: number) {
    let start: number
    if (contextBars == null) {
      start = 0
    } else {
      start = Math.max(0, idx - Math.max(0, Math.trunc(contextBars)))
    }
    const candles: Candle[] = []
    for (let i = start; i < idx; i++) {
      candles.push(...this.buildMinuteCandles(i))
    }
    // the bar we're jumping into is only partially in the past — include just that slice
    if (idx < this.bars.length) {
      candles.push(...this.buildMinuteCandles(idx).filter((c) => c.time * 1000 < uptoMs))
    }
    this.resetListeners.forEach((l) => l(candles))
  }

  /** Re-send the history around the current simulation time (e.g. when the
   *  chart remounts after visiting the dashboard). */
  replay(contextBars?: number) {
    if (!this.bars.length) return
    const idx = this.findBarIndex(this.simTime)
    if (idx < 0) return
    this.emitCandleReset(idx, contextBars, this.simTime)
  }

  private resetListeners = new Set<(candles: Candle[]) => void>()
  onReset(cb: (candles: Candle[]) => void) {
    this.resetListeners.add(cb)
    return () => { this.resetListeners.delete(cb) }
  }

  /**
   * Move by complete available M1 candles. Missing market sessions do not
   * consume steps; forward movement still processes every crossed tick event.
   */
  stepCandles(count: number) {
    if (!this.ready || !Number.isFinite(count) || count === 0) return
    this.pause()
    const steps = Math.min(Math.abs(Math.trunc(count)), 100_000)
    if (!steps) return

    if (count < 0) {
      let target = this.simTime
      for (let i = 0; i < steps; i++) {
        const previous = this.previousMinuteCandleTime(target)
        if (previous == null || previous >= target) break
        target = previous + MINUTE_MS - 1
      }
      if (target !== this.simTime) this.jumpTo(target, undefined, false)
      return
    }

    const tickCandles: Candle[] = []
    const completedCandles = new Map<number, Candle>()
    this.bulkSink = tickCandles
    for (let i = 0; i < steps; i++) {
      const currentMinute = Math.floor(this.simTime / MINUTE_MS) * MINUTE_MS
      const currentCandle = this.minuteCandleAt(currentMinute)
      const candleStart = currentCandle && this.simTime < currentMinute + MINUTE_MS - 1
        ? currentMinute
        : this.nextMinuteCandleTime(this.simTime)
      if (candleStart == null) break

      const target = candleStart + MINUTE_MS - 1
      if (target <= this.simTime) break
      const previous = this.simTime
      this.processRealTickEvents(previous, target)
      this.simTime = target
      this.tick()
      const completed = this.minuteCandleAt(candleStart)
      if (completed) completedCandles.set(completed.time, completed)
    }
    this.bulkSink = null
    const candlesByTime = new Map(tickCandles.map((candle) => [candle.time, candle]))
    completedCandles.forEach((candle, time) => candlesByTime.set(time, candle))
    const collected = [...candlesByTime.values()].sort((a, b) => a.time - b.time)
    if (collected.length) this.bulkCandleListeners.forEach((listener) => listener(collected))
    this.emitState()
  }

  /** Move the simulation by elapsed market time. */
  step(dtSimMs: number) {
    if (!this.ready) return
    this.pause()
    const range = this.getRange()
    if (!range) return
    const [start, end] = range
    const target = Math.max(start, Math.min(this.simTime + dtSimMs, end - 1))
    if (target === this.simTime) return

    if (dtSimMs < 0) {
      // rebuilding the history is the simplest correct way to walk backwards
      this.jumpTo(target)
      return
    }

    const collected: Candle[] = []
    this.bulkSink = collected
    let guard = 0
    while (this.simTime < target && guard++ < 200_000) {
      let next = Math.min(this.simTime + MINUTE_MS, target)
      // same market-closed-gap skip as normal playback
      if (!this.realTickAt(next)) {
        const idx = this.findBarIndex(next)
        const bar = this.bars[idx]
        if (bar && next >= bar.time + this.barIntervalMs && idx + 1 < this.bars.length) {
          next = Math.max(this.simTime + MINUTE_MS, Math.min(this.bars[idx + 1].time, target))
        }
      }
      const previous = this.simTime
      const stepTime = Math.min(next, target)
      this.processRealTickEvents(previous, stepTime)
      this.simTime = stepTime
      this.tick()
    }
    this.bulkSink = null
    if (collected.length) this.bulkCandleListeners.forEach((l) => l(collected))
    this.tick()
    this.emitState()
  }

  play() {
    if (this.playing || !this.ready) return
    this.playing = true
    this.lastFrameAt = performance.now()
    this.loop()
    this.emitState()
  }

  pause() {
    this.playing = false
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    this.emitState()
  }

  isPlaying() {
    return this.playing
  }

  setSpeed(s: Speed) {
    this.speed = s
    this.emitState()
  }

  getSpeed() {
    return this.speed
  }

  getSpread() {
    return this.spread
  }

  /** Synthetic bid/ask spread — differs a lot by instrument (gold vs a JPY pair vs BTC). */
  setSpread(spread: number) {
    this.spread = spread
  }

  getSimTime() {
    return this.simTime
  }

  private loop = () => {
    if (!this.playing) return
    const now = performance.now()
    const dtRealMs = now - this.lastFrameAt
    this.lastFrameAt = now
    const dtSimMs = dtRealMs * this.speed
    this.advance(dtSimMs)
    this.rafId = requestAnimationFrame(this.loop)
  }

  private advance(dtSimMs: number) {
    const range = this.getRange()
    if (!range) return
    const [, end] = range
    const previous = this.simTime
    this.simTime = Math.min(this.simTime + dtSimMs, end - 1)

    // market-closed gaps (weekends, holidays) have no bars at all — crawling
    // through them minute by minute just holds the last close frozen for the
    // whole gap (looks like a flat-line bug). Skip straight to the next bar
    // instead, same as a real terminal simply having no candles for that span.
    if (!this.realTickAt(this.simTime)) {
      const idx = this.findBarIndex(this.simTime)
      const bar = this.bars[idx]
      if (bar && this.simTime >= bar.time + this.barIntervalMs && idx + 1 < this.bars.length) {
        this.simTime = Math.min(this.bars[idx + 1].time, end - 1)
        this.lastMinuteBucket = -1
      }
    }

    if (this.simTime >= end - 1) {
      this.pause()
    }

    const target = this.simTime
    const collected: Candle[] = []
    this.bulkSink = collected
    this.processRealTickEvents(previous, target)
    this.simTime = target
    this.tick()
    this.bulkSink = null
    if (collected.length) this.bulkCandleListeners.forEach((listener) => listener(collected))
  }

  private tick(emitCandle = true, realOverride?: { bid: number; ask: number }) {
    const real = realOverride ?? this.realTickAt(this.simTime)
    let mid: number
    let bid: number
    let ask: number
    let newsSpike: boolean

    if (real) {
      bid = real.bid
      ask = real.ask
      mid = (bid + ask) / 2
      // real ticks carry their own genuine spread — just flag the ~90s right after the
      // release as "hot" for the UI badge, no synthetic widening needed
      newsSpike = this.simTime >= this.realEventMs && this.simTime < this.realEventMs + 90_000
    } else {
      const idx = this.findBarIndex(this.simTime)
      if (idx < 0) return
      const bar = this.bars[idx]
      const frac = (this.simTime - bar.time) / this.barIntervalMs
      const isNews = this.isNewsBar(idx)
      mid = priceAtFraction(bar, frac, isNews)
      // spreads blow out for the first ~20% of a news bar, same as a real broker during a release
      const effSpread = isNews && frac < 0.2 ? this.spread * 4 : this.spread
      bid = mid - effSpread / 2
      ask = mid + effSpread / 2
      newsSpike = isNews && frac < 0.2
    }

    const minuteBucket = Math.floor(this.simTime / MINUTE_MS)
    const candleTime = Math.floor(minuteBucket * MINUTE_MS) / 1000
    const isNew = minuteBucket !== this.lastMinuteBucket
    this.lastMinuteBucket = minuteBucket

    if (isNew) {
      this.currentCandle = { time: candleTime, open: mid, high: mid, low: mid, close: mid }
    } else if (this.currentCandle) {
      this.currentCandle.high = Math.max(this.currentCandle.high, mid)
      this.currentCandle.low = Math.min(this.currentCandle.low, mid)
      this.currentCandle.close = mid
    }
    if (emitCandle && this.currentCandle) {
      if (this.bulkSink) {
        if (isNew || this.bulkSink.length === 0) this.bulkSink.push({ ...this.currentCandle })
        else {
          const last = this.bulkSink[this.bulkSink.length - 1]
          last.high = Math.max(last.high, mid)
          last.low = Math.min(last.low, mid)
          last.close = mid
        }
      } else {
        this.candleListeners.forEach((l) => l(this.currentCandle!, isNew))
      }
    }

    const t: EngineTick = { simTime: this.simTime, mid, bid, ask, newsSpike, isRealData: !!real }
    this.tickListeners.forEach((l) => l(t))
  }

  private currentCandle: Candle | null = null

  onTick(cb: Listener) {
    this.tickListeners.add(cb)
    return () => { this.tickListeners.delete(cb) }
  }

  onCandle(cb: CandleListener) {
    this.candleListeners.add(cb)
    return () => { this.candleListeners.delete(cb) }
  }

  /** Receives the intermediate M1 candles generated by a bulk `step()` as one batch. */
  onCandlesBulk(cb: BulkCandleListener) {
    this.bulkCandleListeners.add(cb)
    return () => { this.bulkCandleListeners.delete(cb) }
  }

  onStateChange(cb: StateListener) {
    this.stateListeners.add(cb)
    return () => { this.stateListeners.delete(cb) }
  }

  private emitState() {
    this.stateListeners.forEach((l) => l())
  }
}

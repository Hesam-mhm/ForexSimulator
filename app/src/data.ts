import type { Bar, DataIndex } from './types'
import type { SymbolId } from './symbols'
import type { TickTape } from './engine/priceEngine'

type RawRow = [number, number, number, number, number, number]

// import.meta.env.BASE_URL is '/' in dev and the configured `base` (e.g.
// '/forex-price-simulator/') in production — plain '/data/...' paths would
// 404 once this is deployed under a GitHub Pages project subpath.
const dataUrl = (path: string) => `${import.meta.env.BASE_URL}data/${path}`

let indexCache: Promise<DataIndex> | null = null
const symbolBarsCache = new Map<SymbolId, Promise<LoadedSymbolBars>>()
const tickTapeCache = new Map<string, Promise<TickTape | null>>()
const MAX_CACHED_TICK_DAYS = 3
const TICK_HEADER_BYTES = 20
const TICK_RECORD_BYTES = 12
const DEFAULT_BAR_INTERVAL_MS = 15 * 60 * 1000

type LoadedSymbolBars = { bars: Bar[]; intervalMs: number }
type TickCandleIndex = {
  intervalMs: number
  months: { month: string; file: string; bars: number }[]
}

function loadIndex(): Promise<DataIndex> {
  if (!indexCache) {
    const request = fetch(dataUrl('index.json')).then((response) => {
      if (!response.ok) throw new Error(`Failed to load data index (${response.status})`)
      return response.json() as Promise<DataIndex>
    })
    indexCache = request
    request.catch(() => {
      if (indexCache === request) indexCache = null
    })
  }
  return indexCache
}

export function loadTickTape(symbol: SymbolId, day: string): Promise<TickTape | null> {
  const key = `${symbol}:${day}`
  const cached = tickTapeCache.get(key)
  if (cached) {
    tickTapeCache.delete(key)
    tickTapeCache.set(key, cached)
    return cached
  }

  const request = (async () => {
    let response = await fetch(dataUrl(`ticks/${symbol}/${day}.bin.gz`))
    let compressed = true
    if (response.status === 404) {
      response = await fetch(dataUrl(`ticks/${symbol}/${day}.bin`))
      compressed = false
    }
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Failed to load ${symbol} tick tape for ${day} (${response.status})`)
    const payload = await response.arrayBuffer()
    const payloadBytes = new Uint8Array(payload, 0, Math.min(2, payload.byteLength))
    const isGzipPayload = payloadBytes.length === 2 && payloadBytes[0] === 0x1f && payloadBytes[1] === 0x8b
    let buffer = payload
    if (compressed && isGzipPayload) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress tick tapes.')
      const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))
      buffer = await new Response(stream).arrayBuffer()
    }
    if (buffer.byteLength < TICK_HEADER_BYTES) throw new Error(`Invalid tick tape header for ${symbol} ${day}`)

    const view = new DataView(buffer)
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
    const count = view.getUint32(12, true)
    const priceScale = view.getUint32(16, true)
    if (magic !== 'FXTK' || priceScale <= 0 || buffer.byteLength !== TICK_HEADER_BYTES + count * TICK_RECORD_BYTES) {
      throw new Error(`Invalid tick tape format for ${symbol} ${day}`)
    }

    return {
      dayStartMs: Number(view.getBigUint64(4, true)),
      count,
      priceScale,
      dataOffset: TICK_HEADER_BYTES,
      view,
    }
  })()

  tickTapeCache.set(key, request)
  request.then(() => {
    while (tickTapeCache.size > MAX_CACHED_TICK_DAYS) {
      const oldest = tickTapeCache.keys().next().value
      if (oldest == null) break
      tickTapeCache.delete(oldest)
    }
  }).catch(() => {
    if (tickTapeCache.get(key) === request) tickTapeCache.delete(key)
  })
  return request
}

export function loadSymbolBars(symbol: SymbolId): Promise<LoadedSymbolBars> {
  const cached = symbolBarsCache.get(symbol)
  if (cached) return cached

  const request = (async () => {
    if (symbol === 'XAUUSD') {
      const candleIndexResponse = await fetch(dataUrl('tick_candles/XAUUSD/index.json'))
      if (candleIndexResponse.ok) {
        const candleIndex = await candleIndexResponse.json() as TickCandleIndex
        if (candleIndex.intervalMs === 60_000 && candleIndex.months.length) {
          const perMonth = await Promise.all(candleIndex.months.map(async (month) => {
            const response = await fetch(dataUrl(`tick_candles/XAUUSD/${month.file}`))
            if (!response.ok) throw new Error(`Failed to load tick-derived XAUUSD ${month.month} (${response.status})`)
            return response.json() as Promise<RawRow[]>
          }))
          const bars: Bar[] = []
          for (const rows of perMonth) {
            for (const [time, open, high, low, close, ticks] of rows) {
              bars.push({ time, open, high, low, close, ticks })
            }
          }
          bars.sort((a, b) => a.time - b.time)
          return { bars, intervalMs: candleIndex.intervalMs }
        }
      } else if (candleIndexResponse.status !== 404) {
        throw new Error(`Failed to load tick-candle index (${candleIndexResponse.status})`)
      }
    }

    const index = await loadIndex()
    const months = index.symbols[symbol]?.months ?? []
    const perMonth = await Promise.all(
      months.map(async (month) => {
        const response = await fetch(dataUrl(`${symbol}_${month.month}.json`))
        if (!response.ok) throw new Error(`Failed to load ${symbol} ${month.month} (${response.status})`)
        return response.json() as Promise<RawRow[]>
      }),
    )
    const bars: Bar[] = []
    for (const rows of perMonth) {
      for (const [time, open, high, low, close, ticks] of rows) {
        bars.push({ time, open, high, low, close, ticks })
      }
    }
    bars.sort((a, b) => a.time - b.time)
    return { bars, intervalMs: DEFAULT_BAR_INTERVAL_MS }
  })()

  symbolBarsCache.set(symbol, request)
  request.catch(() => {
    if (symbolBarsCache.get(symbol) === request) symbolBarsCache.delete(symbol)
  })
  return request
}

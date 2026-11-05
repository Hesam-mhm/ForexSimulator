import { useEffect, useRef, useState } from 'react'
import type { PriceEngine } from '../engine/priceEngine'
import { formatUtc } from '../utils/time'
import { NEWS_CALENDAR_2026 } from '../newsCalendar'
import { SYMBOLS, SYMBOL_MAP, formatPrice, type SymbolId } from '../symbols'

type Props = {
  engine: PriceEngine
  symbol: SymbolId

  bid: number
  ask: number

  simTime: number
  newsSpike: boolean
  isRealData: boolean
  tickDataStatus: string
  onTickDataStatusChange: (status: string) => void
  onSymbolChange: (s: SymbolId) => void

  onJump: (t: number) => void
  onOpenDashboard: () => void
}


const NEWS_GROUPS = [
  { type: 'FOMC' as const, label: 'FOMC — Rate Decision' },
  { type: 'NFP' as const, label: 'NFP — Non-Farm Payrolls' },
  { type: 'CPI' as const, label: 'CPI — Inflation' },
]


export default function TopBar({
  engine,
  symbol,

  bid,
  ask,

  simTime,
  newsSpike,
  isRealData,
  tickDataStatus,
  onTickDataStatusChange,
  onSymbolChange,

  onJump,
  onOpenDashboard,
}: Props) {
  const [lastNewsMs, setLastNewsMs] = useState<number | null>(null)
  const jumpRequestRef = useRef(0)

  useEffect(() => {
    jumpRequestRef.current++
  }, [symbol])

  const jumpToNews = async (ms: number) => {
    const ev = NEWS_CALENDAR_2026.find((e) => e.ms === ms)
    if (!ev) return
    setLastNewsMs(ms)
    const requestId = ++jumpRequestRef.current
    const requestedSymbol = symbol
    const target = ev.ms - 60_000 // land 1 minute before the release
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/news_ticks/${requestedSymbol}/${ev.key}.json`)
      if (res.ok) {
        const rows: [number, number, number][] = await res.json()
        if (requestId !== jumpRequestRef.current) return
        engine.setRealTicks(
          rows.map(([t, bid, ask]) => ({ t, bid, ask })),
          ev.ms,
        )
        onTickDataStatusChange('Using high-resolution news-event ticks.')
      } else {
        if (requestId !== jumpRequestRef.current) return
        engine.setRealTicks(null)
        onTickDataStatusChange('News tick file unavailable; using the available candle data instead.')
      }
    } catch {
      if (requestId !== jumpRequestRef.current) return
      engine.setRealTicks(null)
      onTickDataStatusChange('News tick file unavailable; using the available candle data instead.')
    }
    onJump(target)
  }

  return (
    <div className="topbar">
      <div className="topbar-left">
        <select
          className="symbol-badge symbol-select"
          value={symbol}
          onChange={(e) => onSymbolChange(e.target.value as SymbolId)}
        >
          {SYMBOLS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </select>
        <div className="price-block">
          <div className="price-bid">{formatPrice(bid, symbol)}</div>
          <div className="price-ask">{formatPrice(ask, symbol)}</div>
          <div className="price-spread" title="Spread: Ask − Bid">
            <span>SPR</span>
            <b>{bid > 0 && ask > 0 ? (ask - bid).toFixed(SYMBOL_MAP[symbol].pricePrecision) : '—'}</b>
          </div>
        </div>
        <div className="sim-clock">{formatUtc(simTime)}</div>
        {isRealData && <div className="real-badge">● REAL TICKS</div>}
        {!isRealData && (tickDataStatus.startsWith('No prepared') || tickDataStatus.startsWith('Tick data') || tickDataStatus.startsWith('News tick file')) && (
          <div className="tick-data-warning" title={tickDataStatus}>● CANDLE FALLBACK</div>
        )}
        {newsSpike && <div className="news-badge" title="High Impact News" />}
      </div>

      <div className="topbar-right">
        <button
          className="btn btn-secondary btn-tiny"
          onClick={onOpenDashboard}
          title="Back to dashboard (choose account)"
        >
          ⌂ Dashboard
        </button>
        <button
          className="btn btn-secondary btn-tiny"
          onClick={() => lastNewsMs != null && jumpToNews(lastNewsMs)}
          disabled={lastNewsMs == null}
          title="Return to selected news"
        >
          ↺
        </button>
        <select
          className="speed-select news-select"
          defaultValue=""
          onChange={(e) => {
            const ms = Number(e.target.value)
            if (ms) jumpToNews(ms)
            e.target.value = ''
          }}
        >
          <option value="" disabled>
            ⚡ News Calendar 2026...
          </option>
          {NEWS_GROUPS.map((g) => (
            <optgroup key={g.type} label={g.label}>
              {NEWS_CALENDAR_2026.filter((e) => e.type === g.type).map((e) => (
                <option key={e.ms} value={e.ms}>
                  {e.label} — {new Date(e.ms).toISOString().slice(11, 16)} UTC
                </option>
              ))}
            </optgroup>
          ))}
        </select>


      </div>
    </div>
  )
}

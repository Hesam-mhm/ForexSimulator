import { useMemo, useState } from 'react'
import type { AccountProfile, ClosedTrade } from '../types'
import { formatPrice } from '../symbols'
import { calculateAccountPerformance, type AccountPerformanceMetrics } from '../utils/accountPerformance'

type Props = {
  account: AccountProfile
}

const REASONS: Record<ClosedTrade['reason'], string> = {
  manual: 'Manual',
  sl: 'Stop loss',
  tp: 'Take profit',
  stopout: 'Stop out',
}

function money(value: number, signed = false) {
  const prefix = signed && value > 0 ? '+' : ''
  return `${prefix}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function signedMoney(value: number) {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(value)}`
}

function shortMoney(value: number) {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${value < 0 ? '−' : ''}$${(abs / 1_000_000).toFixed(1)}m`
  if (abs >= 10_000) return `${value < 0 ? '−' : ''}$${(abs / 1_000).toFixed(0)}k`
  if (abs >= 1_000) return `${value < 0 ? '−' : ''}$${(abs / 1_000).toFixed(1)}k`
  return `${value < 0 ? '−' : ''}$${abs.toFixed(0)}`
}

function dateTime(ms: number) {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function duration(openTime: number, closeTime: number) {
  const minutes = Math.max(0, Math.floor((closeTime - openTime) / 60_000))
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${minutes}m`
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'positive' | 'negative' | 'neutral' }) {
  return (
    <div className="performance-metric">
      <span className="performance-metric-label">{label}</span>
      <strong className={tone ? `performance-value performance-value-${tone}` : 'performance-value'}>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function chartX(index: number, count: number, left: number, right: number) {
  return count <= 1 ? left : left + (index / (count - 1)) * (right - left)
}

function EquityChart({ metrics }: { metrics: AccountPerformanceMetrics }) {
  const points = metrics.equityCurve
  const width = 820
  const height = 220
  const left = 74
  const right = width - 16
  const top = 16
  const bottom = height - 34
  const values = points.map((point) => point.equity)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const span = maxValue - minValue || Math.max(Math.abs(maxValue) * 0.02, 1)
  const min = minValue - span * 0.12
  const max = maxValue + span * 0.12
  const y = (value: number) => bottom - ((value - min) / (max - min)) * (bottom - top)
  const line = points.map((point, index) => `${chartX(index, points.length, left, right)},${y(point.equity)}`).join(' ')
  const area = `${left},${bottom} ${line} ${right},${bottom}`
  const gridValues = Array.from({ length: 4 }, (_, index) => min + ((max - min) * index) / 3)

  return (
    <div className="performance-chart-card">
      <div className="performance-chart-heading">
        <div><strong>Equity curve</strong><small>Realized balance after each closed trade</small></div>
        <b className={metrics.netPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>{signedMoney(metrics.netPnl)}</b>
      </div>
      {metrics.tradeCount ? (
        <svg className="performance-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Realized account equity curve">
          <defs>
            <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#26a69a" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#26a69a" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {gridValues.map((value, index) => {
            const gy = y(value)
            return (
              <g key={index}>
                <line x1={left} x2={right} y1={gy} y2={gy} className="performance-grid-line" />
                <text x={left - 8} y={gy + 4} textAnchor="end" className="performance-axis-label">{shortMoney(value)}</text>
              </g>
            )
          })}
          <polygon points={area} fill="url(#equity-fill)" />
          <polyline points={line} fill="none" className={metrics.netPnl >= 0 ? 'equity-line-positive' : 'equity-line-negative'} />
          <circle cx={chartX(points.length - 1, points.length, left, right)} cy={y(points[points.length - 1].equity)} r="3.5" className="equity-end-point" />
          <text x={left} y={height - 8} className="performance-axis-label">{dateTime(points[0].time).slice(0, 10)}</text>
          <text x={right} y={height - 8} textAnchor="end" className="performance-axis-label">{dateTime(points[points.length - 1].time).slice(0, 10)} UTC</text>
        </svg>
      ) : (
        <div className="performance-chart-empty">Equity curve will appear after the first closed trade.</div>
      )}
    </div>
  )
}

function DrawdownChart({ metrics }: { metrics: AccountPerformanceMetrics }) {
  const points = metrics.equityCurve
  const width = 820
  const height = 170
  const left = 74
  const right = width - 16
  const top = 14
  const bottom = height - 30
  const maxDrawdown = Math.max(metrics.maxDrawdownPercent, 1)
  const y = (percent: number) => top + (percent / maxDrawdown) * (bottom - top)
  const line = points.map((point, index) => `${chartX(index, points.length, left, right)},${y(point.drawdownPercent)}`).join(' ')
  const area = `${left},${top} ${line} ${right},${top}`

  return (
    <div className="performance-chart-card performance-drawdown-card">
      <div className="performance-chart-heading">
        <div><strong>Drawdown</strong><small>Peak-to-trough realized equity decline</small></div>
        <b className="pnl-neg">{money(metrics.maxDrawdown)} · {metrics.maxDrawdownPercent.toFixed(2)}%</b>
      </div>
      {metrics.tradeCount ? (
        <svg className="performance-chart performance-drawdown-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Realized account drawdown chart">
          {[0, 0.5, 1].map((fraction) => {
            const gy = top + fraction * (bottom - top)
            return (
              <g key={fraction}>
                <line x1={left} x2={right} y1={gy} y2={gy} className="performance-grid-line" />
                <text x={left - 8} y={gy + 4} textAnchor="end" className="performance-axis-label">{(maxDrawdown * fraction).toFixed(1)}%</text>
              </g>
            )
          })}
          <polygon points={area} className="drawdown-area" />
          <polyline points={line} fill="none" className="drawdown-line" />
          <text x={left} y={height - 7} className="performance-axis-label">{dateTime(points[0].time).slice(0, 10)}</text>
          <text x={right} y={height - 7} textAnchor="end" className="performance-axis-label">{dateTime(points[points.length - 1].time).slice(0, 10)} UTC</text>
        </svg>
      ) : (
        <div className="performance-chart-empty">No realized drawdown yet.</div>
      )}
    </div>
  )
}

type TradeFilter = 'all' | 'buy' | 'sell' | 'wins' | 'losses'

const FILTER_LABELS: Record<TradeFilter, string> = {
  all: 'All',
  buy: 'BUY',
  sell: 'SELL',
  wins: 'Winners',
  losses: 'Losers',
}

function matchesTradeFilter(trade: ClosedTrade, filter: TradeFilter) {
  const side = String(trade.side).toLowerCase()
  if (filter === 'buy' || filter === 'sell') return side === filter
  if (filter === 'wins') return trade.pnl > 0
  if (filter === 'losses') return trade.pnl < 0
  return true
}

export default function AccountPerformance({ account }: Props) {
  const metrics = useMemo(() => calculateAccountPerformance(account), [account])
  const [tradeFilter, setTradeFilter] = useState<TradeFilter>('all')
  const filterCounts: Record<TradeFilter, number> = {
    all: metrics.tradeCount,
    buy: metrics.trades.filter((trade) => String(trade.side).toLowerCase() === 'buy').length,
    sell: metrics.trades.filter((trade) => String(trade.side).toLowerCase() === 'sell').length,
    wins: metrics.wins,
    losses: metrics.losses,
  }
  const filteredTrades = metrics.trades.slice().reverse().filter((trade) => matchesTradeFilter(trade, tradeFilter))
  const visibleTrades = filteredTrades.slice(0, 100)
  const netTone = metrics.netPnl > 0 ? 'positive' : metrics.netPnl < 0 ? 'negative' : 'neutral'
  const factor = metrics.profitFactor == null ? '—' : Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞'

  return (
    <section className="account-performance">
      <div className="account-performance-header">
        <div>
          <span className="performance-eyebrow">ACCOUNT PERFORMANCE</span>
          <h2>{account.name}</h2>
          <p>Closed-trade statistics · times shown in UTC</p>
        </div>
        <div className="performance-account-balance">
          <small>Current balance</small>
          <strong>{money(account.balance)}</strong>
        </div>
      </div>

      <div className="performance-metrics-grid">
        <Metric label="Net realized P/L" value={signedMoney(metrics.netPnl)} detail={`${metrics.tradeCount} closed · ${metrics.returnPercent == null ? '—' : `${metrics.returnPercent >= 0 ? '+' : ''}${metrics.returnPercent.toFixed(2)}%`} return`} tone={netTone} />
        <Metric label="Win rate" value={metrics.winRate == null ? '—' : `${metrics.winRate.toFixed(1)}%`} detail={`${metrics.wins} wins · ${metrics.losses} losses · ${metrics.breakeven} flat`} />
        <Metric label="Max drawdown" value={metrics.tradeCount ? `${money(metrics.maxDrawdown)} · ${metrics.maxDrawdownPercent.toFixed(2)}%` : '—'} detail="Realized peak to trough" tone="negative" />
        <Metric label="Profit factor" value={factor} detail={`${money(metrics.grossProfit)} gross profit / ${money(metrics.grossLoss)} gross loss`} />
        <Metric label="Average win" value={metrics.averageWin == null ? '—' : money(metrics.averageWin)} detail={metrics.bestTrade ? `Best ${signedMoney(metrics.bestTrade.pnl)}` : undefined} tone="positive" />
        <Metric label="Average loss" value={metrics.averageLoss == null ? '—' : signedMoney(metrics.averageLoss)} detail={metrics.worstTrade ? `Worst ${signedMoney(metrics.worstTrade.pnl)}` : undefined} tone="negative" />
        <Metric label="Expectancy / trade" value={metrics.expectancy == null ? '—' : signedMoney(metrics.expectancy)} detail="Average realized P/L per close" tone={metrics.expectancy == null ? 'neutral' : metrics.expectancy >= 0 ? 'positive' : 'negative'} />
        <Metric label="Open positions" value={String(account.positions.length)} detail={`${account.pendingOrders.length} pending orders`} />
      </div>

      <div className="performance-charts-grid">
        <EquityChart metrics={metrics} />
        <DrawdownChart metrics={metrics} />
      </div>

      <div className="dashboard-trades-section">
        <div className="dashboard-trades-header">
          <div>
            <h3>Closed trades</h3>
            <small>{filteredTrades.length} matching · {metrics.tradeCount} total · {visibleTrades.length} shown</small>
          </div>
          <div className="dashboard-trade-filters" aria-label="Filter closed trades">
            {(['all', 'buy', 'sell', 'wins', 'losses'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                className={tradeFilter === filter ? 'dashboard-trade-filter-active' : ''}
                aria-pressed={tradeFilter === filter}
                onClick={() => setTradeFilter(filter)}
              >
                {FILTER_LABELS[filter]} <span>{filterCounts[filter]}</span>
              </button>
            ))}
          </div>
        </div>
        {visibleTrades.length ? (
          <div className="dashboard-trades-scroll">
            <table className="dashboard-trades-table">
              <thead>
                <tr>
                  <th>Closed (UTC)</th><th>Symbol</th><th>Side</th><th>Lot</th><th>Entry</th><th>Exit</th><th>Duration</th><th>Reason</th><th>Net P/L</th>
                </tr>
              </thead>
              <tbody>
                {visibleTrades.map((trade) => (
                  <tr key={`${trade.id}-${trade.closeTime}`}>
                    <td className="trade-time-cell">{dateTime(trade.closeTime)}</td>
                    <td>{trade.symbol}</td>
                    <td className={String(trade.side).toLowerCase() === 'buy' ? 'side-buy' : 'side-sell'}>{String(trade.side).toUpperCase()}</td>
                    <td>{trade.lot.toFixed(2)}</td>
                    <td>{formatPrice(trade.openPrice, trade.symbol)}</td>
                    <td>{formatPrice(trade.closePrice, trade.symbol)}</td>
                    <td>{duration(trade.openTime, trade.closeTime)}</td>
                    <td>{REASONS[trade.reason]}</td>
                    <td className={trade.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>{signedMoney(trade.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dashboard-trades-empty">{metrics.tradeCount ? 'No closed trades match this filter.' : 'Closed trades will appear here as you trade this account.'}</div>
        )}
        {filteredTrades.length > visibleTrades.length && (
          <div className="dashboard-trades-footnote">Showing the latest 100 matching trades for fast loading.</div>
        )}
      </div>
    </section>
  )
}

import { useState } from 'react'
import type { ClosedTrade, PendingOrder, Position } from '../types'
import { positionPnl, type PriceQuote } from '../hooks/useTradingAccount'
import { formatPrice, type SymbolId } from '../symbols'
import { formatUtcShort } from '../utils/time'

type Props = {
  positions: Position[]
  pendingOrders: PendingOrder[]
  history: ClosedTrade[]
  priceBySymbol: Partial<Record<SymbolId, PriceQuote>>
  onClose: (id: number) => void
  onCancelPending: (id: number) => void
}

type Tab = 'positions' | 'pending' | 'history'

const fmtTime = formatUtcShort

const REASON_LABEL: Record<ClosedTrade['reason'], string> = {
  manual: 'Manual Close',
  sl: 'SL',
  tp: 'TP',
  stopout: 'Stop out',
}

export default function PositionsPanel({
  positions,
  pendingOrders,
  history,
  priceBySymbol,
  onClose,
  onCancelPending,
}: Props) {
  const [tab, setTab] = useState<Tab>('positions')

  return (
    <div className="panel positions-panel">
      <div className="pos-tabs">
        <button className={`pos-tab ${tab === 'positions' ? 'pos-tab-active' : ''}`} onClick={() => setTab('positions')}>
          Open Positions ({positions.length})
        </button>
        <button className={`pos-tab ${tab === 'pending' ? 'pos-tab-active' : ''}`} onClick={() => setTab('pending')}>
          Pending Orders ({pendingOrders.length})
        </button>
        <button className={`pos-tab ${tab === 'history' ? 'pos-tab-active' : ''}`} onClick={() => setTab('history')}>
          History
        </button>
      </div>

      {tab === 'positions' && (
        <div className="table-wrap-full">
          <table className="pos-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Type</th>
                <th>Lot</th>
                <th>Open Price</th>
                <th>SL/TP</th>
                <th>Time</th>
                <th>P/L</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const quote = priceBySymbol[p.symbol] ?? { bid: 0, ask: 0 }
                const pnl = positionPnl(p, quote)
                return (
                  <tr key={p.id}>
                    <td>{p.symbol}</td>
                    <td className={p.side === 'buy' ? 'side-buy' : 'side-sell'}>
                      {p.side === 'buy' ? 'BUY' : 'SELL'}
                    </td>
                    <td>{p.lot.toFixed(2)}</td>
                    <td>{formatPrice(p.openPrice, p.symbol)}</td>
                    <td className="small">
                      {p.sl ? formatPrice(p.sl, p.symbol) : '—'} / {p.tp ? formatPrice(p.tp, p.symbol) : '—'}
                    </td>
                    <td className="small">{fmtTime(p.openTime)}</td>
                    <td className={pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                      {pnl >= 0 ? '+' : ''}
                      {pnl.toFixed(2)}
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-tiny" onClick={() => onClose(p.id)}>
                        Close
                      </button>
                    </td>
                  </tr>
                )
              })}
              {!positions.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    No open positions
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'pending' && (
        <div className="table-wrap-full">
          <table className="pos-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Type</th>
                <th>Lot</th>
                <th>Order Price</th>
                <th>SL/TP</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pendingOrders.map((o) => (
                <tr key={o.id}>
                  <td>{o.symbol}</td>
                  <td className={o.side === 'buy' ? 'side-buy' : 'side-sell'}>
                    {o.side === 'buy' ? 'BUY' : 'SELL'} {o.kind.toUpperCase()}
                  </td>
                  <td>{o.lot.toFixed(2)}</td>
                  <td>{formatPrice(o.triggerPrice, o.symbol)}</td>
                  <td className="small">
                    {o.sl ? formatPrice(o.sl, o.symbol) : '—'} / {o.tp ? formatPrice(o.tp, o.symbol) : '—'}
                  </td>
                  <td className="small">{fmtTime(o.createdTime)}</td>
                  <td>
                    <button className="btn btn-secondary btn-tiny" onClick={() => onCancelPending(o.id)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
              {!pendingOrders.length && (
                <tr>
                  <td colSpan={7} className="empty">
                    No pending orders
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'history' && (
        <div className="table-wrap-full">
          <table className="pos-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Type</th>
                <th>Lot</th>
                <th>Open</th>
                <th>Close</th>
                <th>Reason</th>
                <th>P/L</th>
              </tr>
            </thead>
            <tbody>
              {history.map((t) => (
                <tr key={t.id}>
                  <td>{t.symbol}</td>
                  <td className={t.side === 'buy' ? 'side-buy' : 'side-sell'}>
                    {t.side === 'buy' ? 'BUY' : 'SELL'}
                  </td>
                  <td>{t.lot.toFixed(2)}</td>
                  <td>{formatPrice(t.openPrice, t.symbol)}</td>
                  <td>{formatPrice(t.closePrice, t.symbol)}</td>
                  <td className="small">{REASON_LABEL[t.reason]}</td>
                  <td className={t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                    {t.pnl >= 0 ? '+' : ''}
                    {t.pnl.toFixed(2)}
                  </td>
                </tr>
              ))}
              {!history.length && (
                <tr>
                  <td colSpan={7} className="empty">
                    No trade history
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

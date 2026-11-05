import { useState } from 'react'
import type { DraftOrder, DraftOrderKind, OrderKind, Side } from '../types'
import { calculateRiskLot, marginForLot, type Leverage } from '../hooks/useTradingAccount'
import { SYMBOL_MAP, formatPrice, type SymbolId } from '../symbols'

type Props = {
  symbol: SymbolId
  bid: number
  ask: number
  balance: number
  riskSizingEnabled: boolean
  riskPercent: number
  onRiskSizingChange: (enabled: boolean) => void
  onRiskPercentChange: (percent: number) => void
  leverage: Leverage
  freeMargin: number
  draft: DraftOrder
  onStartDraft: (side: Side, kind: DraftOrderKind, lot: number, entry?: number, stop?: number | null, takeProfit?: number | null) => void
  onConfirmDraft: () => void
  onCancelDraft: () => void
}

const LOT_STEP = 0.01
const LOT_PRESETS = [0.01, 0.1, 1]

const ORDER_TYPES: { value: 'market' | OrderKind; label: string }[] = [
  { value: 'market', label: 'Market' },
  { value: 'stop', label: 'Stop' },
  { value: 'limit', label: 'Limit' },
]

export default function OrderTicket({
  symbol,
  bid,
  ask,
  balance,
  riskSizingEnabled,
  riskPercent,
  onRiskSizingChange,
  onRiskPercentChange,
  leverage,
  freeMargin,
  draft,
  onStartDraft,
  onConfirmDraft,
  onCancelDraft,
}: Props) {
  const [lot, setLot] = useState(0.1)
  const [orderType, setOrderType] = useState<'market' | OrderKind>('market')
  const [useSlTp, setUseSlTp] = useState(true)
  const [sl, setSl] = useState('')
  const [tp, setTp] = useState('')

  const clampLot = (value: number) => Math.max(0.01, Math.min(50, Math.round(value * 100) / 100))
  const parseOptionalPrice = (value: string) => {
    if (!value.trim()) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  const parsedSl = useSlTp ? parseOptionalPrice(sl) : null
  const parsedTp = useSlTp ? parseOptionalPrice(tp) : null
  const canTrade = bid > 0 && ask > 0
  const buyRiskLot = riskSizingEnabled && parsedSl != null
    ? calculateRiskLot(symbol, 'buy', ask, parsedSl, balance, riskPercent)
    : null
  const sellRiskLot = riskSizingEnabled && parsedSl != null
    ? calculateRiskLot(symbol, 'sell', bid, parsedSl, balance, riskPercent)
    : null
  const chosenLot = (side: Side) => riskSizingEnabled
    ? (side === 'buy' ? buyRiskLot : sellRiskLot)
    : lot
  const estMargin = marginForLot(symbol, chosenLot('buy') ?? lot, ask || bid || 0, leverage)
  const riskBudget = balance * riskPercent / 100

  const submit = (side: Side) => {
    if (!canTrade) return
    onStartDraft(side, orderType, lot, undefined, orderType === 'market' ? parsedSl : null, orderType === 'market' ? parsedTp : null)
  }

  const draftRiskLot = draft && riskSizingEnabled && draft.sl != null
    ? calculateRiskLot(symbol, draft.side, draft.price, draft.sl, balance, riskPercent)
    : null
  const canConfirmDraft = !!draft && (!riskSizingEnabled || draftRiskLot != null)

  return (
    <div className="panel order-panel">
      <div className="panel-title">Order Ticket</div>

      <div className="order-type-row">
        {ORDER_TYPES.map((type) => (
          <button
            key={type.value}
            className={`chip ${orderType === type.value ? 'chip-active' : ''}`}
            disabled={!!draft}
            onClick={() => setOrderType(type.value)}
          >
            {type.label}
          </button>
        ))}
      </div>

      <label className="risk-sizing-toggle">
        <input type="checkbox" checked={riskSizingEnabled} onChange={(e) => onRiskSizingChange(e.target.checked)} />
        <span>Risk-based position size</span>
      </label>
      {riskSizingEnabled && (
        <div className="risk-sizing-settings">
          <label>
            Risk (% of balance)
            <input
              type="number"
              min="0.01"
              max="100"
              step="0.1"
              value={riskPercent}
              onChange={(e) => onRiskPercentChange(Math.max(0.01, Math.min(100, Number(e.target.value) || 0.01)))}
            />
          </label>
          <span className="risk-budget">Risk budget: ${riskBudget.toFixed(2)}</span>
        </div>
      )}

      <div className="lot-row">
        <span>{riskSizingEnabled ? 'Manual lot (pending draft)' : 'Volume (lot)'}</span>
        <div className="lot-stepper">
          <button className="btn btn-secondary btn-tiny" disabled={riskSizingEnabled && orderType === 'market'} onClick={() => setLot((value) => clampLot(value - LOT_STEP))}>−</button>
          <input
            className="lot-input"
            type="number"
            min={0.01}
            max={50}
            step={0.01}
            value={lot}
            disabled={riskSizingEnabled && orderType === 'market'}
            onChange={(e) => setLot(clampLot(Number(e.target.value) || 0.01))}
          />
          <button className="btn btn-secondary btn-tiny" disabled={riskSizingEnabled && orderType === 'market'} onClick={() => setLot((value) => clampLot(value + LOT_STEP))}>+</button>
        </div>
      </div>
      {!riskSizingEnabled && (
        <div className="lot-presets">
          {LOT_PRESETS.map((preset) => (
            <button key={preset} className="chip" onClick={() => setLot(preset)}>{preset}</button>
          ))}
          <span className="hint">{SYMBOL_MAP[symbol].lotHint}</span>
        </div>
      )}

      {orderType === 'market' && !draft && (
        <>
          <label className="sltp-toggle">
            <input type="checkbox" checked={useSlTp} onChange={(e) => setUseSlTp(e.target.checked)} />
            Set Stop Loss / Take Profit
          </label>
          {useSlTp && (
            <div className="sltp-row">
              <input className="sltp-input" type="number" placeholder="Stop Loss price" value={sl} onChange={(e) => setSl(e.target.value)} />
              <input className="sltp-input" type="number" placeholder="Take Profit (optional)" value={tp} onChange={(e) => setTp(e.target.value)} />
            </div>
          )}
          {riskSizingEnabled && (
            <div className={`risk-size-preview ${parsedSl != null && (!buyRiskLot || !sellRiskLot) ? 'risk-size-invalid' : ''}`}>
              {parsedSl == null
                ? 'Enter a stop-loss price to calculate lot size.'
                : `Auto lot — Buy: ${buyRiskLot?.toFixed(2) ?? 'below min'} | Sell: ${sellRiskLot?.toFixed(2) ?? 'below min'}`}
            </div>
          )}
        </>
      )}

      <div className="margin-est">
        Required Margin: ${estMargin.toFixed(2)}{' '}
        {estMargin > freeMargin && <span className="pnl-neg"> — exceeds free margin</span>}
      </div>

      {draft ? (
        <>
          <div className="draft-info">
            <div className="draft-info-row"><span>Order</span><b>{draft.side === 'buy' ? 'BUY' : 'SELL'} {draft.kind.toUpperCase()}</b></div>
            <div className="draft-info-row"><span>Entry Price</span><b>{formatPrice(draft.price, symbol)}</b></div>
            <div className="draft-info-row"><span>Stop Loss</span><b>{draft.sl != null ? formatPrice(draft.sl, symbol) : '—'}</b></div>
            <div className="draft-info-row"><span>Position Size</span><b>{riskSizingEnabled ? (draftRiskLot != null ? `${draftRiskLot.toFixed(2)} lot` : 'Set a valid SL') : `${draft.lot.toFixed(2)} lot`}</b></div>
            <div className="draft-info-row"><span>Take Profit</span><b>{draft.tp != null ? formatPrice(draft.tp, symbol) : '—'}</b></div>
            <div className="hint">Drag the chart SL line to set risk-based volume.</div>
          </div>
          <div className="order-buttons">
            <button className="btn btn-secondary" onClick={onCancelDraft}>Cancel</button>
            <button className="btn btn-buy" disabled={!canConfirmDraft} onClick={onConfirmDraft}>Confirm Order</button>
          </div>
        </>
      ) : (
        <div className="order-buttons">
          <button
            className="btn btn-sell"
            disabled={!canTrade}
            onClick={() => submit('sell')}
          >
            {orderType === 'market' ? 'SELL' : `${orderType.toUpperCase()} SELL`}
            {orderType === 'market' && <span className="order-price">{formatPrice(bid, symbol)}</span>}
          </button>
          <button
            className="btn btn-buy"
            disabled={!canTrade}
            onClick={() => submit('buy')}
          >
            {orderType === 'market' ? 'BUY' : `${orderType.toUpperCase()} BUY`}
            {orderType === 'market' && <span className="order-price">{formatPrice(ask, symbol)}</span>}
          </button>
        </div>
      )}
    </div>
  )
}

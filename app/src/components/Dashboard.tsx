import { useState } from 'react'
import type { AccountProfile } from '../types'
import type { Leverage } from '../hooks/useTradingAccount'
import { msToUtcInputValue, utcInputValueToMs } from '../utils/time'
import { SYMBOLS, type SymbolId } from '../symbols'
import AccountPerformance from './AccountPerformance'
import { calculateAccountPerformance } from '../utils/accountPerformance'

type Props = {
  accounts: AccountProfile[]
  activeAccId: string
  onSelectAccount: (id: string) => void
  onCreateAccount: (name: string, initialBalance?: number, leverage?: Leverage) => void
  onDeleteAccount: (id: string) => void
  symbol: SymbolId
  onSymbolChange: (symbol: SymbolId) => void
  range: [number, number] | null
  startTime: number | null
  dateLocked: boolean
  initialStartTime: number | null
  onStartTimeChange: (time: number) => void
  dataReady: boolean
  dataError: boolean
  starting: boolean
  tickDataStatus: string
  onStart: () => void
}

function money(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Dashboard({
  accounts,
  activeAccId,
  onSelectAccount,
  onCreateAccount,
  onDeleteAccount,
  symbol,
  onSymbolChange,
  range,
  startTime,
  dateLocked,
  initialStartTime,
  onStartTimeChange,
  dataReady,
  dataError,
  starting,
  tickDataStatus,
  onStart,
}: Props) {
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newBalance, setNewBalance] = useState('10000')
  const [newLeverage, setNewLeverage] = useState<Leverage>(500)

  const active = accounts.find((a) => a.id === activeAccId) ?? accounts[0]

  const handleCreate = () => {
    const balance = Number(newBalance)
    onCreateAccount(
      newName.trim() || `Account ${accounts.length + 1}`,
      Number.isFinite(balance) && balance > 0 ? balance : 10000,
      newLeverage,
    )
    setNewName('')
    setNewBalance('10000')
    setNewLeverage(500)
    setShowNew(false)
  }

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        <header className="dashboard-header">
          <div className="dashboard-logo">FX</div>
          <div>
            <h1>Backtest Dashboard</h1>
            <p>Choose the demo account you want to trade with, then start the simulator.</p>
          </div>
        </header>

        <section className="dashboard-backtest-settings">
          <div className="dashboard-settings-title">Backtest setup</div>
          <label className="dashboard-setting">
            <span>Instrument</span>
            <select value={symbol} disabled={starting} onChange={(e) => onSymbolChange(e.target.value as SymbolId)}>
              {SYMBOLS.map((item) => (
                <option key={item.id} value={item.id}>{item.id}</option>
              ))}
            </select>
          </label>
          <label className="dashboard-setting">
            <span>{dateLocked ? 'Resume after last trade' : 'Start date and time'} <small>UTC</small></span>
            <input
              type="datetime-local"
              value={startTime != null ? msToUtcInputValue(startTime) : ''}
              min={range ? msToUtcInputValue(range[0]) : undefined}
              max={range ? msToUtcInputValue(range[1]) : undefined}
              disabled={starting || !dataReady || !range || dateLocked}
              onChange={(e) => {
                const value = utcInputValueToMs(e.target.value)
                if (Number.isFinite(value)) onStartTimeChange(value)
              }}
            />
          </label>
          {dateLocked && initialStartTime != null && (
            <div className="dashboard-data-status">
              Initial start: {new Date(initialStartTime).toISOString().replace('T', ' ').slice(0, 16)} UTC · Resume uses the later of the last trade and saved progress.
            </div>
          )}
          <div className={`dashboard-data-status ${dataError ? 'dashboard-data-error' : ''}`}>
            {dataError
              ? `Could not load ${symbol} historical data.`
              : dataReady && range
                ? `Loaded data: ${new Date(range[0]).toISOString().slice(0, 10)} — ${new Date(range[1]).toISOString().slice(0, 10)} UTC`
                : `Loading ${symbol} historical data…`}
          </div>
          {tickDataStatus && <div className="dashboard-data-status">{tickDataStatus}</div>}
        </section>

        <div className="dashboard-section-head">
          <span>Accounts</span>
          <button className="btn btn-secondary btn-small" disabled={starting} onClick={() => setShowNew((v) => !v)}>
            {showNew ? 'Cancel' : '+ New account'}
          </button>
        </div>

        {showNew && (
          <div className="dashboard-new-account">
            <input
              className="custom-balance-input"
              placeholder="Account name (e.g. News Scalper)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className="custom-balance-input"
              type="number"
              min={1}
              placeholder="Starting balance"
              value={newBalance}
              onChange={(e) => setNewBalance(e.target.value)}
            />
            <select
              className="speed-select"
              value={newLeverage}
              onChange={(e) => setNewLeverage(Number(e.target.value) as Leverage)}
            >
              <option value={500}>Leverage 1:500</option>
              <option value={1000}>Leverage 1:1000</option>
            </select>
            <button className="btn btn-buy btn-small" onClick={handleCreate}>
              Create account
            </button>
          </div>
        )}

        <div className="dashboard-accounts">
          {accounts.map((acc) => {
            const isActive = acc.id === activeAccId
            const performance = calculateAccountPerformance(acc)
            const pnl = performance.netPnl
            return (
              <button
                key={acc.id}
                className={`dashboard-account-card ${isActive ? 'dashboard-account-card-active' : ''}`}
                disabled={starting}
                onClick={() => onSelectAccount(acc.id)}
              >
                <div className="dashboard-account-top">
                  <span className="dashboard-account-name">{acc.name}</span>
                  {isActive && <span className="dashboard-active-badge">SELECTED</span>}
                </div>
                <div className="dashboard-account-balance">${money(acc.balance)}</div>
                <div className={`dashboard-account-pnl ${pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                  {pnl > 0 ? '+' : pnl < 0 ? '−' : ''}${money(Math.abs(pnl))} realized
                </div>
                <div className="dashboard-account-meta">
                  <span>Return <b>{performance.returnPercent == null ? '—' : `${performance.returnPercent >= 0 ? '+' : ''}${performance.returnPercent.toFixed(1)}%`}</b></span>
                  <span>Win rate <b>{performance.winRate == null ? '—' : `${performance.winRate.toFixed(1)}%`}</b></span>
                  <span>Max DD <b>{performance.tradeCount ? `${performance.maxDrawdownPercent.toFixed(1)}%` : '—'}</b></span>
                  <span>{acc.positions.length} open</span>
                  <span>{performance.tradeCount} closed</span>
                </div>
                {accounts.length > 1 && (
                  <span
                    className="dashboard-account-delete"
                    title="Delete account"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm(`Delete "${acc.name}" and its trade history?`)) onDeleteAccount(acc.id)
                    }}
                  >
                    ✕
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {active && <AccountPerformance key={active.id} account={active} />}

        <footer className="dashboard-footer">
          <div className="dashboard-summary">
            Starting with <b>{active?.name ?? 'Account'}</b>
            <span className="dashboard-summary-sub">
              ${money(active?.balance ?? 0)}
            </span>
          </div>
          <button
            className="btn btn-play dashboard-start"
            onClick={onStart}
            disabled={starting || !dataReady || startTime == null || !range || startTime < range[0] || startTime >= range[1]}
          >
            {starting ? 'Loading ticks & chart history…' : 'Start Backtest →'}
          </button>
        </footer>
      </div>
    </div>
  )
}

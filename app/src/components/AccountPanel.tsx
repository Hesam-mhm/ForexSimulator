import { useState } from 'react'
import type { Leverage } from '../hooks/useTradingAccount'
import type { AccountProfile } from '../types'

type Props = {
  accounts: AccountProfile[]
  activeAccId: string
  onSwitchAccount: (id: string) => void
  onCreateAccount: (name: string, initialBalance?: number, leverage?: Leverage) => void
  onDeleteAccount: (id: string) => void
  balance: number
  equity: number
  usedMargin: number
  freeMargin: number
  marginLevel: number | null
  floatingPnl: number
  onReset: (balance: number) => void
}

function money(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function AccountPanel({
  accounts,
  activeAccId,
  onSwitchAccount,
  onCreateAccount,
  onDeleteAccount,
  balance,
  equity,
  usedMargin,
  freeMargin,
  marginLevel,
  floatingPnl,
  onReset,
}: Props) {
  const [customBalance, setCustomBalance] = useState('')
  const [showNewModal, setShowNewModal] = useState(false)
  const [newAccName, setNewAccName] = useState('')
  const [newAccBal, setNewAccBal] = useState('10000')
  const [newAccLeverage, setNewAccLeverage] = useState<Leverage>(500)

  const applyCustomBalance = () => {
    const n = Number(customBalance)
    if (Number.isFinite(n) && n > 0) {
      onReset(n)
      setCustomBalance('')
    }
  }

  const handleCreate = () => {
    const bal = Number(newAccBal) || 10000
    onCreateAccount(newAccName || `Account ${accounts.length + 1}`, bal, newAccLeverage)
    setNewAccName('')
    setNewAccBal('10000')
    setNewAccLeverage(500)
    setShowNewModal(false)
  }

  return (
    <div className="panel account-panel">
      <div className="panel-title account-header">
        <span>Trading Account</span>
        <button
          className="btn btn-secondary btn-tiny"
          onClick={() => setShowNewModal(!showNewModal)}
          title="Create New Account"
        >
          + New
        </button>
      </div>

      <div className="account-selector-row">
        <select
          className="account-select"
          value={activeAccId}
          onChange={(e) => onSwitchAccount(e.target.value)}
        >
          {accounts.map((acc) => (
            <option key={acc.id} value={acc.id}>
              {acc.name} (${money(acc.balance)})
            </option>
          ))}
        </select>
        {accounts.length > 1 && (
          <button
            className="btn btn-secondary btn-tiny btn-del-acc"
            onClick={() => {
              if (confirm('Delete this account and its trade history?')) {
                onDeleteAccount(activeAccId)
              }
            }}
            title="Delete this account"
          >
            ✕
          </button>
        )}
      </div>

      {showNewModal && (
        <div className="new-account-box">
          <input
            className="custom-balance-input"
            type="text"
            placeholder="Account Name (e.g. Scalp $1k)"
            value={newAccName}
            onChange={(e) => setNewAccName(e.target.value)}
          />
          <div className="new-account-actions">
            <input
              className="custom-balance-input"
              type="number"
              placeholder="Balance"
              value={newAccBal}
              onChange={(e) => setNewAccBal(e.target.value)}
            />
            <select
              className="account-leverage-select"
              value={newAccLeverage}
              onChange={(e) => setNewAccLeverage(Number(e.target.value) as Leverage)}
              aria-label="Account leverage"
            >
              <option value={500}>1:500</option>
              <option value={1000}>1:1000</option>
            </select>
            <button className="btn btn-buy btn-small" onClick={handleCreate}>
              Create
            </button>
          </div>
        </div>
      )}

      <div className="account-row">
        <span>Balance</span>
        <b>${money(balance)}</b>
      </div>
      <div className="account-row">
        <span>Equity</span>
        <b>${money(equity)}</b>
      </div>
      <div className="account-row">
        <span>Floating P/L</span>
        <b className={floatingPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>
          {floatingPnl >= 0 ? '+' : ''}
          {money(floatingPnl)}
        </b>
      </div>
      <div className="account-row">
        <span>Used Margin</span>
        <b>${money(usedMargin)}</b>
      </div>
      <div className="account-row">
        <span>Free Margin</span>
        <b>${money(freeMargin)}</b>
      </div>
      <div className="account-row">
        <span>Margin Level</span>
        <b>{marginLevel != null ? `${marginLevel.toFixed(0)}%` : '—'}</b>
      </div>


      <div className="reset-row">
        <button className="btn btn-secondary btn-small" onClick={() => onReset(30)}>
          Reset $30
        </button>
        <button className="btn btn-secondary btn-small" onClick={() => onReset(10000)}>
          Reset $10,000
        </button>
        <button className="btn btn-secondary btn-small" onClick={() => onReset(100000)}>
          Reset $100,000
        </button>
      </div>

      <div className="custom-balance-row">
        <input
          className="custom-balance-input"
          type="number"
          min={1}
          placeholder="Custom balance..."
          value={customBalance}
          onChange={(e) => setCustomBalance(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyCustomBalance()}
        />
        <button className="btn btn-secondary btn-small" onClick={applyCustomBalance}>
          Set
        </button>
      </div>
    </div>
  )
}

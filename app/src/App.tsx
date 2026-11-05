import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PriceEngine } from './engine/priceEngine'
import { loadSymbolBars, loadTickTape } from './data'
import type { AccountProfile, DraftOrder, DraftOrderKind, Side, Speed } from './types'
import { DRAFT_ORDER_ID } from './types'
import { calculateRiskLot, useTradingAccount } from './hooks/useTradingAccount'
import { SYMBOL_MAP, type SymbolId } from './symbols'
import TopBar from './components/TopBar'
import PriceChart from './components/PriceChart'
import AccountPanel from './components/AccountPanel'
import OrderTicket from './components/OrderTicket'
import PositionsPanel from './components/PositionsPanel'
import Dashboard from './components/Dashboard'

function accountResumeTime(account: AccountProfile): number | undefined {
  const tradeTimes = [
    ...account.positions.map((position) => position.openTime),
    ...account.history.map((trade) => Math.max(trade.openTime, trade.closeTime)),
  ].filter(Number.isFinite)
  const lastTradeTime = tradeTimes.length ? Math.max(...tradeTimes) + 1 : undefined
  const savedTime = account.lastSimTime ?? account.backtestStartTime
  if (lastTradeTime == null) return savedTime
  return Math.max(savedTime ?? lastTradeTime, lastTradeTime)
}

export default function App() {
  const engine = useMemo(() => new PriceEngine(), [])
  const [symbol, setSymbol] = useState<SymbolId>('XAUUSD')
  const [started, setStarted] = useState(false)
  const [ready, setReady] = useState(false)
  const [noData, setNoData] = useState(false)
  const [starting, setStarting] = useState(false)
  const [tickDataStatus, setTickDataStatus] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(300)
  const [range, setRange] = useState<[number, number] | null>(null)
  const [selectedStartTime, setSelectedStartTime] = useState<number | null>(null)
  const defaultStartTimeRef = useRef<number | null>(null)
  const [draft, setDraft] = useState<DraftOrder>(null)
  const [quickLot, setQuickLot] = useState(0.1)
  const [riskSizingEnabled, setRiskSizingEnabled] = useState(true)
  const [riskPercent, setRiskPercent] = useState(1)
  const [quickStopDistance, setQuickStopDistance] = useState(5)
  const [bottomPanelCollapsed, setBottomPanelCollapsed] = useState(() => {
    try { return localStorage.getItem('fps_bottom_panel_collapsed') === 'true' } catch { return false }
  })
  const [terminalTab, setTerminalTab] = useState<'positions' | 'account'>('positions')

  useEffect(() => {
    try {
      localStorage.setItem('fps_bottom_panel_collapsed', String(bottomPanelCollapsed))
    } catch {
      // Panel preferences are optional when browser storage is unavailable.
    }
  }, [bottomPanelCollapsed])

  const account = useTradingAccount(engine, symbol)
  const accountPriceRef = useRef(account.price)
  accountPriceRef.current = account.price

  useEffect(() => {
    let cancelled = false
    setReady(false)
    setNoData(false)
    setDraft(null)
    engine.pause()
    engine.setRealTickTape(null)
    engine.setSpread(SYMBOL_MAP[symbol].defaultSpread)
    loadSymbolBars(symbol).then(({ bars, intervalMs }) => {
      if (cancelled) return
      engine.setBars(bars, intervalMs)
      setRange(engine.getRange())
      setReady(true)
      if (bars.length) {
        // Keep a similar amount of initial context regardless of the source interval.
        const defaultContextBars = intervalMs === 60_000 ? 3_000 : 200
        const startIdx = Math.min(defaultContextBars, bars.length - 1)
        const defaultStart = bars[startIdx]?.time ?? bars[0].time
        defaultStartTimeRef.current = defaultStart
        setSelectedStartTime(defaultStart)
        engine.jumpTo(defaultStart)
      } else {
        setNoData(true)
      }
    }).catch((error: unknown) => {
      if (cancelled) return
      console.error(`Failed to load ${symbol} historical data`, error)
      setNoData(true)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [engine, symbol])

  useEffect(() => {
    let disposed = false
    const requestedDays = new Map<string, 'loading' | 'loaded' | 'missing'>()
    const ensureTape = (dayStartMs: number) => {
      if (engine.hasRealTickTape(dayStartMs)) return
      const day = new Date(dayStartMs).toISOString().slice(0, 10)
      const status = requestedDays.get(day)
      if (status === 'loading' || status === 'missing') return
      requestedDays.set(day, 'loading')
      loadTickTape(symbol, day)
        .then((tape) => {
          if (disposed) return
          if (tape) {
            engine.addRealTickTape(tape)
            requestedDays.set(day, 'loaded')
          } else {
            requestedDays.set(day, 'missing')
          }
        })
        .catch((error) => {
          if (disposed) return
          requestedDays.set(day, 'missing')
          console.error(`Failed to preload ${symbol} tick tape for ${day}`, error)
        })
    }

    const offTick = engine.onTick(({ simTime }) => {
      const dayStart = Math.floor(simTime / 86_400_000) * 86_400_000
      ensureTape(dayStart)
      let nextTradingDay = dayStart + 86_400_000
      while ([0, 6].includes(new Date(nextTradingDay).getUTCDay())) {
        nextTradingDay += 86_400_000
      }
      ensureTape(nextTradingDay)
    })
    return () => {
      disposed = true
      offTick()
    }
  }, [engine, symbol])

  useEffect(() => {
    return engine.onStateChange(() => {
      setPlaying(engine.isPlaying())
    })
  }, [engine])

  const handlePlayToggle = useCallback(() => {
    if (engine.isPlaying()) engine.pause()
    else engine.play()
  }, [engine])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!started) return
      if (e.code !== 'Space' || e.repeat) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return
      e.preventDefault()
      handlePlayToggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, started])

  const handleSpeedChange = useCallback((s: Speed) => {
    engine.setSpeed(s)
    setSpeed(s)
  }, [engine])

  const handleJump = useCallback((t: number) => {
    engine.pause()
    engine.jumpTo(t)
  }, [engine])

  // Starts a pending-order draft: a default trigger price offset from the
  // current market (away from it for a stop / toward it for a limit), shown
  // on the chart as a draggable line the user fine-tunes before confirming.
  const handleStartDraft = useCallback((
    side: Side,
    kind: DraftOrderKind,
    lot: number,
    entryOverride?: number,
    stopOverride?: number | null,
    takeProfitOverride?: number | null,
  ) => {
    const { bid, ask } = accountPriceRef.current
    if (!bid || !ask) return
    engine.pause()
    const ref = side === 'buy' ? ask : bid
    const offset = ref * 0.001
    const goesUp = (side === 'buy') === (kind === 'stop')
    const price = entryOverride ?? (kind === 'market' ? ref : goesUp ? ref + offset : ref - offset)
    setDraft({ side, kind, lot, price, sl: stopOverride ?? null, tp: takeProfitOverride ?? null })
  }, [engine])

  const handleConfirmDraft = useCallback(() => {
    if (!draft) return
    const lot = riskSizingEnabled
      ? calculateRiskLot(symbol, draft.side, draft.price, draft.sl ?? NaN, account.balance, riskPercent)
      : draft.lot
    if (lot == null) return
    if (draft.kind === 'market') {
      account.openPosition(draft.side, lot, draft.sl, draft.tp)
    } else {
      account.placePendingOrder(draft.side, draft.kind, lot, draft.price, draft.sl, draft.tp)
    }
    setDraft(null)
  }, [account.balance, account.openPosition, account.placePendingOrder, draft, riskPercent, riskSizingEnabled, symbol])

  const handleCancelDraft = useCallback(() => setDraft(null), [])

  const draftLot = draft
    ? riskSizingEnabled
      ? calculateRiskLot(symbol, draft.side, draft.price, draft.sl ?? NaN, account.balance, riskPercent)
      : draft.lot
    : null
  const canConfirmDraft = !!draft && draftLot != null

  const handleStartBacktest = async () => {
    if (starting) return
    const activeAccount = account.accounts.find((item) => item.id === account.activeAccId)
    const isResume = activeAccount?.backtestStartTime != null
    const startTime = isResume
      ? accountResumeTime(activeAccount) ?? activeAccount.backtestStartTime!
      : selectedStartTime
    if (startTime == null) return
    setStarting(true)
    const day = new Date(startTime).toISOString().slice(0, 10)
    try {
      const tape = await loadTickTape(symbol, day)
      engine.setRealTickTape(tape)
      setTickDataStatus(tape
        ? `${tape.count.toLocaleString()} Dukascopy ticks loaded for ${day}.`
        : `No prepared tick tape for ${day}; using the available candle data instead.`)
    } catch (error) {
      console.error(`Failed to load ${symbol} tick tape for ${day}`, error)
      engine.setRealTickTape(null)
      setTickDataStatus(`Tick data for ${day} could not be loaded; using the available candle data instead.`)
    }
    engine.jumpTo(startTime)
    if (!isResume) account.initializeBacktest(startTime)
    setSelectedStartTime(startTime)
    setStarted(true)
    setStarting(false)
  }

  const handleSelectAccount = (accountId: string) => {
    const target = account.accounts.find((item) => item.id === accountId)
    account.switchAccount(accountId)
    setSelectedStartTime(
      target
        ? accountResumeTime(target) ?? defaultStartTimeRef.current ?? null
        : defaultStartTimeRef.current,
    )
    setTickDataStatus('')
  }

  const handleCreateAccount = (name: string, balance?: number, leverage?: 500 | 1000) => {
    account.createAccount(name, balance, leverage)
    setSelectedStartTime(defaultStartTimeRef.current)
    setTickDataStatus('')
  }

  const handleSwitchAccountFromChart = (accountId: string) => {
    account.saveBacktestProgress(engine.getSimTime())
    engine.pause()
    setDraft(null)
    setStarted(false)
    handleSelectAccount(accountId)
  }

  const handleCreateAccountFromChart = (name: string, balance?: number, leverage?: 500 | 1000) => {
    account.saveBacktestProgress(engine.getSimTime())
    engine.pause()
    setDraft(null)
    setStarted(false)
    handleCreateAccount(name, balance, leverage)
  }

  const handleDeleteAccountFromChart = (accountId: string) => {
    const nextAccount = account.accounts.find((item) => item.id !== accountId)
    account.saveBacktestProgress(engine.getSimTime())
    engine.pause()
    setDraft(null)
    setStarted(false)
    if (account.activeAccId === accountId && nextAccount) {
      setSelectedStartTime(
        accountResumeTime(nextAccount) ?? defaultStartTimeRef.current,
      )
      setTickDataStatus('')
    }
    account.deleteAccount(accountId)
  }

  const handleSaveBacktestProgress = useCallback((simTime: number) => {
    account.saveBacktestProgress(simTime)
  }, [account.saveBacktestProgress])

  useEffect(() => {
    if (!started) return
    const saveProgressOnPageExit = () => {
      account.saveBacktestProgress(engine.getSimTime())
    }
    window.addEventListener('pagehide', saveProgressOnPageExit)
    return () => window.removeEventListener('pagehide', saveProgressOnPageExit)
  }, [account.saveBacktestProgress, engine, started])

  const handleOpenDashboard = () => {
    account.saveBacktestProgress(engine.getSimTime())
    engine.pause()
    setDraft(null)
    setStarted(false)
  }

  // Single entry point for every draggable line on the chart (SL/TP on a
  // filled position, SL/TP on a pending order, or the draft's trigger/SL/TP).
  const handleOrderLineChange = useCallback((id: number, kind: 'sl' | 'tp' | 'trigger', price: number) => {
    if (id === DRAFT_ORDER_ID) {
      setDraft((d) => {
        if (!d) return d
        if (kind === 'trigger') return { ...d, price }
        if (kind === 'sl') return { ...d, sl: price }
        return { ...d, tp: price }
      })
      return
    }
    if (kind === 'trigger') {
      account.updatePendingTrigger(id, price)
      return
    }
    const existing =
      account.positions.find((p) => p.id === id) ?? account.pendingOrders.find((o) => o.id === id)
    const newSl = kind === 'sl' ? price : (existing?.sl ?? null)
    const newTp = kind === 'tp' ? price : (existing?.tp ?? null)
    account.updateSlTp(id, newSl, newTp)
  }, [account.pendingOrders, account.positions, account.updatePendingTrigger, account.updateSlTp])

  const handleMarketOrder = useCallback((side: Side, manualLot: number, risk: { percent: number; stopDistance: number } | null) => {
    const quote = accountPriceRef.current
    const entry = side === 'buy' ? quote.ask : quote.bid
    if (!entry) return false
    const stop = risk
      ? side === 'buy' ? entry - risk.stopDistance : entry + risk.stopDistance
      : null
    if (risk && (stop == null || !Number.isFinite(stop) || stop <= 0)) return false
    handleStartDraft(side, 'market', manualLot, entry, stop)
    return true
  }, [handleStartDraft])

  const handleLimitOrder = useCallback((side: Side, price: number, manualLot: number, risk: { percent: number; stopDistance: number } | null) => {
    const quote = accountPriceRef.current
    const validSide = side === 'buy' ? price < quote.ask : price > quote.bid
    if (!validSide || !quote.bid || !quote.ask) return false
    const stop = risk
      ? side === 'buy' ? price - risk.stopDistance : price + risk.stopDistance
      : null
    if (risk && (stop == null || !Number.isFinite(stop) || stop <= 0)) return false
    handleStartDraft(side, 'limit', manualLot, price, stop)
    return true
  }, [handleStartDraft])

  const activeBacktestAccount = account.accounts.find((item) => item.id === account.activeAccId)
  const hasChosenBacktestStart = activeBacktestAccount?.backtestStartTime != null
  const dashboardStartTime = hasChosenBacktestStart && activeBacktestAccount
    ? accountResumeTime(activeBacktestAccount) ?? selectedStartTime
    : selectedStartTime

  if (!started) {
    return (
      <Dashboard
        accounts={account.accounts}
        activeAccId={account.activeAccId}
        onSelectAccount={handleSelectAccount}
        onCreateAccount={handleCreateAccount}
        onDeleteAccount={account.deleteAccount}
        symbol={symbol}
        onSymbolChange={setSymbol}
        range={range}
        startTime={dashboardStartTime}
        dateLocked={hasChosenBacktestStart}
        initialStartTime={activeBacktestAccount?.backtestStartTime ?? null}
        onStartTimeChange={(time) => {
          setSelectedStartTime(time)
          setTickDataStatus('')
        }}
        dataReady={ready && !noData}
        dataError={noData}
        starting={starting}
        tickDataStatus={tickDataStatus}
        onStart={handleStartBacktest}
      />
    )
  }

  return (
    <div className="app">
      <TopBar
        engine={engine}
        symbol={symbol}
        bid={account.price.bid}
        ask={account.price.ask}
        simTime={engine.getSimTime()}
        newsSpike={account.price.newsSpike}
        isRealData={account.price.isRealData}
        tickDataStatus={tickDataStatus}
        onTickDataStatusChange={setTickDataStatus}
        onSymbolChange={setSymbol}
        onJump={handleJump}
        onOpenDashboard={handleOpenDashboard}
      />

      {account.stopOutAlert && (
        <div className="alert-banner">
          {account.stopOutAlert}
          <button className="btn btn-tiny btn-secondary" onClick={account.dismissStopOutAlert}>
            Close
          </button>
        </div>
      )}

      <div className="main-grid">
        <div className="chart-area">
          {!ready && <div className="loading">Loading data for {symbol}...</div>}
          {ready && noData && (
            <div className="loading">No data available for {symbol} — currently downloading, please check back later.</div>
          )}
          <PriceChart
            engine={engine}
            playing={playing}
            speed={speed}
            onPlayToggle={handlePlayToggle}
            onSpeedChange={handleSpeedChange}
            onJump={handleJump}
            onSaveProgress={handleSaveBacktestProgress}
            symbol={symbol}
            positions={account.positions}
            pendingOrders={account.pendingOrders}
            draft={draft}
            onOrderLineChange={handleOrderLineChange}
            quickLot={quickLot}
            onQuickLotChange={setQuickLot}
            riskSizingEnabled={riskSizingEnabled}
            riskPercent={riskPercent}
            quickStopDistance={quickStopDistance}
            onRiskSizingChange={setRiskSizingEnabled}
            onRiskPercentChange={setRiskPercent}
            onQuickStopDistanceChange={setQuickStopDistance}
            draftLot={draftLot}
            canConfirmDraft={canConfirmDraft}
            onConfirmDraft={handleConfirmDraft}
            onCancelDraft={handleCancelDraft}
            onMarketOrder={handleMarketOrder}
            onLimitOrder={handleLimitOrder}
          />
        </div>

      </div>

      <div className={`bottom-panel ${bottomPanelCollapsed ? 'bottom-panel-collapsed' : ''}`}>
        <div className="layout-panel-header bottom-panel-header">
          <span>Trade Terminal</span>
          <div className="terminal-summary" aria-label="Account summary">
            <span>Balance: <b>${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></span>
            <span>
              Open profit/loss:{' '}
              <b className={account.floatingPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                {account.floatingPnl >= 0 ? '+' : '−'}${Math.abs(account.floatingPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </b>
            </span>
          </div>
          <div className="terminal-tabs" role="tablist" aria-label="Trade terminal panels">
            <button
              className={`terminal-tab-button ${terminalTab === 'positions' ? 'terminal-tab-button-active' : ''}`}
              role="tab"
              aria-selected={terminalTab === 'positions'}
              onClick={() => setTerminalTab('positions')}
            >
              Positions
            </button>
            <button
              className={`terminal-tab-button ${terminalTab === 'account' ? 'terminal-tab-button-active' : ''}`}
              role="tab"
              aria-selected={terminalTab === 'account'}
              onClick={() => setTerminalTab('account')}
            >
              Account &amp; Trading
            </button>
          </div>
          <button
            onClick={() => setBottomPanelCollapsed((collapsed) => !collapsed)}
            title={bottomPanelCollapsed ? 'Expand trade terminal' : 'Collapse trade terminal'}
            aria-label={bottomPanelCollapsed ? 'Expand trade terminal' : 'Collapse trade terminal'}
          >
            {bottomPanelCollapsed ? '⌃' : '⌄'}
          </button>
        </div>
        {!bottomPanelCollapsed && (
          <div className="bottom-panel-content">
            {terminalTab === 'positions' ? (
              <PositionsPanel
                positions={account.positions}
                pendingOrders={account.pendingOrders}
                history={account.history}
                priceBySymbol={account.priceBySymbol}
                onClose={(id) => account.closePosition(id, 'manual')}
                onCancelPending={account.cancelPendingOrder}
              />
            ) : (
              <div className="account-trading-content">
                <div className="account-trading-account">
                  <AccountPanel
                    accounts={account.accounts}
                    activeAccId={account.activeAccId}
                    onSwitchAccount={handleSwitchAccountFromChart}
                    onCreateAccount={handleCreateAccountFromChart}
                    onDeleteAccount={handleDeleteAccountFromChart}
                    balance={account.balance}
                    equity={account.equity}
                    usedMargin={account.usedMargin}
                    freeMargin={account.freeMargin}
                    marginLevel={account.marginLevel}
                    floatingPnl={account.floatingPnl}
                    onReset={account.resetAccount}
                  />
                </div>
                <div className="account-trading-order">
                  <OrderTicket
                    symbol={symbol}
                    bid={account.price.bid}
                    ask={account.price.ask}
                    balance={account.balance}
                    riskSizingEnabled={riskSizingEnabled}
                    riskPercent={riskPercent}
                    onRiskSizingChange={setRiskSizingEnabled}
                    onRiskPercentChange={setRiskPercent}
                    leverage={account.leverage}
                    freeMargin={account.freeMargin}
                    draft={draft}
                    onStartDraft={handleStartDraft}
                    onConfirmDraft={handleConfirmDraft}
                    onCancelDraft={handleCancelDraft}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

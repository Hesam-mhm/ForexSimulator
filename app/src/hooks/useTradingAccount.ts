import { useCallback, useEffect, useRef, useState } from 'react'
import type { PriceEngine } from '../engine/priceEngine'
import type { AccountProfile, ClosedTrade, OrderKind, PendingOrder, Position, Side } from '../types'
import { SYMBOL_MAP, type SymbolId } from '../symbols'

export const STARTING_BALANCE = 10000
const STOP_OUT_LEVEL = 40 // % margin level -> forced liquidation
const STORAGE_KEY = 'fps_accounts_v1'
const ACTIVE_ACC_KEY = 'fps_active_acc_id_v1'

export type Leverage = 500 | 1000
export type PriceQuote = { bid: number; ask: number }

function loadAccounts(): AccountProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length > 0) return arr
    }
  } catch (e) {
    console.error('Failed to load accounts', e)
  }
  const defaultAcc: AccountProfile = {
    id: 'default',
    name: 'Account 1',
    balance: STARTING_BALANCE,
    initialBalance: STARTING_BALANCE,
    leverage: 500,
    createdAt: Date.now(),
    positions: [],
    pendingOrders: [],
    history: [],
  }
  return [defaultAcc]
}

function saveAccounts(accounts: AccountProfile[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts))
  } catch (e) {
    console.error('Failed to save accounts', e)
  }
}

export function positionPnl(p: Position, quote: PriceQuote) {
  const spec = SYMBOL_MAP[p.symbol]
  const closePrice = p.side === 'buy' ? quote.bid : quote.ask
  const dir = p.side === 'buy' ? 1 : -1
  const raw = (closePrice - p.openPrice) * dir * p.lot * spec.contractSize
  // USD-base pairs (USDJPY, USDCAD) settle P/L in the quote currency — convert
  // to the account's USD terms by dividing by the current rate.
  return spec.quoteIsUsd ? raw : raw / closePrice
}

export function marginForLot(symbol: SymbolId, lot: number, price: number, leverage: Leverage) {
  const spec = SYMBOL_MAP[symbol]
  const notionalUsd = spec.quoteIsUsd ? spec.contractSize * lot * price : spec.contractSize * lot
  return notionalUsd / leverage
}

/** Round down to the broker's 0.01-lot step so calculated risk does not exceed budget. */
export function calculateRiskLot(
  symbol: SymbolId,
  side: Side,
  entryPrice: number,
  stopPrice: number,
  balance: number,
  riskPercent: number,
): number | null {
  if (![entryPrice, stopPrice, balance, riskPercent].every(Number.isFinite) || entryPrice <= 0 || stopPrice <= 0 || balance <= 0 || riskPercent <= 0) return null
  if ((side === 'buy' && stopPrice >= entryPrice) || (side === 'sell' && stopPrice <= entryPrice)) return null

  const spec = SYMBOL_MAP[symbol]
  const lossPerLot = Math.abs(entryPrice - stopPrice) * spec.contractSize / (spec.quoteIsUsd ? 1 : stopPrice)
  if (!Number.isFinite(lossPerLot) || lossPerLot <= 0) return null
  const rawLot = (balance * riskPercent / 100) / lossPerLot
  const lot = Math.min(50, Math.floor((rawLot + Number.EPSILON) * 100) / 100)
  return lot >= 0.01 ? lot : null
}

/** A pending order fills once price trades through its trigger — stops chase a
 *  breakout (buy above / sell below current price), limits wait for a pullback
 *  (buy below / sell above current price). */
function pendingOrderHit(o: PendingOrder, bid: number, ask: number): boolean {
  if (o.side === 'buy') {
    return o.kind === 'stop' ? ask >= o.triggerPrice : ask <= o.triggerPrice
  }
  return o.kind === 'stop' ? bid <= o.triggerPrice : bid >= o.triggerPrice
}

export function useTradingAccount(engine: PriceEngine, activeSymbol: SymbolId) {
  const [accounts, setAccounts] = useState<AccountProfile[]>(loadAccounts)
  const [activeAccId, setActiveAccId] = useState<string>(() => {
    const saved = localStorage.getItem(ACTIVE_ACC_KEY)
    const initial = loadAccounts()
    if (saved && initial.some((a) => a.id === saved)) return saved
    return initial[0]?.id || 'default'
  })

  const currentAcc = accounts.find((a) => a.id === activeAccId) || accounts[0]

  const [balance, setBalance] = useState(currentAcc.balance)
  const [leverage, setLeverageState] = useState<Leverage>(currentAcc.leverage)
  const [positions, setPositions] = useState<Position[]>(currentAcc.positions)
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>(currentAcc.pendingOrders)
  const [history, setHistory] = useState<ClosedTrade[]>(currentAcc.history)
  const [price, setPrice] = useState({ bid: 0, ask: 0, mid: 0, newsSpike: false, isRealData: false })
  const [stopOutAlert, setStopOutAlert] = useState<string | null>(null)

  const positionsRef = useRef<Position[]>(currentAcc.positions)
  const pendingOrdersRef = useRef<PendingOrder[]>(currentAcc.pendingOrders)
  const historyRef = useRef<ClosedTrade[]>(currentAcc.history)
  const priceBySymbolRef = useRef<Partial<Record<SymbolId, PriceQuote>>>({})
  const activeSymbolRef = useRef(activeSymbol)
  const balanceRef = useRef(currentAcc.balance)
  const leverageRef = useRef<Leverage>(currentAcc.leverage)
  const nextId = useRef(1)
  const lastUiUpdate = useRef(0)

  // Switch active account
  const switchAccount = useCallback((accId: string) => {
    const target = accounts.find((a) => a.id === accId)
    if (!target) return
    setActiveAccId(accId)
    localStorage.setItem(ACTIVE_ACC_KEY, accId)

    setBalance(target.balance)
    balanceRef.current = target.balance

    setLeverageState(target.leverage)
    leverageRef.current = target.leverage

    setPositions(target.positions)
    positionsRef.current = target.positions

    setPendingOrders(target.pendingOrders)
    pendingOrdersRef.current = target.pendingOrders

    setHistory(target.history)
    historyRef.current = target.history

    // Sync nextId
    const maxPosId = Math.max(0, ...target.positions.map((p) => p.id))
    const maxOrderId = Math.max(0, ...target.pendingOrders.map((o) => o.id))
    const maxHistId = Math.max(0, ...target.history.map((h) => h.id))
    nextId.current = Math.max(maxPosId, maxOrderId, maxHistId) + 1

    setStopOutAlert(null)
  }, [accounts])

  // Save current account state whenever it changes
  const persistCurrentAccount = useCallback(() => {
    setAccounts((prev) => {
      const updated = prev.map((acc) => {
        if (acc.id === activeAccId) {
          return {
            ...acc,
            balance: balanceRef.current,
            leverage: leverageRef.current,
            positions: positionsRef.current,
            pendingOrders: pendingOrdersRef.current,
            history: historyRef.current,
          }
        }
        return acc
      })
      saveAccounts(updated)
      return updated
    })
  }, [activeAccId])

  const createAccount = useCallback((name: string, initialBalance = STARTING_BALANCE, accLeverage: Leverage = 500) => {
    const newId = 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
    const newProfile: AccountProfile = {
      id: newId,
      name: name.trim() || `Account ${accounts.length + 1}`,
      balance: initialBalance,
      initialBalance: initialBalance,
      leverage: accLeverage,
      createdAt: Date.now(),
      positions: [],
      pendingOrders: [],
      history: [],
    }
    setAccounts((prev) => {
      const next = [...prev, newProfile]
      saveAccounts(next)
      return next
    })
    setActiveAccId(newId)
    localStorage.setItem(ACTIVE_ACC_KEY, newId)
    setBalance(initialBalance)
    balanceRef.current = initialBalance
    setLeverageState(accLeverage)
    leverageRef.current = accLeverage
    setPositions([])
    positionsRef.current = []
    setPendingOrders([])
    pendingOrdersRef.current = []
    setHistory([])
    historyRef.current = []
    nextId.current = 1
    setStopOutAlert(null)
  }, [accounts.length])

  const deleteAccount = useCallback((accId: string) => {
    setAccounts((prev) => {
      if (prev.length <= 1) return prev // Keep at least one account
      const filtered = prev.filter((a) => a.id !== accId)
      saveAccounts(filtered)
      if (activeAccId === accId) {
        switchAccount(filtered[0].id)
      }
      return filtered
    })
  }, [activeAccId, switchAccount])


  useEffect(() => {
    activeSymbolRef.current = activeSymbol
    setPrice({ bid: 0, ask: 0, mid: 0, newsSpike: false, isRealData: false })
  }, [activeSymbol])

  useEffect(() => {
    positionsRef.current = positions
  }, [positions])
  useEffect(() => {
    pendingOrdersRef.current = pendingOrders
  }, [pendingOrders])
  useEffect(() => {
    historyRef.current = history
  }, [history])
  useEffect(() => {
    balanceRef.current = balance
  }, [balance])

  const quoteFor = (symbol: SymbolId): PriceQuote => priceBySymbolRef.current[symbol] ?? { bid: 0, ask: 0 }

  const closePosition = useCallback(
    (id: number, reason: ClosedTrade['reason']) => {
      const pos = positionsRef.current.find((p) => p.id === id)
      if (!pos) return
      const quote = quoteFor(pos.symbol)
      const closePrice = pos.side === 'buy' ? quote.bid : quote.ask
      const pnl = positionPnl(pos, quote)
      const trade: ClosedTrade = {
        ...pos,
        closePrice,
        closeTime: engine.getSimTime(),
        pnl,
        reason,
      }
      positionsRef.current = positionsRef.current.filter((p) => p.id !== id)
      setPositions(positionsRef.current)
      historyRef.current = [trade, ...historyRef.current]
      setHistory(historyRef.current)
      balanceRef.current += pnl
      setBalance(balanceRef.current)
      persistCurrentAccount()
    },
    [engine, persistCurrentAccount],
  )

  const openPosition = useCallback(
    (side: Side, lot: number, sl: number | null, tp: number | null) => {
      const symbol = activeSymbolRef.current
      const quote = quoteFor(symbol)
      if (!quote.bid || !quote.ask) return
      const openPrice = side === 'buy' ? quote.ask : quote.bid
      const pos: Position = {
        id: nextId.current++,
        symbol,
        side,
        lot,
        openPrice,
        openTime: engine.getSimTime(),
        sl,
        tp,
      }
      positionsRef.current = [...positionsRef.current, pos]
      setPositions(positionsRef.current)
      persistCurrentAccount()
    },
    [engine, persistCurrentAccount],
  )

  const placePendingOrder = useCallback(
    (side: Side, kind: OrderKind, lot: number, triggerPrice: number, sl: number | null, tp: number | null) => {
      const order: PendingOrder = {
        id: nextId.current++,
        symbol: activeSymbolRef.current,
        side,
        kind,
        lot,
        triggerPrice,
        sl,
        tp,
        createdTime: engine.getSimTime(),
      }
      pendingOrdersRef.current = [...pendingOrdersRef.current, order]
      setPendingOrders(pendingOrdersRef.current)
      persistCurrentAccount()
    },
    [engine, persistCurrentAccount],
  )

  const cancelPendingOrder = useCallback((id: number) => {
    pendingOrdersRef.current = pendingOrdersRef.current.filter((o) => o.id !== id)
    setPendingOrders(pendingOrdersRef.current)
    persistCurrentAccount()
  }, [persistCurrentAccount])

  const updatePendingTrigger = useCallback((id: number, triggerPrice: number) => {
    pendingOrdersRef.current = pendingOrdersRef.current.map((o) =>
      o.id === id ? { ...o, triggerPrice } : o,
    )
    setPendingOrders(pendingOrdersRef.current)
    persistCurrentAccount()
  }, [persistCurrentAccount])

  // shared by both open positions and pending orders — the id namespace is a
  // single counter, so looking in one list then the other is unambiguous
  const updateSlTp = useCallback((id: number, sl: number | null, tp: number | null) => {
    if (positionsRef.current.some((p) => p.id === id)) {
      positionsRef.current = positionsRef.current.map((p) => (p.id === id ? { ...p, sl, tp } : p))
      setPositions(positionsRef.current)
      persistCurrentAccount()
      return
    }
    if (pendingOrdersRef.current.some((o) => o.id === id)) {
      pendingOrdersRef.current = pendingOrdersRef.current.map((o) => (o.id === id ? { ...o, sl, tp } : o))
      setPendingOrders(pendingOrdersRef.current)
      persistCurrentAccount()
    }
  }, [persistCurrentAccount])

  useEffect(() => {
    const off = engine.onTick(({ bid, ask, mid, newsSpike, isRealData }) => {
      const symbol = activeSymbolRef.current
      priceBySymbolRef.current[symbol] = { bid, ask }

      // pending orders for the live symbol — fill at the trigger price (no
      // slippage modeled) and hand the id straight to the new position
      let pendingChanged = false
      let positionsChanged = false
      for (const o of pendingOrdersRef.current) {
        if (o.symbol !== symbol) continue
        if (!pendingOrderHit(o, bid, ask)) continue
        const pos: Position = {
          id: o.id,
          symbol: o.symbol,
          side: o.side,
          lot: o.lot,
          openPrice: o.triggerPrice,
          openTime: engine.getSimTime(),
          sl: o.sl,
          tp: o.tp,
        }
        positionsRef.current = [...positionsRef.current, pos]
        pendingOrdersRef.current = pendingOrdersRef.current.filter((p) => p.id !== o.id)
        positionsChanged = true
        pendingChanged = true
      }
      if (pendingChanged) setPendingOrders(pendingOrdersRef.current)
      if (positionsChanged) setPositions(positionsRef.current)

      // SL/TP checks every tick — only meaningful for positions in the symbol
      // that's actually receiving live ticks right now
      for (const p of positionsRef.current) {
        if (p.symbol !== symbol) continue
        const curClose = p.side === 'buy' ? bid : ask
        if (p.side === 'buy') {
          if (p.sl != null && curClose <= p.sl) {
            closePosition(p.id, 'sl')
            continue
          }
          if (p.tp != null && curClose >= p.tp) {
            closePosition(p.id, 'tp')
            continue
          }
        } else {
          if (p.sl != null && curClose >= p.sl) {
            closePosition(p.id, 'sl')
            continue
          }
          if (p.tp != null && curClose <= p.tp) {
            closePosition(p.id, 'tp')
            continue
          }
        }
      }

      // margin / stop-out check across all open positions, using each one's
      // own last-known price (only `symbol`'s is fresh this tick)
      if (positionsRef.current.length) {
        let usedMargin = 0
        let floatingPnl = 0
        for (const p of positionsRef.current) {
          usedMargin += marginForLot(p.symbol, p.lot, p.openPrice, leverage)
          floatingPnl += positionPnl(p, quoteFor(p.symbol))
        }
        const equity = balanceRef.current + floatingPnl
        const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : Infinity
        if (marginLevel < STOP_OUT_LEVEL) {
          const ids = positionsRef.current.map((p) => p.id)
          ids.forEach((id) => closePosition(id, 'stopout'))
          setStopOutAlert(
            `Stop out: margin level below ${STOP_OUT_LEVEL}% — all positions were automatically closed.`,
          )
        }
      }

      const now = performance.now()
      if (now - lastUiUpdate.current > 100) {
        lastUiUpdate.current = now
        setPrice({ bid, ask, mid, newsSpike, isRealData })
      }
    })
    return off
  }, [engine, leverage, closePosition])

  const usedMargin = positions.reduce((s, p) => s + marginForLot(p.symbol, p.lot, p.openPrice, leverage), 0)
  const floatingPnl = positions.reduce((s, p) => s + positionPnl(p, quoteFor(p.symbol)), 0)
  const equity = balance + floatingPnl
  const freeMargin = equity - usedMargin
  const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : null

  const initializeBacktest = useCallback((startTime: number) => {
    if (!Number.isFinite(startTime)) return
    setAccounts((prev) => {
      let changed = false
      const next = prev.map((acc) => {
        if (acc.id !== activeAccId || acc.backtestStartTime != null) return acc
        changed = true
        return { ...acc, backtestStartTime: startTime, lastSimTime: startTime }
      })
      if (!changed) return prev
      saveAccounts(next)
      return next
    })
  }, [activeAccId])

  const saveBacktestProgress = useCallback((simTime: number) => {
    if (!Number.isFinite(simTime)) return
    let changed = false
    const next = accounts.map((acc) => {
      if (acc.id !== activeAccId) return acc
      changed = true
      return {
        ...acc,
        backtestStartTime: acc.backtestStartTime ?? simTime,
        lastSimTime: simTime,
      }
    })
    if (!changed) return
    saveAccounts(next)
    setAccounts(next)
  }, [accounts, activeAccId])

  const resetAccount = useCallback((newBalance = STARTING_BALANCE) => {
    balanceRef.current = newBalance
    setBalance(newBalance)
    positionsRef.current = []
    setPositions([])
    pendingOrdersRef.current = []
    setPendingOrders([])
    historyRef.current = []
    setHistory([])
    setStopOutAlert(null)
    persistCurrentAccount()
  }, [persistCurrentAccount])

  return {
    accounts,
    activeAccId,
    createAccount,
    switchAccount,
    deleteAccount,
    balance,
    equity,
    usedMargin,
    freeMargin,
    marginLevel,
    floatingPnl,
    leverage,
    positions,
    pendingOrders,
    history,
    price,
    priceBySymbol: priceBySymbolRef.current,
    openPosition,
    closePosition,
    placePendingOrder,
    cancelPendingOrder,
    updatePendingTrigger,
    updateSlTp,
    resetAccount,
    initializeBacktest,
    saveBacktestProgress,
    stopOutAlert,
    dismissStopOutAlert: () => setStopOutAlert(null),
  }
}

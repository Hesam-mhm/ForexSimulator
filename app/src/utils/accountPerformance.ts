import type { AccountProfile, ClosedTrade } from '../types'

export type EquityPoint = {
  time: number
  equity: number
  peak: number
  drawdown: number
  drawdownPercent: number
}

export type AccountPerformanceMetrics = {
  trades: ClosedTrade[]
  tradeCount: number
  wins: number
  losses: number
  breakeven: number
  winRate: number | null
  netPnl: number
  startingEquity: number
  returnPercent: number | null
  grossProfit: number
  grossLoss: number
  profitFactor: number | null
  averageWin: number | null
  averageLoss: number | null
  expectancy: number | null
  bestTrade: ClosedTrade | null
  worstTrade: ClosedTrade | null
  maxDrawdown: number
  maxDrawdownPercent: number
  currentDrawdown: number
  currentDrawdownPercent: number
  equityCurve: EquityPoint[]
}

export function calculateAccountPerformance(account: Pick<AccountProfile, 'balance' | 'history'>): AccountPerformanceMetrics {
  const trades = account.history
    .filter((trade) => Number.isFinite(trade.pnl) && Number.isFinite(trade.closeTime))
    .slice()
    .sort((a, b) => a.closeTime - b.closeTime || a.id - b.id)

  let wins = 0
  let losses = 0
  let breakeven = 0
  let grossProfit = 0
  let grossLoss = 0
  let netPnl = 0
  let winningPnl = 0
  let losingPnl = 0

  for (const trade of trades) {
    netPnl += trade.pnl
    if (trade.pnl > 0) {
      wins++
      grossProfit += trade.pnl
      winningPnl += trade.pnl
    } else if (trade.pnl < 0) {
      losses++
      grossLoss += Math.abs(trade.pnl)
      losingPnl += trade.pnl
    } else {
      breakeven++
    }
  }

  const startingEquity = account.balance - netPnl
  let equity = startingEquity
  let peak = startingEquity
  let maxDrawdown = 0
  let maxDrawdownPercent = 0
  let currentDrawdown = 0
  let currentDrawdownPercent = 0
  const firstTime = trades[0]?.openTime ?? trades[0]?.closeTime ?? 0
  const equityCurve: EquityPoint[] = [{
    time: firstTime,
    equity,
    peak,
    drawdown: 0,
    drawdownPercent: 0,
  }]

  for (const trade of trades) {
    equity += trade.pnl
    peak = Math.max(peak, equity)
    const drawdown = Math.max(0, peak - equity)
    const drawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0
    maxDrawdown = Math.max(maxDrawdown, drawdown)
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPercent)
    currentDrawdown = drawdown
    currentDrawdownPercent = drawdownPercent
    equityCurve.push({ time: trade.closeTime, equity, peak, drawdown, drawdownPercent })
  }

  const tradeCount = trades.length
  const bestTrade = trades.reduce<ClosedTrade | null>((best, trade) => !best || trade.pnl > best.pnl ? trade : best, null)
  const worstTrade = trades.reduce<ClosedTrade | null>((worst, trade) => !worst || trade.pnl < worst.pnl ? trade : worst, null)

  return {
    trades,
    tradeCount,
    wins,
    losses,
    breakeven,
    winRate: tradeCount ? (wins / tradeCount) * 100 : null,
    netPnl,
    startingEquity,
    returnPercent: startingEquity !== 0 ? (netPnl / startingEquity) * 100 : null,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    averageWin: wins ? winningPnl / wins : null,
    averageLoss: losses ? losingPnl / losses : null,
    expectancy: tradeCount ? netPnl / tradeCount : null,
    bestTrade,
    worstTrade,
    maxDrawdown,
    maxDrawdownPercent,
    currentDrawdown,
    currentDrawdownPercent,
    equityCurve,
  }
}

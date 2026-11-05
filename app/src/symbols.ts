// Mirrors scripts/symbols.py — keep both in sync if this list changes.

export type SymbolId = 'XAUUSD'

export type SymbolConfig = {
  id: SymbolId
  label: string
  /** Units of the base instrument per 1.00 lot (e.g. 100,000 currency units, 100 oz, 1 BTC). */
  contractSize: number
  /** true when the quote currency is USD (price move * contractSize is already in USD).
   *  false for USD-base pairs (USDJPY, USDCAD) where the P/L is in the quote currency
   *  and has to be converted to USD by dividing by the current price. */
  quoteIsUsd: boolean
  /** Decimal places to display the price with. */
  pricePrecision: number
  /** Reasonable synthetic bid/ask spread used when no real tick data is spliced in. */
  defaultSpread: number
  /** Human-readable "1 lot = ..." hint shown in the order ticket. */
  lotHint: string
}

export const SYMBOLS: SymbolConfig[] = [
  {
    id: 'XAUUSD',
    label: 'XAUUSD (Gold)',
    contractSize: 100,
    quoteIsUsd: true,
    pricePrecision: 2,
    defaultSpread: 0.22,
    lotHint: '1 lot = 100 oz',
  },
]

export const SYMBOL_MAP: Record<SymbolId, SymbolConfig> = Object.fromEntries(
  SYMBOLS.map((s) => [s.id, s]),
) as Record<SymbolId, SymbolConfig>

export function formatPrice(price: number, symbol: SymbolId): string {
  if (!price) return '—'
  return price.toFixed(SYMBOL_MAP[symbol].pricePrecision)
}

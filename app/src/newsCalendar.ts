// Real 2026 US macro release calendar (FOMC / NFP / CPI), covering the full year.
// Converted to UTC with US Eastern DST correctly applied (EST = UTC-5 through 2026-03-07 and
// from 2026-11-01 onward, EDT = UTC-4 in between). Sourced from federalreserve.gov (FOMC) and
// BLS release schedules — both publish a full year's schedule well in advance, so this list
// doesn't need to "guess" future dates.
//
// Entries beyond whatever candle data is currently loaded just won't have anything to jump to
// yet — scripts/update_candles.py (run daily via .github/workflows/update-data.yml) fills that
// in automatically as Dukascopy publishes it, no manual step needed.
//
// The underlying XAUUSD data is real Dukascopy tick data (resampled to 15-min bars for the
// main dataset) — for these specific events we additionally ship real raw ticks covering
// -1min to +5min around the release (see scripts/download_news_ticks.py /
// app/public/data/news_ticks/<key>.json), so the app can replay the actual real-money
// reaction second by second instead of the synthetic intra-bar path used everywhere else.
// That same daily workflow re-runs download_news_ticks.py, which skips events it already has
// and auto-fetches any newly-reachable one — so once the candle data above catches up to a
// date on this list, its real ticks show up within a day or two on their own as well.
//
// New year's schedule isn't out yet by the time this file needs extending past December?
// Just ask — the dates are public knowledge (federalreserve.gov, bls.gov), not something
// that needs discovering at runtime.

export type NewsEvent = {
  type: 'FOMC' | 'NFP' | 'CPI'
  label: string
  ms: number
  /** Matches scripts/download_news_ticks.py output filename, when real tick data exists. */
  key: string
}

const U = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi)

export const NEWS_CALENDAR_2026: NewsEvent[] = [
  // FOMC rate decision, 2:00pm ET
  { type: 'FOMC', label: 'FOMC 28/01/2026', ms: U(2026, 1, 28, 19, 0), key: 'FOMC_2026-01-28' },
  { type: 'FOMC', label: 'FOMC 18/03/2026', ms: U(2026, 3, 18, 18, 0), key: 'FOMC_2026-03-18' },
  { type: 'FOMC', label: 'FOMC 29/04/2026', ms: U(2026, 4, 29, 18, 0), key: 'FOMC_2026-04-29' },
  { type: 'FOMC', label: 'FOMC 17/06/2026', ms: U(2026, 6, 17, 18, 0), key: 'FOMC_2026-06-17' },
  { type: 'FOMC', label: 'FOMC 29/07/2026', ms: U(2026, 7, 29, 18, 0), key: 'FOMC_2026-07-29' },
  { type: 'FOMC', label: 'FOMC 16/09/2026', ms: U(2026, 9, 16, 18, 0), key: 'FOMC_2026-09-16' },
  { type: 'FOMC', label: 'FOMC 28/10/2026', ms: U(2026, 10, 28, 18, 0), key: 'FOMC_2026-10-28' },
  { type: 'FOMC', label: 'FOMC 09/12/2026', ms: U(2026, 12, 9, 19, 0), key: 'FOMC_2026-12-09' },

  // NFP (Employment Situation), 8:30am ET — 03/04/2026 skipped, market data shows no
  // session that day (Good Friday closure)
  { type: 'NFP', label: 'NFP 09/01/2026', ms: U(2026, 1, 9, 13, 30), key: 'NFP_2026-01-09' },
  { type: 'NFP', label: 'NFP 11/02/2026', ms: U(2026, 2, 11, 13, 30), key: 'NFP_2026-02-11' },
  { type: 'NFP', label: 'NFP 06/03/2026', ms: U(2026, 3, 6, 13, 30), key: 'NFP_2026-03-06' },
  { type: 'NFP', label: 'NFP 08/05/2026', ms: U(2026, 5, 8, 12, 30), key: 'NFP_2026-05-08' },
  { type: 'NFP', label: 'NFP 05/06/2026', ms: U(2026, 6, 5, 12, 30), key: 'NFP_2026-06-05' },
  { type: 'NFP', label: 'NFP 02/07/2026', ms: U(2026, 7, 2, 12, 30), key: 'NFP_2026-07-02' },
  { type: 'NFP', label: 'NFP 07/08/2026', ms: U(2026, 8, 7, 12, 30), key: 'NFP_2026-08-07' },
  { type: 'NFP', label: 'NFP 04/09/2026', ms: U(2026, 9, 4, 12, 30), key: 'NFP_2026-09-04' },
  { type: 'NFP', label: 'NFP 02/10/2026', ms: U(2026, 10, 2, 12, 30), key: 'NFP_2026-10-02' },
  { type: 'NFP', label: 'NFP 06/11/2026', ms: U(2026, 11, 6, 13, 30), key: 'NFP_2026-11-06' },
  { type: 'NFP', label: 'NFP 04/12/2026', ms: U(2026, 12, 4, 13, 30), key: 'NFP_2026-12-04' },

  // CPI, 8:30am ET
  { type: 'CPI', label: 'CPI 13/01/2026', ms: U(2026, 1, 13, 13, 30), key: 'CPI_2026-01-13' },
  { type: 'CPI', label: 'CPI 13/02/2026', ms: U(2026, 2, 13, 13, 30), key: 'CPI_2026-02-13' },
  { type: 'CPI', label: 'CPI 11/03/2026', ms: U(2026, 3, 11, 12, 30), key: 'CPI_2026-03-11' },
  { type: 'CPI', label: 'CPI 10/04/2026', ms: U(2026, 4, 10, 12, 30), key: 'CPI_2026-04-10' },
  { type: 'CPI', label: 'CPI 12/05/2026', ms: U(2026, 5, 12, 12, 30), key: 'CPI_2026-05-12' },
  { type: 'CPI', label: 'CPI 10/06/2026', ms: U(2026, 6, 10, 12, 30), key: 'CPI_2026-06-10' },
  { type: 'CPI', label: 'CPI 14/07/2026', ms: U(2026, 7, 14, 12, 30), key: 'CPI_2026-07-14' },
  { type: 'CPI', label: 'CPI 12/08/2026', ms: U(2026, 8, 12, 12, 30), key: 'CPI_2026-08-12' },
  { type: 'CPI', label: 'CPI 11/09/2026', ms: U(2026, 9, 11, 12, 30), key: 'CPI_2026-09-11' },
  { type: 'CPI', label: 'CPI 14/10/2026', ms: U(2026, 10, 14, 12, 30), key: 'CPI_2026-10-14' },
  { type: 'CPI', label: 'CPI 10/11/2026', ms: U(2026, 11, 10, 13, 30), key: 'CPI_2026-11-10' },
  { type: 'CPI', label: 'CPI 10/12/2026', ms: U(2026, 12, 10, 13, 30), key: 'CPI_2026-12-10' },
]

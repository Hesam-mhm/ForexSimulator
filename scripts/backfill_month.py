"""Download exactly one (symbol, month) pair — the parallel unit of work for
the full historical backfill. Derived from backfill_symbol.py's per-month
loop body; use this when you want every (symbol, month) pair to be an
independent job runnable concurrently (e.g. via `xargs -P`) instead of one
process per symbol working through its 13 months sequentially.

Usage:
    python3 scripts/backfill_month.py SYMBOL YYYY-MM
"""
import sys
from calendar import monthrange
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dukascopy_downloader import download_symbol_range, ticks_to_ohlc  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TIMEFRAME = "15min"
LAG_DAYS = 2  # matches backfill_symbol.py / update_candles.py


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 scripts/backfill_month.py SYMBOL YYYY-MM")
        sys.exit(1)
    symbol, month_str = sys.argv[1], sys.argv[2]
    y, m = map(int, month_str.split("-"))
    month_start = date(y, m, 1)
    last_day = date(y, m, monthrange(y, m)[1])
    cutoff = date.today() - timedelta(days=LAG_DAYS)
    month_end = min(last_day, cutoff)

    data_dir = ROOT / "data" / symbol
    data_dir.mkdir(parents=True, exist_ok=True)
    out_path = data_dir / f"{symbol}_{month_start:%Y-%m}.parquet"
    if out_path.exists():
        print(f"{symbol} {month_start:%Y-%m}: already have it, skipping")
        return
    if month_start > cutoff:
        print(f"{symbol} {month_start:%Y-%m}: past the cutoff ({cutoff}), nothing to do")
        return

    print(f"{symbol} {month_start:%Y-%m}: downloading {month_start} .. {month_end}")
    ticks = download_symbol_range(symbol, month_start, month_end)
    bars = ticks_to_ohlc(ticks, TIMEFRAME)
    if bars.empty:
        print(f"  no data for {symbol} {month_start:%Y-%m}, skipping save")
        return
    bars.to_parquet(out_path)
    print(f"  saved {out_path.name}: {len(bars)} bars")


if __name__ == "__main__":
    main()

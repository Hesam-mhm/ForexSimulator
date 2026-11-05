"""One-time historical backfill for a new symbol, matching the date range
already covered by XAUUSD's data/XAUUSD/*.parquet files.

Downloads month by month and saves each month's parquet as soon as it's
ready, so the job is resumable — rerunning skips any month whose parquet
file already exists on disk.

Usage:
    python3 scripts/backfill_symbol.py BTCUSD EURUSD GBPUSD USDJPY USDCAD
"""
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dukascopy_downloader import download_symbol_range, month_ranges, ticks_to_ohlc  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TIMEFRAME = "15min"
LAG_DAYS = 2
START = date(2025, 8, 1)  # matches the earliest XAUUSD month on disk


def backfill(symbol: str, start: date, end: date):
    data_dir = ROOT / "data" / symbol
    data_dir.mkdir(parents=True, exist_ok=True)
    for month_start, month_end in month_ranges(start, end):
        out_path = data_dir / f"{symbol}_{month_start.strftime('%Y-%m')}.parquet"
        if out_path.exists():
            print(f"{symbol} {month_start:%Y-%m}: already have it, skipping")
            continue
        print(f"{symbol} {month_start:%Y-%m}: downloading {month_start} .. {month_end}")
        ticks = download_symbol_range(symbol, month_start, month_end)
        bars = ticks_to_ohlc(ticks, TIMEFRAME)
        if bars.empty:
            print(f"  no data for {symbol} {month_start:%Y-%m}, skipping save")
            continue
        bars.to_parquet(out_path)
        print(f"  saved {out_path.name}: {len(bars)} bars")


def main():
    symbols = sys.argv[1:]
    if not symbols:
        print("Usage: python3 scripts/backfill_symbol.py SYMBOL [SYMBOL...]")
        sys.exit(1)
    end = date.today() - timedelta(days=LAG_DAYS)
    for symbol in symbols:
        backfill(symbol, START, end)
    print("Backfill done for:", ", ".join(symbols))


if __name__ == "__main__":
    main()

"""Refresh local candle data for every tracked symbol from Dukascopy up to
the latest available day, then regenerate the JSON the web app reads. Meant
to run on a schedule (see .github/workflows/update-data.yml) — safe to run
repeatedly.

Re-downloads only a rolling trailing window (REFRESH_WINDOW_DAYS) ending at
the cutoff date and splices it into the existing per-month parquet files,
leaving everything older untouched. Deliberately NOT "redownload the whole
current month every run" — that starts cheap early in a month but grows
unbounded as the month goes on (by day 25 it would be re-fetching 24 already-
correct days just to add 1 new one). A small trailing window still lets
Dukascopy's occasional late corrections to the last day or two settle in,
without the runtime growing over the month.

A symbol with no local data yet (e.g. a new one still mid-backfill) is
skipped rather than treated as an error — nothing to anchor a rolling
refresh to until the initial backfill finishes.

Does NOT touch app/public/data/news_ticks/ — those are fixed historical
events downloaded once by download_news_ticks.py.
"""
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dukascopy_downloader import download_symbol_range, month_ranges, ticks_to_ohlc  # noqa: E402
from symbols import SYMBOLS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TIMEFRAME = "15min"
# Dukascopy publishes daily files with a lag (observed 1-2 days) — stop short
# of "today" so we're not repeatedly re-fetching a day that isn't actually
# published yet.
LAG_DAYS = 2
# How far back to re-check/re-fetch each run. Bounded and constant regardless
# of how far into the month we are.
REFRESH_WINDOW_DAYS = 5


def earliest_local_month(data_dir: Path, symbol: str) -> date | None:
    files = sorted(data_dir.glob(f"{symbol}_*.parquet"))
    if not files:
        return None
    first = files[0].stem.split("_")[-1]
    y, m = map(int, first.split("-"))
    return date(y, m, 1)


def refresh_month_chunk(data_dir: Path, symbol: str, month_start: date, month_end: date) -> bool:
    """Fetch [month_start, month_end] and splice it into that month's parquet,
    preserving any existing rows for that month outside the refreshed range.
    Returns True if the file on disk changed."""
    out_path = data_dir / f"{symbol}_{month_start.strftime('%Y-%m')}.parquet"
    print(f"refreshing {symbol} {month_start} .. {month_end}")
    ticks = download_symbol_range(symbol, month_start, month_end)
    new_bars = ticks_to_ohlc(ticks, TIMEFRAME)

    window_start_ts = pd.Timestamp(month_start)
    window_end_ts = pd.Timestamp(month_end) + pd.Timedelta(days=1)  # exclusive upper bound

    if out_path.exists():
        existing = pd.read_parquet(out_path)
        outside_window = existing[(existing.index < window_start_ts) | (existing.index >= window_end_ts)]
        combined = pd.concat([outside_window, new_bars]).sort_index()
        combined = combined[~combined.index.duplicated(keep="last")]
    else:
        combined = new_bars

    if combined.empty:
        print(f"  nothing to save for {symbol} {month_start:%Y-%m}, skipping")
        return False

    combined.to_parquet(out_path)
    print(f"  saved {out_path.name}: {len(combined)} bars total ({len(new_bars)} refreshed this run)")
    return True


def update_symbol(symbol: str, end: date) -> bool:
    data_dir = ROOT / "data" / symbol
    data_dir.mkdir(parents=True, exist_ok=True)
    earliest = earliest_local_month(data_dir, symbol)
    if earliest is None:
        print(f"{symbol}: no existing parquet data yet — skipping (run backfill_symbol.py first)")
        return False

    window_start = max(end - timedelta(days=REFRESH_WINDOW_DAYS), earliest)
    if window_start > end:
        print(f"{symbol}: update window start ({window_start}) already past cutoff ({end}). Nothing to do.")
        return False

    changed = False
    for month_start, month_end in month_ranges(window_start, end):
        if refresh_month_chunk(data_dir, symbol, month_start, month_end):
            changed = True
    return changed


def main():
    end = date.today() - timedelta(days=LAG_DAYS)
    changed = False
    for symbol in SYMBOLS:
        if update_symbol(symbol, end):
            changed = True

    if not changed:
        print("No new data was available from Dukascopy this run.")
        return

    print("Regenerating app JSON from updated parquet files...")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "convert_data.py")], check=True)


if __name__ == "__main__":
    main()

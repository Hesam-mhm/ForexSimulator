"""One-time cleanup: find intraday gaps in existing parquet data that look
like genuine download failures (not the daily ~19:45-23:00 UTC low-liquidity
window every broker/feed shows around the NY close, and not multi-day
weekend/holiday closures) and re-fetch just those hours.
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dukascopy_downloader import download_hour_ticks, ticks_to_ohlc  # noqa: E402
from symbols import SYMBOLS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# the recurring daily NY-close quiet window, generously bounded to cover DST drift
DAILY_GAP_START_HOUR = 19
DAILY_GAP_END_HOUR = 23
MAX_DAILY_GAP_MIN = 300  # 5h — generous; anything longer isn't the daily window
WEEKEND_GAP_MIN = 20 * 60  # multi-day closures (weekends, holidays)


def is_expected_gap(prev_end, next_start, minutes):
    if minutes >= WEEKEND_GAP_MIN:
        return True
    if prev_end.hour >= DAILY_GAP_START_HOUR and minutes <= MAX_DAILY_GAP_MIN:
        return True
    return False


def find_suspicious_gaps(df):
    idx = df.sort_index().index
    gaps = []
    for i in range(1, len(idx)):
        minutes = (idx[i] - idx[i - 1]).total_seconds() / 60
        if minutes <= 15:
            continue
        if is_expected_gap(idx[i - 1], idx[i], minutes):
            continue
        gaps.append((idx[i - 1], idx[i]))
    return gaps


def hours_in_gap(prev_end, next_start):
    hours = set()
    t = (prev_end + pd.Timedelta(minutes=15)).floor("h")
    while t < next_start:
        hours.add((t.date(), t.hour))
        t += pd.Timedelta(hours=1)
    return sorted(hours)


def fix_symbol(symbol: str):
    data_dir = ROOT / "data" / symbol
    if not data_dir.exists():
        return
    for path in sorted(data_dir.glob(f"{symbol}_*.parquet")):
        df = pd.read_parquet(path)
        gaps = find_suspicious_gaps(df)
        if not gaps:
            continue
        print(f"{path.name}: {len(gaps)} suspicious gap(s)")
        frames = []
        for prev_end, next_start in gaps:
            for day, hour in hours_in_gap(prev_end, next_start):
                print(f"  refetching {symbol} {day} {hour:02d}h")
                ticks = download_hour_ticks(symbol, day, hour)
                if not ticks.empty:
                    frames.append(ticks)
        if not frames:
            print("  nothing came back, leaving as-is")
            continue
        new_ticks = pd.concat(frames, ignore_index=True)
        new_bars = ticks_to_ohlc(new_ticks, "15min")
        combined = pd.concat([df, new_bars]).sort_index()
        combined = combined[~combined.index.duplicated(keep="last")]
        combined.to_parquet(path)
        added = len(combined) - len(df)
        print(f"  saved: {added} new bar(s) added")


def main():
    symbols = sys.argv[1:] or SYMBOLS
    for symbol in symbols:
        fix_symbol(symbol)


if __name__ == "__main__":
    main()

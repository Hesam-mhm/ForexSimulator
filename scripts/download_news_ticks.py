"""Download real Dukascopy ticks for a window around each known 2026 news event,
for every tracked symbol, and save them as compact JSON for the app to splice
into the simulation.

Reuses the tick fetch/decode logic from dukascopy_downloader.py in this same
folder (same data source that produced our OHLC bars). That module's
download_hour_ticks() already enforces a hard per-hour timeout, so no extra
wrapper is needed here.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dukascopy_downloader import download_hour_ticks  # noqa: E402
from symbols import SYMBOLS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / "app" / "public" / "data" / "news_ticks"

BEFORE = timedelta(minutes=1)
AFTER = timedelta(minutes=30)

# Mirrors app/src/newsCalendar.ts — keep in sync if that file changes.
EVENTS = [
    ("FOMC_2026-01-28", datetime(2026, 1, 28, 19, 0, tzinfo=timezone.utc)),
    ("FOMC_2026-03-18", datetime(2026, 3, 18, 18, 0, tzinfo=timezone.utc)),
    ("FOMC_2026-04-29", datetime(2026, 4, 29, 18, 0, tzinfo=timezone.utc)),
    ("FOMC_2026-06-17", datetime(2026, 6, 17, 18, 0, tzinfo=timezone.utc)),
    ("FOMC_2026-07-29", datetime(2026, 7, 29, 18, 0, tzinfo=timezone.utc)),
    ("FOMC_2026-09-16", datetime(2026, 9, 16, 18, 0, tzinfo=timezone.utc)),
    ("FOMC_2026-10-28", datetime(2026, 10, 28, 18, 0, tzinfo=timezone.utc)),
    ("FOMC_2026-12-09", datetime(2026, 12, 9, 19, 0, tzinfo=timezone.utc)),
    ("NFP_2026-01-09", datetime(2026, 1, 9, 13, 30, tzinfo=timezone.utc)),
    ("NFP_2026-02-11", datetime(2026, 2, 11, 13, 30, tzinfo=timezone.utc)),
    ("NFP_2026-03-06", datetime(2026, 3, 6, 13, 30, tzinfo=timezone.utc)),
    ("NFP_2026-05-08", datetime(2026, 5, 8, 12, 30, tzinfo=timezone.utc)),
    ("NFP_2026-06-05", datetime(2026, 6, 5, 12, 30, tzinfo=timezone.utc)),
    ("NFP_2026-07-02", datetime(2026, 7, 2, 12, 30, tzinfo=timezone.utc)),
    ("NFP_2026-08-07", datetime(2026, 8, 7, 12, 30, tzinfo=timezone.utc)),
    ("NFP_2026-09-04", datetime(2026, 9, 4, 12, 30, tzinfo=timezone.utc)),
    ("NFP_2026-10-02", datetime(2026, 10, 2, 12, 30, tzinfo=timezone.utc)),
    ("NFP_2026-11-06", datetime(2026, 11, 6, 13, 30, tzinfo=timezone.utc)),
    ("NFP_2026-12-04", datetime(2026, 12, 4, 13, 30, tzinfo=timezone.utc)),
    ("CPI_2026-01-13", datetime(2026, 1, 13, 13, 30, tzinfo=timezone.utc)),
    ("CPI_2026-02-13", datetime(2026, 2, 13, 13, 30, tzinfo=timezone.utc)),
    ("CPI_2026-03-11", datetime(2026, 3, 11, 12, 30, tzinfo=timezone.utc)),
    ("CPI_2026-04-10", datetime(2026, 4, 10, 12, 30, tzinfo=timezone.utc)),
    ("CPI_2026-05-12", datetime(2026, 5, 12, 12, 30, tzinfo=timezone.utc)),
    ("CPI_2026-06-10", datetime(2026, 6, 10, 12, 30, tzinfo=timezone.utc)),
    ("CPI_2026-07-14", datetime(2026, 7, 14, 12, 30, tzinfo=timezone.utc)),
    ("CPI_2026-08-12", datetime(2026, 8, 12, 12, 30, tzinfo=timezone.utc)),
    ("CPI_2026-09-11", datetime(2026, 9, 11, 12, 30, tzinfo=timezone.utc)),
    ("CPI_2026-10-14", datetime(2026, 10, 14, 12, 30, tzinfo=timezone.utc)),
    ("CPI_2026-11-10", datetime(2026, 11, 10, 13, 30, tzinfo=timezone.utc)),
    ("CPI_2026-12-10", datetime(2026, 12, 10, 13, 30, tzinfo=timezone.utc)),
]


def download_for_symbol(symbol: str):
    out_dir = OUT_ROOT / symbol
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {}

    for key, event_time in EVENTS:
        out_path = out_dir / f"{key}.json"
        win_start = event_time - BEFORE
        win_end = event_time + AFTER

        if out_path.exists():
            rows = json.loads(out_path.read_text())
            manifest[key] = {
                "eventMs": int(event_time.timestamp() * 1000),
                "windowStartMs": int(win_start.timestamp() * 1000),
                "windowEndMs": int(win_end.timestamp() * 1000),
                "tickCount": len(rows),
            }
            print(f"{symbol}/{key}: already downloaded ({len(rows)} ticks), skipping")
            continue

        hours_needed = set()
        t = win_start.replace(minute=0, second=0, microsecond=0)
        while t <= win_end:
            hours_needed.add((t.date(), t.hour))
            t += timedelta(hours=1)

        frames = []
        for day, hour in sorted(hours_needed):
            df = download_hour_ticks(symbol, day, hour)
            if not df.empty:
                frames.append(df)

        if not frames:
            print(f"{symbol}/{key}: NO DATA (market closed?)")
            continue

        import pandas as pd

        ticks = pd.concat(frames, ignore_index=True)
        ticks["time"] = pd.to_datetime(ticks["time"], utc=True)
        win_start_ts = pd.Timestamp(win_start)
        win_end_ts = pd.Timestamp(win_end)
        ticks = ticks[(ticks["time"] >= win_start_ts) & (ticks["time"] <= win_end_ts)]
        ticks = ticks.sort_values("time")

        if ticks.empty:
            print(f"{symbol}/{key}: 0 ticks in window (skipped)")
            continue

        rows = [
            [int(row.time.value // 1_000_000), round(float(row.bid), 5), round(float(row.ask), 5)]
            for row in ticks.itertuples()
        ]
        out_path.write_text(json.dumps(rows, separators=(",", ":")))
        manifest[key] = {
            "eventMs": int(event_time.timestamp() * 1000),
            "windowStartMs": int(win_start.timestamp() * 1000),
            "windowEndMs": int(win_end.timestamp() * 1000),
            "tickCount": len(rows),
        }
        print(f"{symbol}/{key}: {len(rows)} real ticks -> {out_path.name}")

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"{symbol}: done. {len(manifest)}/{len(EVENTS)} events have real tick data.")


def main():
    for symbol in SYMBOLS:
        download_for_symbol(symbol)


if __name__ == "__main__":
    main()

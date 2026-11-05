#!/usr/bin/env python3
"""Download and prepare the historical data consumed by the web app.

The current app supports XAUUSD. Daily tick files are fetched from Dukascopy
using dukascopy-node, converted into compact FXTK tapes and aggregated into
monthly M1 candles. Existing tick tapes are kept and skipped, so rerunning the
command fills missing days and adds newly available history without deleting
local data.

Examples:
    python3 scripts/download_data.py
    python3 scripts/download_data.py --start 2026-03-01 --end 2026-03-31
    python3 scripts/download_data.py --skip-news
    python3 scripts/download_data.py --dry-run
"""
import argparse
import shutil
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from build_tick_candles import build_all as build_all_tick_candles
from download_real_data import build_manifest, download_day

DEFAULT_START = date(2026, 1, 1)


def parse_iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD format") from error


def main() -> int:
    parser = argparse.ArgumentParser(description="Download and prepare XAUUSD historical tick and candle data.")
    parser.add_argument(
        "--start",
        type=parse_iso_date,
        default=DEFAULT_START,
        help=f"first UTC date to download (inclusive; default: {DEFAULT_START.isoformat()})",
    )
    parser.add_argument(
        "--end",
        type=parse_iso_date,
        default=datetime.now(timezone.utc).date() - timedelta(days=2),
        help="last UTC date to download (inclusive; defaults to two days ago to avoid incomplete Dukascopy data)",
    )
    parser.add_argument(
        "--skip-news",
        action="store_true",
        help="do not fetch the separate real-tick windows around scheduled news events",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="list the date range without making network requests or changing files",
    )
    args = parser.parse_args()

    if args.start > args.end:
        parser.error("--start must be on or before --end")

    if not args.dry_run and shutil.which("npx") is None:
        parser.error("Node.js/npm (npx) is required; install Node.js 20 or newer first")

    days = (args.end - args.start).days + 1
    weekdays = sum((args.start + timedelta(days=offset)).weekday() < 5 for offset in range(days))
    print(f"XAUUSD UTC range: {args.start} through {args.end} ({weekdays} weekdays)")
    print("Output: app/public/data/ticks/XAUUSD/ and app/public/data/tick_candles/XAUUSD/")
    if args.dry_run:
        print("Dry run only; no files were downloaded or changed.")
        return 0

    failures: list[date] = []
    current = args.start
    while current <= args.end:
        if current.weekday() < 5:
            if not download_day(current, rebuild_candles=False):
                failures.append(current)
            time.sleep(0.5)
        current += timedelta(days=1)

    build_manifest()
    print("Building monthly M1 candles and candle index from available tick tapes…")
    build_all_tick_candles()

    if not args.skip_news:
        print("Downloading real tick windows around scheduled macro news events…")
        subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "download_news_ticks.py")],
            cwd=ROOT,
            check=True,
        )

    if failures:
        print("Some daily downloads failed: " + ", ".join(day.isoformat() for day in failures), file=sys.stderr)
        print("Rerun this command to retry missing days; already downloaded tapes are skipped.", file=sys.stderr)
        return 1

    print("Historical data is ready for the app.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

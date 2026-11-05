import argparse
import json
from pathlib import Path

from build_tick_candles import build_all as build_all_tick_candles, build_month as build_tick_candle_month
from tick_tape import convert_json_file, parse_raw_day, raw_day_file

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "dukascopy_raw"
OUTPUT_DIR = ROOT / "app" / "public" / "data" / "ticks" / "XAUUSD"


def update_manifest() -> None:
    manifest = {}
    paths = sorted([*OUTPUT_DIR.glob("*.bin"), *OUTPUT_DIR.glob("*.bin.gz")])
    for path in paths:
        day = path.name.removesuffix(".gz").removesuffix(".bin")
        manifest[day] = {"bytes": path.stat().st_size, "compressed": path.suffix == ".gz"}
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert Dukascopy XAUUSD daily tick JSON to compact binary tapes.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--date", help="Convert one UTC date, YYYY-MM-DD")
    group.add_argument("--all", action="store_true", help="Convert every recognized raw day (requires substantial disk space)")
    args = parser.parse_args()

    if args.all:
        days = sorted({day for path in RAW_DIR.glob("temp_*.json*") if (day := parse_raw_day(path)) is not None})
    else:
        from datetime import date

        days = [date.fromisoformat(args.date)]

    failures = 0
    for day in days:
        source = raw_day_file(RAW_DIR, day)
        if source is None:
            print(f"[{day}] raw file not found")
            failures += 1
            continue
        destination = OUTPUT_DIR / f"{day.isoformat()}.bin.gz"
        try:
            count = convert_json_file(source, destination, day)
            if count:
                print(f"[{day}] {count:,} ticks → {destination.stat().st_size / (1024 * 1024):.2f} MiB")
            else:
                print(f"[{day}] empty market day")
        except Exception as error:
            print(f"[{day}] conversion failed: {error}")
            failures += 1

    update_manifest()
    if args.all:
        build_all_tick_candles()
    elif days:
        build_tick_candle_month(days[0].strftime("%Y-%m"))
    if failures:
        raise SystemExit(f"Conversion finished with {failures} failed day(s).")


if __name__ == "__main__":
    main()

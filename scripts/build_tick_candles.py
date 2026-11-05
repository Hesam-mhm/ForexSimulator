"""Build monthly M1 OHLC candles from converted Dukascopy tick tapes."""
import argparse
import gzip
import json
import struct
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAPE_DIR = ROOT / "app" / "public" / "data" / "ticks" / "XAUUSD"
OUTPUT_DIR = ROOT / "app" / "public" / "data" / "tick_candles" / "XAUUSD"
HEADER = struct.Struct("<4sQII")
RECORD = struct.Struct("<Iii")
MINUTE_MS = 60_000


def candles_from_tape(path: Path) -> tuple[str, list[list[float | int]], int]:
    if path.suffix == ".gz":
        with gzip.open(path, "rb") as source:
            tape = source.read()
    else:
        tape = path.read_bytes()

    if len(tape) < HEADER.size:
        raise ValueError(f"{path.name}: truncated header")
    magic, day_start_ms, count, price_scale = HEADER.unpack_from(tape)
    expected_size = HEADER.size + count * RECORD.size
    if magic != b"FXTK" or price_scale <= 0 or len(tape) != expected_size:
        raise ValueError(f"{path.name}: invalid FXTK tape")

    rows: list[list[float | int]] = []
    current_minute = -1
    open_mid = high_mid = low_mid = close_mid = 0
    ticks = 0
    previous_offset = -1
    records = memoryview(tape)[HEADER.size:]
    try:
        for offset_ms, bid, ask in struct.iter_unpack(RECORD.format, records):
            if offset_ms < previous_offset:
                raise ValueError(f"{path.name}: ticks are not sorted")
            previous_offset = offset_ms
            minute_ms = (day_start_ms + offset_ms) // MINUTE_MS * MINUTE_MS
            mid2 = bid + ask
            if minute_ms != current_minute:
                if ticks:
                    rows.append([
                        current_minute,
                        open_mid / (2 * price_scale),
                        high_mid / (2 * price_scale),
                        low_mid / (2 * price_scale),
                        close_mid / (2 * price_scale),
                        ticks,
                    ])
                current_minute = minute_ms
                open_mid = high_mid = low_mid = mid2
                ticks = 1
            else:
                high_mid = max(high_mid, mid2)
                low_mid = min(low_mid, mid2)
                ticks += 1
            close_mid = mid2

        if ticks:
            rows.append([
                current_minute,
                open_mid / (2 * price_scale),
                high_mid / (2 * price_scale),
                low_mid / (2 * price_scale),
                close_mid / (2 * price_scale),
                ticks,
            ])
    finally:
        records.release()
    return path.name[:7], rows, count


def write_month(month: str, rows: list[list[float | int]]) -> dict[str, int | str]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    destination = OUTPUT_DIR / f"{month}.json"
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(rows, separators=(",", ":")), encoding="utf-8")
    temporary.replace(destination)
    return {
        "month": month,
        "file": f"{month}.json",
        "from": int(rows[0][0]),
        "to": int(rows[-1][0]),
        "bars": len(rows),
        "ticks": sum(int(row[5]) for row in rows),
    }


def update_index(months: list[dict[str, int | str]]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "index.json").write_text(
        json.dumps({"intervalMs": MINUTE_MS, "months": months}, indent=2),
        encoding="utf-8",
    )


def build_month(month: str) -> dict[str, int | str] | None:
    rows: list[list[float | int]] = []
    tape_paths = sorted([*TAPE_DIR.glob(f"{month}-*.bin"), *TAPE_DIR.glob(f"{month}-*.bin.gz")])
    for path in tape_paths:
        _, daily_rows, _ = candles_from_tape(path)
        rows.extend(daily_rows)
    if not rows:
        return None

    rebuilt = write_month(month, rows)
    manifest_path = OUTPUT_DIR / "index.json"
    existing = json.loads(manifest_path.read_text(encoding="utf-8"))["months"] if manifest_path.exists() else []
    months = [entry for entry in existing if entry["month"] != month]
    months.append(rebuilt)
    months.sort(key=lambda item: str(item["month"]))
    update_index(months)
    return rebuilt


def build_all() -> list[dict[str, int | str]]:
    by_month: dict[str, list[list[float | int]]] = defaultdict(list)
    total_ticks = 0
    tape_paths = sorted([*TAPE_DIR.glob("*.bin"), *TAPE_DIR.glob("*.bin.gz")])
    for path in tape_paths:
        month, rows, count = candles_from_tape(path)
        by_month[month].extend(rows)
        total_ticks += count
        print(f"[{path.stem}] {count:,} ticks → {len(rows):,} M1 candles")

    manifest = [write_month(month, rows) for month, rows in sorted(by_month.items()) if rows]
    update_index(manifest)
    candle_count = sum(int(month["bars"]) for month in manifest)
    recorded_ticks = sum(int(month["ticks"]) for month in manifest)
    if total_ticks != recorded_ticks:
        raise RuntimeError(f"Tick count mismatch: tapes={total_ticks:,}, candles={recorded_ticks:,}")
    print(f"Wrote {candle_count:,} M1 candles from {recorded_ticks:,} ticks across {len(manifest)} months")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Build XAUUSD M1 candles from converted FXTK tapes.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--all", action="store_true", help="Rebuild all candle months")
    group.add_argument("--month", help="Rebuild one month, YYYY-MM")
    args = parser.parse_args()

    if args.all:
        build_all()
        return

    rebuilt = build_month(args.month)
    if rebuilt:
        print(f"Wrote {rebuilt['bars']:,} M1 candles for {args.month} from {rebuilt['ticks']:,} ticks")
    else:
        print(f"No converted ticks found for {args.month}")


if __name__ == "__main__":
    main()

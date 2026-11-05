import contextlib
import gzip
import json
import re
import struct
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable

MAGIC = b"FXTK"
PRICE_SCALE = 1_000
HEADER = struct.Struct("<4sQII")
RECORD = struct.Struct("<Iii")
MAX_OFFSET_MS = 0xFFFFFFFF


def day_start_ms(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1000)


def raw_day_file(raw_dir: Path, day: date) -> Path | None:
    stem = f"temp_{day.isoformat()}.json"
    for name in (f"{stem}.json", stem):
        path = raw_dir / name
        if path.is_file():
            return path
    return None


def convert_records(records: Iterable[object], output: Path, start_ms: int, count: int) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_output = output.with_suffix(output.suffix + ".tmp")
    previous_ms = -1

    try:
        with temp_output.open("wb") as raw_out:
            compressed = output.suffix == ".gz"
            stream = gzip.GzipFile(fileobj=raw_out, mode="wb", compresslevel=6, mtime=0) if compressed else raw_out
            with stream if compressed else contextlib.nullcontext(stream) as out:
                out.write(HEADER.pack(MAGIC, start_ms, count, PRICE_SCALE))
                for row_number, row in enumerate(records, start=1):
                    if isinstance(row, dict):
                        timestamp = int(row["timestamp"])
                        bid = float(row["bidPrice"])
                        ask = float(row["askPrice"])
                    else:
                        timestamp, bid, ask = row
                        timestamp = int(timestamp)
                        bid = float(bid)
                        ask = float(ask)

                    offset = timestamp - start_ms
                    if offset < 0 or offset > MAX_OFFSET_MS:
                        raise ValueError(f"tick {row_number}: timestamp is outside its UTC day")
                    if timestamp < previous_ms:
                        raise ValueError(f"tick {row_number}: timestamps are not sorted")

                    bid_scaled = round(bid * PRICE_SCALE)
                    ask_scaled = round(ask * PRICE_SCALE)
                    if abs(bid - bid_scaled / PRICE_SCALE) > 1e-7 or abs(ask - ask_scaled / PRICE_SCALE) > 1e-7:
                        raise ValueError(f"tick {row_number}: price has precision finer than 0.001")
                    if not (-0x80000000 <= bid_scaled <= 0x7FFFFFFF and -0x80000000 <= ask_scaled <= 0x7FFFFFFF):
                        raise ValueError(f"tick {row_number}: scaled price is out of int32 range")

                    out.write(RECORD.pack(offset, bid_scaled, ask_scaled))
                    previous_ms = timestamp

        temp_output.replace(output)
        return count
    except Exception:
        temp_output.unlink(missing_ok=True)
        raise


def convert_json_file(source: Path, output: Path, day: date) -> int:
    if source.stat().st_size == 0:
        output.unlink(missing_ok=True)
        return 0
    with source.open("r", encoding="utf-8") as raw_file:
        records = json.load(raw_file)
    if not isinstance(records, list):
        raise ValueError(f"{source} must contain a JSON array")
    if not records:
        output.unlink(missing_ok=True)
        return 0
    return convert_records(records, output, day_start_ms(day), len(records))


def parse_raw_day(path: Path) -> date | None:
    match = re.fullmatch(r"temp_(\d{4}-\d{2}-\d{2})\.json(?:\.json)?", path.name)
    if not match:
        return None
    try:
        return date.fromisoformat(match.group(1))
    except ValueError:
        return None

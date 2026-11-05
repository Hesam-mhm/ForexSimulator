import json
import subprocess
import time
from datetime import date, timedelta
from pathlib import Path

from build_tick_candles import build_month as build_tick_candle_month
from tick_tape import convert_json_file

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "dukascopy_raw"

OUT_DIR = ROOT / "app" / "public" / "data"
TICKS_DIR = OUT_DIR / "ticks" / "XAUUSD"


def download_day(d: date, rebuild_candles: bool = True) -> bool:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    TICKS_DIR.mkdir(parents=True, exist_ok=True)
    # Skip weekends (Saturday=5, Sunday=6)
    if d.weekday() >= 5:
        return True

    day_str = d.strftime("%Y-%m-%d")
    next_day = d + timedelta(days=1)
    next_day_str = next_day.strftime("%Y-%m-%d")

    target_file = TICKS_DIR / f"{day_str}.bin.gz"
    if target_file.exists() and target_file.stat().st_size > 20:
        print(f"[{day_str}] already exists ({target_file.stat().st_size // 1024} KB). Skipping.")
        return True

    temp_fn = f"temp_{day_str}.json"
    temp_path = RAW_DIR / temp_fn

    cmd = [
        "npx",
        "-y",
        "dukascopy-node",
        "-i",
        "xauusd",
        "-from",
        day_str,
        "-to",
        next_day_str,
        "-t",
        "tick",
        "-f",
        "json",
        "-in",
        "-dir",
        str(RAW_DIR),
        "-fn",
        temp_fn,
        "-s",
    ]

    print(f"Downloading ticks for {day_str}...")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            print(f"Error downloading {day_str}: {res.stderr[:200]}")
            return False

        generated_path = temp_path if temp_path.exists() else RAW_DIR / f"{temp_fn}.json"
        if not generated_path.exists():
            print(f"No file generated for {day_str} (market closed / holiday).")
            return True

        count = convert_json_file(generated_path, target_file, d)
        generated_path.unlink(missing_ok=True)
        if not count:
            print(f"Empty data for {day_str}.")
            return True

        if rebuild_candles:
            build_tick_candle_month(day_str[:7])
        print(f"✓ Saved {count:,} ticks for {day_str} ({target_file.stat().st_size // 1024} KB)")
        return True

    except Exception as e:
        print(f"Exception for {day_str}: {e}")
        temp_path.unlink(missing_ok=True)
        (RAW_DIR / f"{temp_fn}.json").unlink(missing_ok=True)
        return False


def build_manifest():
    TICKS_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {}
    paths = sorted([*TICKS_DIR.glob("*.bin"), *TICKS_DIR.glob("*.bin.gz")])
    for p in paths:
        day_key = p.name.removesuffix(".gz").removesuffix(".bin")
        manifest[day_key] = {"bytes": p.stat().st_size, "compressed": p.suffix == ".gz"}

    manifest_path = TICKS_DIR / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Updated tick manifest with {len(manifest)} days.")


def main():
    start_date = date(2026, 1, 1)
    end_date = date.today()

    cur = start_date
    count = 0
    while cur <= end_date:
        success = download_day(cur)
        if success:
            count += 1
            if count % 5 == 0:
                build_manifest()
        cur += timedelta(days=1)
        time.sleep(0.5)

    build_manifest()
    print("All downloads finished!")


if __name__ == "__main__":
    main()

"""Convert monthly OHLC parquet files (data/{SYMBOL}/*.parquet) into compact
JSON the web app can fetch statically (app/public/data/{SYMBOL}_{month}.json),
plus a combined index.json covering every symbol that has local data.
"""
import json
from pathlib import Path

import pandas as pd

from symbols import SYMBOLS

ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = ROOT / "data"
OUT_DIR = ROOT / "app" / "public" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

index = {"symbols": {}}

for symbol in SYMBOLS:
    src_dir = DATA_ROOT / symbol
    if not src_dir.exists():
        continue

    months = []
    for path in sorted(src_dir.glob(f"{symbol}_*.parquet")):
        month_key = path.stem.replace(f"{symbol}_", "")
        df = pd.read_parquet(path).sort_index()

        rows = []
        for ts, r in df.iterrows():
            rows.append([
                int(ts.timestamp() * 1000),
                round(float(r["open"]), 5),
                round(float(r["high"]), 5),
                round(float(r["low"]), 5),
                round(float(r["close"]), 5),
                int(r["ticks"]),
            ])

        out_path = OUT_DIR / f"{symbol}_{month_key}.json"
        out_path.write_text(json.dumps(rows, separators=(",", ":")))

        if rows:
            months.append({
                "month": month_key,
                "from": rows[0][0],
                "to": rows[-1][0],
                "bars": len(rows),
            })
        print(f"{path.name}: {len(rows)} bars -> {out_path.name}")

    if months:
        index["symbols"][symbol] = {"months": months}

index_path = OUT_DIR / "index.json"
index_path.write_text(json.dumps(index, indent=2))
total_months = sum(len(v["months"]) for v in index["symbols"].values())
print(f"Wrote index with {len(index['symbols'])} symbols / {total_months} months -> {index_path}")

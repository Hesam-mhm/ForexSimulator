"""Download Dukascopy tick data and resample it into OHLC bars.

Dukascopy serves raw tick data as hourly ``.bi5`` files (LZMA-compressed,
20 bytes/tick: int32 ms-offset, int32 ask, int32 bid, float32 ask_vol,
float32 bid_vol). This module downloads a date range for a symbol, decodes
the ticks, and resamples them to a target bar size.

Vendored copy for this project (originally from ../Strat_tester) — kept
self-contained so this repo doesn't depend on a sibling project when run
from CI. Sequential-with-a-hard-timeout by design rather than a thread
pool: Dukascopy occasionally trickles bytes slowly enough that no single
socket read exceeds the per-request timeout, but the request never
finishes either — that once hung this same download for 10+ minutes on a
single stuck hour. A thread pool would abandon that stuck worker thread
non-daemon and block the whole process from exiting; a plain daemon thread
per request can be safely left behind instead.

Uses a single shared requests.Session (HTTP keep-alive connection pool)
rather than a fresh urlopen() per request — reconnecting + re-doing the TLS
handshake for every one of the ~24 requests/day this makes was the actual
bottleneck (observed ~10x slower than with a reused connection).
"""

import lzma
import struct
import threading
import time
from datetime import date, datetime, timedelta

import pandas as pd
import requests
import urllib3
from requests.adapters import HTTPAdapter

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
_session = requests.Session()
_session.verify = False  # matches the prior ssl._create_unverified_context behavior
_session.mount("https://", HTTPAdapter(pool_connections=1, pool_maxsize=4))

# Dukascopy price = raw_int / POINT_VALUE. Values below are the standard
# decimal factors used by Dukascopy's own feed metadata.
POINT_VALUE = {
    "XAUUSD": 1000.0,
    "EURUSD": 100000.0,
    "GBPUSD": 100000.0,
    "USDJPY": 1000.0,
    "USDCAD": 100000.0,
    "AUDUSD": 100000.0,
    # Verified empirically: raw ask/bid ints for BTCUSD only make sense as a
    # real BTC price (tens of thousands of USD) and a plausible fixed spread
    # (~$50) when divided by 10, not 1/100/1000.
    "BTCUSD": 10.0,
}

TICK_STRUCT = struct.Struct(">iiiff")
USER_AGENT = "Mozilla/5.0"
MAX_RETRIES = 5
HOUR_TIMEOUT_SEC = 45  # hard wall-clock ceiling per hour-fetch, see module docstring


def _url(symbol: str, day: date, hour: int) -> str:
    return (
        f"https://datafeed.dukascopy.com/datafeed/{symbol}/"
        f"{day.year:04d}/{day.month - 1:02d}/{day.day:02d}/{hour:02d}h_ticks.bi5"
    )


def _fetch(url: str) -> bytes | None:
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = _session.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.content
        except requests.exceptions.HTTPError:
            wait = min(2**attempt, 30)
            time.sleep(wait)
        except (requests.exceptions.RequestException, TimeoutError, ConnectionError):
            wait = min(2**attempt, 30)
            time.sleep(wait)
    return None


def _download_hour_ticks_unbounded(symbol: str, day: date, hour: int) -> pd.DataFrame:
    raw = _fetch(_url(symbol, day, hour))
    if not raw:
        return pd.DataFrame(columns=["time", "bid", "ask"])
    try:
        decompressed = lzma.decompress(raw)
    except lzma.LZMAError:
        return pd.DataFrame(columns=["time", "bid", "ask"])

    point_value = POINT_VALUE[symbol]
    n = len(decompressed) // TICK_STRUCT.size
    if n == 0:
        return pd.DataFrame(columns=["time", "bid", "ask"])

    hour_start = datetime(day.year, day.month, day.day, hour)
    rows = TICK_STRUCT.iter_unpack(decompressed[: n * TICK_STRUCT.size])
    times, bids, asks = [], [], []
    for ms_offset, ask, bid, _ask_vol, _bid_vol in rows:
        times.append(hour_start + timedelta(milliseconds=ms_offset))
        asks.append(ask / point_value)
        bids.append(bid / point_value)
    return pd.DataFrame({"time": times, "bid": bids, "ask": asks})


def download_hour_ticks(symbol: str, day: date, hour: int, timeout: float = HOUR_TIMEOUT_SEC) -> pd.DataFrame:
    result = {"df": pd.DataFrame(columns=["time", "bid", "ask"])}

    def run():
        result["df"] = _download_hour_ticks_unbounded(symbol, day, hour)

    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(timeout=timeout)
    if th.is_alive():
        print(f"  ! {symbol} {day} {hour:02d}h timed out after {timeout}s, skipping this hour")
        return pd.DataFrame(columns=["time", "bid", "ask"])
    return result["df"]


def download_symbol_range(symbol: str, start: date, end: date) -> pd.DataFrame:
    frames = []
    current = start
    while current <= end:
        for hour in range(24):
            df = download_hour_ticks(symbol, current, hour)
            if not df.empty:
                frames.append(df)
        current += timedelta(days=1)
    if not frames:
        return pd.DataFrame(columns=["time", "bid", "ask"])
    return pd.concat(frames, ignore_index=True)


def ticks_to_ohlc(ticks: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    if ticks.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "ticks"])
    ticks = ticks.copy()
    ticks["mid"] = (ticks["bid"] + ticks["ask"]) / 2.0
    ticks = ticks.set_index(pd.DatetimeIndex(ticks["time"])).sort_index()
    ohlc = ticks["mid"].resample(timeframe).ohlc()
    ohlc["ticks"] = ticks["mid"].resample(timeframe).count()
    ohlc = ohlc.dropna(subset=["open"])
    return ohlc


def month_ranges(start: date, end: date):
    cur = date(start.year, start.month, 1)
    while cur <= end:
        if cur.month == 12:
            nxt = date(cur.year + 1, 1, 1)
        else:
            nxt = date(cur.year, cur.month + 1, 1)
        month_start = max(cur, start)
        month_end = min(nxt - timedelta(days=1), end)
        yield month_start, month_end
        cur = nxt

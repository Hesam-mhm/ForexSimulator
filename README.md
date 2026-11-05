# Forex Historical Price Simulator

A browser-based, **demo-only** trading simulator for replaying historical XAUUSD (gold) prices. It combines tick-derived one-minute candles, optional real tick replay, a charting workspace, simulated orders, account/risk metrics, and a backtest dashboard.

> **Disclaimer:** This project is an educational/backtesting tool, not a broker and not investment advice. Orders are simulated and are never sent to a real exchange or broker. Historical performance does not predict future results.

## Contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Run locally](#run-locally)
- [Download historical data](#download-historical-data)
- [Data layout and behavior](#data-layout-and-behavior)
- [Using the simulator](#using-the-simulator)
- [Build and preview](#build-and-preview)
- [Deploy to GitHub Pages](#deploy-to-github-pages)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Data, licensing, and privacy](#data-licensing-and-privacy)

## Highlights

### Historical chart and replay

- XAUUSD history built from Dukascopy bid/ask ticks and aggregated into M1, M5, M15, H1, H4, D1, and W1 chart timeframes.
- Play, pause, step forward/backward, choose replay speed, zoom, and jump to scheduled macroeconomic events.
- When a daily tick tape is available, replay uses real ticks for more detailed intra-candle prices. Otherwise, the simulator uses its candle-based price path.
- All chart, simulation, event, and trade timestamps use **UTC**.

### Trading and account simulation

- Simulated market, limit, and stop orders with configurable lot size and leverage.
- Demo positions with editable stop-loss and take-profit levels, floating P/L, balance, equity, used/free margin, and margin level.
- Risk-based lot sizing and automatic stop-out protection.
- Multiple local demo accounts, trade history, and account performance summaries.

### Chart workspace

- Candlesticks with VWAP, EMA, RSI, and ATR indicators.
- Drawing tools include trendlines, rays, horizontal lines/rays, rectangles, measurements, notes, Fibonacci target levels, and Long/Short position risk-reward zones.
- Drawings and account state are saved in browser `localStorage`; they are not synced between browsers or devices.

### Macro news

- FOMC, NFP, and CPI events are listed in the in-app calendar.
- Optional event-specific real tick windows can be downloaded to replay market activity around supported events.

## Requirements

- Node.js 20 or newer (includes `npm` and `npx`).
- Python 3.10 or newer for data scripts.
- Internet access to fetch market history from Dukascopy.
- Enough free disk space for the tick tapes. The current data set is roughly **438 MB** under `app/public/data` at the time this README was written; the size grows with the selected date range and downloaded news windows.

## Run locally

Clone the repository, then from its root:

```bash
# Create and activate a Python virtual environment
python3 -m venv .venv
source .venv/bin/activate       # Windows PowerShell: .venv\Scripts\Activate.ps1

# Install Python dependencies used by the data tools
python -m pip install --upgrade pip
python -m pip install -r scripts/requirements.txt

# Download/generate the app's local market data (see options below)
python3 scripts/download_data.py

# Install and start the frontend
cd app
npm ci
npm run dev
```

Open the local URL printed by Vite. The configured development port is `3001` (Vite may select another port if it is already occupied).

The data download is intentionally separate from `npm ci`: a fresh checkout does not contain the large generated market-data files. If the app reports that history is unavailable, run `python3 scripts/download_data.py` from the repository root and reload the page.

## Download historical data

The app's current supported instrument is **XAUUSD**. The unified downloader is:

```bash
python3 scripts/download_data.py
```

By default it:

1. Downloads weekday tick data from **2026-01-01** through two days ago (UTC), avoiding the provider's potentially incomplete latest data.
2. Skips tick tapes that already exist, so rerunning the command fills missing dates and fetches newly available dates.
3. Converts the downloaded data to compressed `FXTK` tick tapes.
4. Rebuilds monthly M1 candles and their index from the available tapes.
5. Downloads the configured real-tick windows around scheduled news events.

The downloader uses `npx dukascopy-node` to fetch tick data. It may take a while on a fresh checkout and needs a working Node.js installation and network connection.

### Date range and options

```bash
# Fetch one month; end dates are inclusive and interpreted as UTC
python3 scripts/download_data.py --start 2026-03-01 --end 2026-03-31

# Check the requested range without downloading or writing output
python3 scripts/download_data.py --dry-run --start 2026-03-01 --end 2026-03-31

# Download candles/tick tapes but skip separate news-event tick windows
python3 scripts/download_data.py --skip-news

# Combine options
python3 scripts/download_data.py --start 2026-01-01 --end 2026-06-30 --skip-news
```

Existing valid daily tapes are not replaced automatically. To repair a corrupt tape, remove that specific local file under `app/public/data/ticks/XAUUSD/` and rerun the downloader for its date. The script records individual failures and exits non-zero so the failed days can be retried.

### Lower-level data tools

These are available for maintenance and data-pipeline work:

| Script | Purpose |
| --- | --- |
| `scripts/download_data.py` | Main resumable downloader and data-preparation command. |
| `scripts/download_real_data.py` | Low-level Dukascopy daily tick downloader used by the main script. |
| `scripts/tick_tape.py` | Converts raw daily tick JSON into the compact binary `FXTK` tape format. |
| `scripts/build_tick_candles.py` | Builds monthly M1 candles from local XAUUSD tick tapes. |
| `scripts/download_news_ticks.py` | Fetches real tick windows around events listed in the script. |
| `scripts/dukascopy_downloader.py` | Hourly Dukascopy download/decode helpers used by the parquet-based data tools. |
| `scripts/backfill_symbol.py` / `scripts/backfill_month.py` | Historical parquet backfill helpers. |
| `scripts/convert_data.py` | Converts local parquet candles to the legacy/static symbol JSON format. |
| `scripts/update_candles.py` | Refreshes existing parquet candle history; it requires local parquet files to update. |

## Data layout and behavior

Generated data is deliberately excluded from Git; the downloader recreates the files the frontend serves statically:

```text
app/public/data/                 # Generated runtime assets; gitignored
├── tick_candles/XAUUSD/
│   ├── index.json                # Monthly candle manifest consumed by the app
│   └── YYYY-MM.json              # Tick-derived M1 OHLC candles
├── ticks/XAUUSD/
│   ├── YYYY-MM-DD.bin.gz         # Compressed real tick tape, fetched lazily during replay
│   └── manifest.json
└── news_ticks/XAUUSD/
    ├── EVENT_YYYY-MM-DD.json    # Optional event-window bid/ask ticks
    └── manifest.json

data/                            # Local scratch / parquet data; gitignored
└── dukascopy_raw/                # Temporary raw download files
```

The browser loads the monthly M1 candles up front and requests real tick tapes for the simulation day on demand. If a tape is missing for a day, the app can still display its candles and continue with candle-based intra-bar simulation. News tick windows are an additional optional enhancement.

`data/` may contain local parquet archives used by the maintenance/backfill scripts. These are not needed by the current XAUUSD-only browser loader when the generated `app/public/data/tick_candles/XAUUSD/` files are present.

## Using the simulator

1. Select or create a demo account on the dashboard.
2. Choose a historical starting date/time and start the backtest. Existing accounts resume from their saved progress (or just after their most recent trade, if that is later).
3. Use the floating replay controls to play/pause, step through time, choose step size/speed, save progress, or jump to the next 06:00 UTC point.
4. Place simulated market or pending orders from the chart/trading panel. Adjust SL/TP lines on the chart and monitor positions in the Trade Terminal.
5. Use the drawing toolbar to annotate the chart. Long/Short position tools use the entry point followed by a stop point and display a default 1:2 risk/reward zone.

Useful keyboard shortcuts:

- `Space`: play/pause replay (when focus is not in a form control).
- `V`: cursor/select drawing tool.
- `Alt+T`: trendline.
- `Alt+H`: horizontal line.
- `Alt+J`: horizontal ray.
- `Delete` / `Backspace`: delete the selected drawing.
- `Escape`: cancel the current drawing or clear the selection.

## Build and preview

From the `app/` directory:

```bash
npm ci
npm run build
npm run preview
```

`npm run build` runs the TypeScript project build and creates the production bundle in `app/dist/`. Run the data downloader from the repository root before building if `app/public/data/` is not already populated.

For a root-domain preview (for example, a custom domain), set the base path explicitly when building:

```bash
VITE_BASE_PATH=/ npm run build
```

## Deploy to GitHub Pages

The repository includes GitHub Actions workflows that build and deploy the site:

- `Deploy to GitHub Pages` runs on pushes to `main` and can also be run manually.
- `Refresh and deploy market data` is a manual workflow for rebuilding the ignored data and publishing it again.

To publish from your own public repository:

1. Push the project to the repository's `main` branch.
2. In GitHub, open **Settings → Pages** and select **GitHub Actions** as the build/deployment source.
3. Confirm Actions are enabled for the repository, then run the `Refresh and deploy market data` workflow once (or push to `main`).
4. The deployment workflow prepares data on the runner, builds the frontend, and deploys `app/dist/` to Pages. It automatically uses `/<repository-name>/` as the project-site base path.
5. For a user/organization Pages site or a custom domain served at `/`, change `VITE_BASE_PATH` in `.github/workflows/deploy.yml` from the repository path to `/`.

**Important deployment trade-off:** the data is not checked into Git, so a clean GitHub Actions runner must download it again when building the site. This can make deployments take a while and produces a large Pages artifact. Check GitHub Pages artifact/site size and bandwidth limits before publishing the full tick-tape archive. If those limits become a problem, host `app/public/data/` on a separate static object store/CDN and configure the app's data base URL accordingly.

The automatic `push` deployment also prepares the data on each build. The manual refresh workflow is useful when the upstream feed has published additional dates and you want to rebuild the deployed data without changing application code.

## Project layout

```text
.
├── .github/workflows/
│   ├── deploy.yml                 # Build and deploy to GitHub Pages
│   └── update-data.yml            # Manually refresh data and deploy
├── app/
│   ├── public/data/               # Generated/ignored market data
│   ├── src/
│   │   ├── components/            # Chart, dashboard, account and order UI
│   │   ├── engine/                # Historical playback and price engine
│   │   ├── hooks/                 # Account state and trading behavior
│   │   ├── indicators/            # Indicator calculations and session levels
│   │   ├── utils/                 # Formatting and account performance helpers
│   │   ├── App.tsx                # Main application composition
│   │   └── data.ts                # Static market-data loader
│   ├── package.json
│   └── vite.config.ts
├── data/                          # Ignored local parquet/raw data
├── scripts/                       # Data download, conversion and maintenance tools
└── README.md
```

## Troubleshooting

### “Historical data unavailable” or an empty chart

Run the downloader from the repository root and reload:

```bash
python3 scripts/download_data.py
```

Check that `app/public/data/tick_candles/XAUUSD/index.json` exists and lists one or more monthly files.

### `npx` is not found

Install Node.js 20 or newer, open a new terminal, and verify:

```bash
node --version
npm --version
npx --version
```

### Download failures or missing days

Dukascopy may not publish a file for a market holiday, may publish recent data with a delay, or the connection may time out. Rerun the same command to retry missing dates. The downloader skips completed tapes and reports dates that failed.

### GitHub Pages returns 404 for JavaScript or data files

Check **Settings → Pages** and confirm the site was deployed by Actions. For a project site, keep `VITE_BASE_PATH` set to `/<repository-name>/`; for a root/custom domain, set it to `/` and rebuild.

### A large data directory is still shown by Git

`.gitignore` prevents new untracked files from being added, but it does not untrack files already committed. Remove previously tracked data from the index while retaining local files, then commit that removal:

```bash
git rm -r --cached --ignore-unmatch data app/public/data
git add .gitignore
```

This does **not** erase data from older Git commits. If the repository's existing history contains large market-data blobs and you need to keep them out of a new public repository, publish from a clean repository/history or deliberately rewrite the history before pushing.

## Data, licensing, and privacy

- Historical price data is fetched from Dukascopy. Review the provider's current terms and confirm that your intended use and redistribution are allowed before making the resulting dataset publicly available.
- The generated price and tick files are excluded from Git, but a GitHub Pages deployment serves them publicly to site visitors.
- The app has no trading backend and sends no orders. Account state, trades, and drawings are stored locally in the visitor's browser via `localStorage`.
- No API keys or broker credentials are required by the current app or data scripts.
- The repository does not currently provide a software license. Add a license file before inviting reuse if you want to grant others explicit permissions to use, modify, or redistribute the code.

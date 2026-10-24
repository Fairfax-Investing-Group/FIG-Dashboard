# Stock Study

React + TypeScript frontend with a local Python backend. Search for a company, then click it to create a study. Creation immediately requests SEC Company Facts, Yahoo company/statement/analyst data, and ten years of daily price history using the Python `yfinance` package. There are no sample financial figures or fabricated price fallbacks. Expanded pulls can also collect up to three Yahoo industry peer candidates; see [field coverage](docs/data-coverage.md).

## Setup and run

Requires Node.js 20.19+ (or 22.12+) and Python 3.9+.

```sh
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev
```

`npm run dev` starts both the Python API (port 8000) and Vite (usually port 5173). Open the URL Vite prints. Both processes stop with Ctrl+C.

For SEC requests, configure an identifying user agent with your own contact address before starting:

```sh
export SEC_USER_AGENT="StockStudy your-contact@example.com"
npm run dev
```

The default identifies this local research app. SEC may block requests without adequate contact identification or rate-limit an IP; the UI reports upstream failures and lets you retry. No API keys are required. Set `API_PORT` to use another backend port; the Vite proxy uses the same value.

## What a study shows

- Sales, diluted EPS, and pre-tax profit: up to ten available **full fiscal years** within the last decade, from SEC Company Facts.
- Price: trailing ten years of daily Yahoo Finance closing prices, fetched with `yfinance.Ticker.history(auto_adjust=False)`. Yahoo's close reflects splits but is not adjusted for dividends. The price chart shows its actual coverage and quote currency.
- One overlaid chart compares sales, split-normalized EPS, pre-tax profit, and split-adjusted stock price on a shared date axis. Each series is indexed internally to its first nonzero value, then scaled independently within overlapping vertical bands for trend comparison. All series use logarithmic scales (symmetric log for series with zero or negative values) with equal vertical room, preserving each line’s shape without compressing smaller series. Compare direction and shape; slopes do not represent comparable growth rates. The Y-axis shows color-matched series names and guide lines without numeric labels; vertical heights do not represent comparable amounts. Base dates are shown below the chart. The chart uses green sales, magenta EPS, blue pre-tax profit, annual markers, and a muted daily price line on a yearly grid. Sales, EPS, and pre-tax profit also show solid translucent log-linear regression fits across their observed historical range, with annual fitted growth in the legend. Fits require at least two positive fiscal years and no zero/negative observations. Actual and regression lines have independent visibility buttons. Click a plotted line or use Inspect line to focus it, then Show only this line to isolate and expand its vertical view; Show all restores the comparison. Hovering near a rendered line prioritizes visible actual data within the hover radius over regression lines, choosing the nearest actual line when several qualify, then shows that line alone in the tooltip. Actual lines snap to yearly observations; regression hovers follow the cursor continuously, using log-space fitted values within the historical range. Actual and fitted amounts are labeled separately; prices retain their nearest daily close. Missing segments are not hover targets. Hovering or selecting a line does not dim other lines; only explicit visibility controls hide them. Logarithms are applied before vertical spacing so chart offsets preserve each series’ logarithmic shape. Hover details show actual values and currencies; annual financials retain their fiscal dates and missing-value gaps alongside daily prices.
- A Fundamental Company Data table underneath the combined chart, with fiscal years across columns and sales, split-normalized EPS, and pre-tax profit in rows. Sales and profit are shown in millions. Historical values link to SEC filings; hover a year for its fiscal end date. Sales, EPS, and pre-tax profit growth use least-squares linear regression of ln(value) against fiscal year, converted to annual percentage growth as 100 × (exp(slope) − 1). At least two distinct fiscal years are required. Missing values are skipped while retaining year gaps; any zero or negative observation makes the metric’s growth unavailable. Blank sales/EPS forecast inputs accept annual percentage assumptions and calculate five-year estimates from the latest available value; forecasts are local to the open study view.
- Source retrieval timestamps, missing-data notices, and retry/refresh controls.

Each creation/refresh makes new upstream requests and saves a separate snapshot in `.data/studies.sqlite3` (ignored by Git). Reloading a study's `#/study/<id>` URL reads that snapshot rather than silently fetching new data. Refresh creates and opens a new snapshot. These local URLs work while this backend and its database are available; snapshots are not cloud-shared. Set `STUDY_DB` to change the database path.

## Normalized study JSON

The API and new saved snapshots use a versioned document matching the supplied study structure: `Study`, `Company`, `AnnualData`, `QuarterlyData`, `ComputedValues`, `MonthlyPrices`, and related sections. Use **Export JSON** on a study to download it. `GET /api/studies/<id>` returns the same document. Legacy snapshots are adapted on read without upstream requests or rewriting the original snapshot.

Company totals (`Sales`, `PTP`, and their aliases) are in millions. EPS and prices retain per-share units; all rates are decimal fractions (0.182 means 18.2%). Dates use ISO 8601. Split-normalization status, currencies, units, warnings, and source information are under `Metadata`. Expanded SEC statements, Yahoo company/analyst data, and a bounded industry peer sample populate available fields. Unsupported fields are `null`; unavailable collections are empty. `Metadata.FieldCoverage` lists gaps and provider/user-only fields. Set `STUDY_PEER_LIMIT=0` to disable peers, or 1–5 to bound the sample (default 3). The supplied company's values, provider IDs, judgments, notes, and forecasts are never used as defaults. See [the data contract](docs/study-data.md).

## Financial normalization

`server/financials.py` accepts annual-report facts (10-K, 20-F, 40-F, and amendments) with full-year durations of 330–380 days, excluding quarterly/YTD, nonfinite, and future facts. Annual periods before January 1 of the year ten years ago are excluded, so stale issuers cannot silently show older decades. It groups by the **actual reporting period end**, not the SEC `fy` field of the filing, which can contain comparative periods.

Standard US GAAP and IFRS revenue, diluted EPS, and income-before-tax concepts are selected in documented priority order. Within a selected concept/period, the most recently filed value is used, including restated comparatives. Period dates and original concept/unit/accession/filing date remain attached to each value. One reporting currency is used for the financial series; currencies are never added or converted. Pre-tax profit generally covers continuing operations, depending on the issuer's standard tag.

EPS is **split-normalized diluted EPS** in both the chart and table. The yfinance request includes split events from January 1 of the oldest financial year through study creation. The calculation treats each SEC source filing as already reflecting splits through its filing date and divides its EPS by the cumulative new-shares/old-shares ratio of later splits (including reverse splits). This avoids double-adjusting restated comparatives. The filing date is the share-basis reference; unusual recapitalizations or changes already reflected ahead of their split effective date may require manual verification. The EPS normalization step starts from the original SEC value to avoid repeat adjustments. The canonical study retains the applied divisor and filing provenance; its EPS field contains only split-normalized values. Missing or invalid split history, missing source filing dates, and filing dates outside split-history coverage produce unavailable EPS, never a reported-value fallback. This rule also applies when loading older saved studies; refresh to obtain normalized EPS. Chart points, latest values, tooltips, and table cells all use the same normalized series. Stock prices use Yahoo’s split-adjusted close; total sales and pre-tax profit are unaffected by stock splits. Missing facts remain null and render as gaps/“—”, never zero. Companies reporting only custom XBRL concepts, some financial institutions, funds, or issuers with limited filing history may have incomplete data. Source failures preserve whichever other data is available.

## Checks and production

```sh
npm test
npm run build
npm start
```

`npm test` checks annual-period selection, restatements, unit/currency handling, missing data, snapshot persistence, fresh requests on every creation, forward/reverse splits, preservation of already-restated EPS, and normalization idempotence. `npm start` serves the built `dist/` frontend and API together at http://127.0.0.1:8000. `npm run preview` previews the frontend only and needs a separately running backend. This is a local app; remote hosting requires a Python-capable backend host.

## Sources

- Search directory snapshot: https://www.sec.gov/files/company_tickers_exchange.json (bundled in `public/companies.json`; replace with the latest JSON to refresh search coverage).
- Financial API: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- Price client: https://github.com/ranaroussi/yfinance

## Files

- `src/SearchPage.tsx`: company search.
- `src/StudyPage.tsx`: charts and financial table.
- `src/App.tsx`: navigation and study creation/loading.
- `server/app.py`: HTTP API and static serving.
- `server/studies.py`: source requests and snapshot persistence.
- `server/financials.py`: SEC annual financial normalization.

## Daily homepage portfolio updates

The Python server runs a background portfolio updater automatically. It refreshes
15 minutes after each NYSE session closes (normally 4:15 p.m. Eastern, 1:15 p.m.
on early-close days), skips exchange holidays/weekends, and catches up on startup.
Keep the server running for scheduled updates; an open browser is not required.
The homepage checks the stored result every minute while visible.

Workbook transactions and cash remain in `src/data/portfolio.json`. Yahoo Finance
regular-session closing prices update holdings, partner pitch records, market
pulse, indexes, 52-week ranges, returns, and history. Cost bases and purchase dates
are preserved; share counts adjust for splits after the imported snapshot. Future
returns assume no new purchases, sales, cash flows, or dividend reinvestment until
the source transactions are changed. The benchmark continues the workbook's
starting basis; existing workbook return history is retained before the import date.

Completed updates are atomically persisted in `.data/portfolio.json` (override
with `PORTFOLIO_CACHE`). All instruments must have the same completed session;
failed/incomplete updates retain the previous snapshot and retry after five
minutes. A changed source workbook invalidates the cache. To import a revised
workbook, run `python3 scripts/importDashboard.py path/to/workbook.xlsx`.

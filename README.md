# Stock Study

React + TypeScript frontend with a local Python backend. Search for a company, then click it to create a study. Creation immediately requests SEC Company Facts and ten years of daily price history using the Python `yfinance` package. There are no sample financial figures or price fallbacks.

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
- A financial table underneath the four charts, with exact values, fiscal period end dates, sort order, and links to source filings. Hover a value to inspect its SEC concept and filing date.
- Source retrieval timestamps, missing-data notices, and retry/refresh controls.

Each creation/refresh makes new upstream requests and saves a separate snapshot in `.data/studies.sqlite3` (ignored by Git). Reloading a study's `#/study/<id>` URL reads that snapshot rather than silently fetching new data. Refresh creates and opens a new snapshot. These local URLs work while this backend and its database are available; snapshots are not cloud-shared. Set `STUDY_DB` to change the database path.

## Financial normalization

`server/financials.py` accepts annual-report facts (10-K, 20-F, 40-F, and amendments) with full-year durations of 330–380 days, excluding quarterly/YTD, nonfinite, and future facts. Annual periods before January 1 of the year ten years ago are excluded, so stale issuers cannot silently show older decades. It groups by the **actual reporting period end**, not the SEC `fy` field of the filing, which can contain comparative periods.

Standard US GAAP and IFRS revenue, diluted EPS, and income-before-tax concepts are selected in documented priority order. Within a selected concept/period, the most recently filed value is used, including restated comparatives. Period dates and original concept/unit/accession/filing date remain attached to each value. One reporting currency is used for the financial series; currencies are never added or converted. Pre-tax profit generally covers continuing operations, depending on the issuer's standard tag.

EPS is **reported diluted EPS**, not uniformly rebased for subsequent stock splits. Older values can use different share bases; this is called out in the chart and table. Missing facts remain null and render as gaps/“—”, never zero. Companies reporting only custom XBRL concepts, some financial institutions, funds, or issuers with limited filing history may have incomplete data. Source failures preserve whichever other data is available.

## Checks and production

```sh
npm test
npm run build
npm start
```

`npm test` checks annual-period selection, restatements, unit/currency handling, missing data, snapshot persistence, and fresh requests on every creation. `npm start` serves the built `dist/` frontend and API together at http://127.0.0.1:8000. `npm run preview` previews the frontend only and needs a separately running backend. This is a local app; remote hosting requires a Python-capable backend host.

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

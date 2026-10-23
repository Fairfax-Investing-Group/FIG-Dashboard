# Study data contract (version 1)

`GET /api/studies/<uuid>` and `POST /api/studies` return this document. New snapshots store the same JSON in SQLite. Older snapshots are converted when read, with no upstream requests and no overwrite of the original stored data. The study page's **Export JSON** link downloads the canonical document.

The supplied example defines the section and field names. Its company values, provider identifiers, user information, notes, and forecasts are not imported or used as defaults.

## Sections

| Section | Contents |
| --- | --- |
| `SchemaVersion` | Integer `1`; version of this application's data contract. |
| `Study` | Study UUID, ticker, name, creation timestamp, and judgment/projection field names from the reference. Unavailable judgments remain null. |
| `Company` | Ticker, SEC CIK, company name, exchange, latest observed split-adjusted close/date, fiscal year/month, and the reference's other company field names. |
| `AnnualData` | Ascending fiscal-year records with the reference's annual field names. Income, balance-sheet, cash-flow, shares, dividends, price ranges, and derived ratios are populated when their source inputs exist. `EPSSplitFactor` and `Sources` record adjustment/provenance. |
| `ComputedValues` | `GrowthMethod`, `SalesGrowthRate`, `EPSGrowthRate`, and `PTPGrowthRate`. Growth uses log-linear regression over all available fiscal years. |
| `DailyPrices` | Added daily series: `{ "Date": "YYYY-MM-DD", "Close": number }`. |
| `MonthlyPrices` | Last observed close in each calendar month: `{ "Month": "YYYY-MM", "Date": "YYYY-MM-DD", "Close": number }`. The last month can be incomplete. These are closing-price samples, not monthly highs/lows or OHLC bars. |
| `Metadata` | Currencies, unit conventions, split policy/status/events, source URLs/status/retrieval timestamps, warnings, and unavailable sections. |
| `ScaleFactors` | Dashboard log-space scaling coefficients for available series; unavailable factors remain null. These are our chart coefficients, not the original provider’s factors or monetary unit conversions. |
| `QuarterlyData` | Standalone quarters from SEC, with YTD differences for additive monetary flows. Quarterly EPS and weighted shares are never inferred by subtracting annual/YTD EPS or share counts. |
| `Peers`, `PeerGroupAverage` | Up to three Yahoo industry candidates with SEC coverage, plus an explicitly labeled sample average. Currency mismatches are excluded from averages. Membership and counts are in metadata. |
| `IndustryAverage` | Empty: the sources do not provide the full historical industry universe needed to recreate the reference’s industry averages. |
| `AnalystEstimates` | Available current/next annual Yahoo consensus estimates and analyst counts, anchored to the provider’s fiscal-year end. Missing future years are not invented. |
| `IndustryAvgsAndRates`, `PeerGroupAvgsAndRates` | Industry rates remain null; peer sample rates use log-linear regression of sample-average history and arithmetic historical averages, with the method documented. |
| `CompanyTK6`, `StudyAudit` | Null. |
| `LegendSeries`, `Notes` | Plot series names/colors; notes remain empty because they are user-authored inputs. |

## Units and missing data

- `AnnualData[].Sales`, `PTP`, `TotalRevenue`, and `PretaxIncome` are **millions of the reporting currency**, without rounding. Sales of 90,272,000,000 USD become `90272`.
- `EPS` is diluted earnings per share in reporting currency/share. It is always split-normalized through `Metadata.EPSAdjustment.AsOf`, or null if verification is unavailable. `EPSSplitFactor` is the divisor applied to the original SEC fact. No reported-EPS fallback is exported.
- `PtpOnSales` and `*GrowthRate` values are **decimal fractions**, not percentages. `0.182` displays as `18.2%`.
- `Company.ClosingPrice`, `DailyPrices[].Close`, and `MonthlyPrices[].Close` use `Metadata.PriceCurrency` per share. Yahoo closes reflect stock splits but not dividend adjustments. Price and reporting currencies may differ; no currency conversion is performed.
- Fiscal period dates and prices use `YYYY-MM-DD`; creation and retrieval timestamps use ISO 8601 timestamps. A company's fiscal year is labeled by its period-end calendar year, as in the existing annual financial normalizer.
- Missing numeric values and unsupported flags are null, not zero or false. A true zero stays zero. Unknown lists are empty. `NoDataForYear` is true only when all three supported annual metrics are missing.
- `TotalRevenue` aliases `Sales` and `PretaxIncome` aliases `PTP`; do not add aliases together.
- `Metadata.UnavailableSections` describes unsupported datasets. Other unsupported scalar fields in `Company` and `AnnualData` remain null; coverage is issuer- and provider-dependent. See `Metadata.FieldCoverage` and [the source coverage guide](data-coverage.md).

## Growth and forecasts

For each metric, fit `ln(value) = intercept + slope × FiscalYear`, then store `exp(slope) − 1`. At least two distinct fiscal years are required. Missing observations are skipped while preserving actual year gaps. Any zero or negative observation makes the log-linear growth rate unavailable.

Forecast inputs in the table are view-local user assumptions. They are not fetched analyst estimates or saved study judgments, and are not written to `Study.Proj*` or `AnalystEstimates`. The five-year estimate remains `latest value × (1 + user rate)^5`.

## Source provenance

Each annual record has `Sources.Sales`, `Sources.EPS`, and `Sources.PTP`, containing `Concept`, `Filed`, `Accession`, `Unit`, `Start`, and `End`. These describe the original SEC fact. Its original `Unit` may be `USD`, while the normalized `Sales` field uses millions of USD. The original source unit is not the output unit.

`Metadata.Sources.SEC` and `YahooFinance` contain `Status`, `URL`, `RetrievedAt`, and `Error`. Upstream failures preserve data from the successful source and leave affected values unavailable.

## Frontend adapter

`src/studyDocument.ts` is the sole conversion boundary into the existing chart/table view model. It converts company totals back to base currency amounts for the current rendering helpers and decimal growth rates to displayed percentages. Components do not read raw upstream responses or independently guess units. API/storage values remain in the documented normalized units.


## Additional source conventions

- SEC Company Facts supplies standard US GAAP/IFRS duration and instant facts; SEC submissions supplies SIC. Standard tags vary by issuer. Yahoo annual/quarterly statements fill missing monetary facts when their reporting currency matches. If SEC is unavailable, Yahoo monetary statements can form a smaller annual/quarterly history; historical EPS/share-count data with an unverified split basis remain unavailable.
- Every share-count and per-share SEC fact uses its own source filing date for split adjustment. Share counts multiply by subsequent splits; per-share values divide. Derived book value and cash flow per share use the adjusted denominator.
- Annual/quarterly high and low prices use actual intraday Yahoo highs/lows, adequate period coverage, and matching currencies. High/low P/E is unavailable when EPS is nonpositive.
- `SectorCode` and `IndustryCode` contain Yahoo classification keys, not Morningstar numeric codes. `InsiderOwnershipPct` and `InstitutionalOwnershipPct` use percentage points, as explicitly stated in `Metadata.Units.OwnershipPercentages`; ratios and growth rates remain decimal fractions.
- Yahoo estimates and current quote dividends are on the provider’s current share basis as of retrieval. Their source and basis are recorded; no historical SEC filing adjustment is applied to them.
- `Metadata.Calculations` defines free-cash-flow-per-share, debt-to-capital, ROE, tax, quick ratio, and interest coverage. These calculations may differ from Morningstar’s definitions and exclusions.

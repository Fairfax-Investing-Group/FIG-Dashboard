# Study data contract (version 1)

`GET /api/studies/<uuid>` and `POST /api/studies` return this document. New snapshots store the same JSON in SQLite. Older snapshots are converted when read, with no upstream requests and no overwrite of the original stored data. The study page's **Export JSON** link downloads the canonical document.

The supplied example defines the section and field names. Its company values, provider identifiers, user information, notes, and forecasts are not imported or used as defaults.

## Sections

| Section | Contents |
| --- | --- |
| `SchemaVersion` | Integer `1`; version of this application's data contract. |
| `Study` | Study UUID, ticker, name, creation timestamp, and judgment/projection field names from the reference. Unavailable judgments remain null. |
| `Company` | Ticker, SEC CIK, company name, exchange, latest observed split-adjusted close/date, fiscal year/month, and the reference's other company field names. |
| `AnnualData` | Ascending fiscal-year records with the reference's annual field names. Supported values are `FiscalYear`, `Sales`, `EPS`, `PTP`, `PtpOnSales`, `TotalRevenue`, `PretaxIncome`, `AsOfDataDate`, `NoDataForYear`, and the added `EPSSplitFactor` and `Sources`. |
| `ComputedValues` | `GrowthMethod`, `SalesGrowthRate`, `EPSGrowthRate`, and `PTPGrowthRate`. Growth uses log-linear regression over all available fiscal years. |
| `DailyPrices` | Added daily series: `{ "Date": "YYYY-MM-DD", "Close": number }`. |
| `MonthlyPrices` | Last observed close in each calendar month: `{ "Month": "YYYY-MM", "Date": "YYYY-MM-DD", "Close": number }`. The last month can be incomplete. These are closing-price samples, not monthly highs/lows or OHLC bars. |
| `Metadata` | Currencies, unit conventions, split policy/status/events, source URLs/status/retrieval timestamps, warnings, and unavailable sections. |
| `ScaleFactors` | Field names retained, values null. These are provider-specific chart positioning factors, not monetary unit conversions. The dashboard calculates its own plot coordinates. |
| `QuarterlyData`, `Peers`, `IndustryAverage`, `PeerGroupAverage`, `AnalystEstimates` | Empty arrays: the current fetchers do not supply these datasets. |
| `IndustryAvgsAndRates`, `PeerGroupAvgsAndRates` | Reference field names with null values; no peer or industry values are inferred. |
| `CompanyTK6`, `StudyAudit` | Null. |
| `LegendSeries`, `Notes` | Empty arrays. |

## Units and missing data

- `AnnualData[].Sales`, `PTP`, `TotalRevenue`, and `PretaxIncome` are **millions of the reporting currency**, without rounding. Sales of 90,272,000,000 USD become `90272`.
- `EPS` is diluted earnings per share in reporting currency/share. It is always split-normalized through `Metadata.EPSAdjustment.AsOf`, or null if verification is unavailable. `EPSSplitFactor` is the divisor applied to the original SEC fact. No reported-EPS fallback is exported.
- `PtpOnSales` and `*GrowthRate` values are **decimal fractions**, not percentages. `0.182` displays as `18.2%`.
- `Company.ClosingPrice`, `DailyPrices[].Close`, and `MonthlyPrices[].Close` use `Metadata.PriceCurrency` per share. Yahoo closes reflect stock splits but not dividend adjustments. Price and reporting currencies may differ; no currency conversion is performed.
- Fiscal period dates and prices use `YYYY-MM-DD`; creation and retrieval timestamps use ISO 8601 timestamps. A company's fiscal year is labeled by its period-end calendar year, as in the existing annual financial normalizer.
- Missing numeric values and unsupported flags are null, not zero or false. A true zero stays zero. Unknown lists are empty. `NoDataForYear` is true only when all three supported annual metrics are missing.
- `TotalRevenue` aliases `Sales` and `PretaxIncome` aliases `PTP`; do not add aliases together.
- `Metadata.UnavailableSections` describes unsupported datasets. Other unsupported scalar fields in `Company` and `AnnualData` remain null; this version does not expand the upstream data coverage.

## Growth and forecasts

For each metric, fit `ln(value) = intercept + slope × FiscalYear`, then store `exp(slope) − 1`. At least two distinct fiscal years are required. Missing observations are skipped while preserving actual year gaps. Any zero or negative observation makes the log-linear growth rate unavailable.

Forecast inputs in the table are view-local user assumptions. They are not fetched analyst estimates or saved study judgments, and are not written to `Study.Proj*` or `AnalystEstimates`. The five-year estimate remains `latest value × (1 + user rate)^5`.

## Source provenance

Each annual record has `Sources.Sales`, `Sources.EPS`, and `Sources.PTP`, containing `Concept`, `Filed`, `Accession`, `Unit`, `Start`, and `End`. These describe the original SEC fact. Its original `Unit` may be `USD`, while the normalized `Sales` field uses millions of USD. The original source unit is not the output unit.

`Metadata.Sources.SEC` and `YahooFinance` contain `Status`, `URL`, `RetrievedAt`, and `Error`. Upstream failures preserve data from the successful source and leave affected values unavailable.

## Frontend adapter

`src/studyDocument.ts` is the sole conversion boundary into the existing chart/table view model. It converts company totals back to base currency amounts for the current rendering helpers and decimal growth rates to displayed percentages. Components do not read raw upstream responses or independently guess units. API/storage values remain in the documented normalized units.

# Source coverage for expanded study pulls

Refresh a study to create a new snapshot with expanded data. Existing snapshots retain their original as-of data; new data is not silently inserted into old snapshots.

| Data group | Sources and behavior |
| --- | --- |
| Sales, EPS, pre-tax profit | SEC standard US GAAP/IFRS facts. Existing annual concept selection and split-normalization rules are preserved. |
| Balance sheets | SEC instants at the period end, including assets, equity, cash, investments, receivables, inventory, goodwill, debt components, and share counts. Yahoo fills supported monetary gaps. Beginning assets/equity use prior-year instants. |
| Income/cash-flow history | SEC net income, cost of revenue, operating income, income tax, interest expense, operating cash flow, capex; Yahoo fills available monetary gaps. |
| Quarterly history | Direct 70–110 day facts; additive monetary quarters can be derived from adjacent cumulative periods with the same tag/unit/year start. Q4 can be annual minus nine-month totals. Annual/YTD EPS and weighted shares are not subtracted to invent quarterly EPS/shares. |
| Company profile | Yahoo website, description, sector/industry names and keys, country, beta, ownership percentages, dividends, 52-week prices; SEC SIC. Latest quarterly snapshots, year-ago comparisons and complete four-quarter totals are derived from statements. |
| Per-share/share counts | SEC diluted/basic/ending shares and dividends use their own filing basis for split adjustments. Book value = equity / ending shares; cash flow per share = free cash flow / diluted weighted shares. Missing share basis produces null. |
| Ratios | PTP/sales, tax, payout, ROE, debt/capital, current/quick ratios, interest coverage and price/earnings. Every required input must exist; missing data is not assumed to be zero. Formulas and provenance are exported. |
| Price history/ranges | Yahoo daily closes and monthly closing samples; actual daily highs/lows determine fiscal-period ranges when coverage is adequate. No cross-currency P/E calculations. |
| Analyst estimates | Available Yahoo current/next fiscal-year consensus sales/EPS, growth rates and analyst counts. Requires a provider fiscal-year anchor and matching reporting currency. No invented five-year consensus history. |
| Peers | Bounded Yahoo industry top-company sample, mapped to unique SEC issuers and fetched with the same pipeline. Default 3, configurable via `STUDY_PEER_LIMIT` (0–5). Secondary peers do not recursively fetch further peers or create separate saved studies. |
| Peer averages | Focal company plus fetched peer sample, same reporting currency only. Arithmetic means per metric/year, with observation counts, membership, failures and exclusions. This is not an industry-wide or Morningstar peer-universe average. |
| Growth | Log-linear regression for sales, EPS and PTP, plus supported historical average ratios. |
| Chart scale factors | Our log-space range coefficients and series legend, explicitly distinguished from proprietary provider chart factors. |

## Values SEC and Yahoo cannot recreate exactly

- BetterInvesting/Morningstar issue/company/daily IDs and snapshot dates.
- Their full historical industry/size peer universes, industry averages, ratings, rankings, financial scores, adjusted definitions and analyst feed histories.
- The original provider's chart factors, outlier decisions, lock/status workflow and audit history.
- The study author's identity, notes, valuation choices, target prices, forecast judgments and study completion state.
- Issuer facts reported only under unsupported custom tags, absent standard facts, and historical observations outside source coverage.

These values remain null/empty rather than borrowing values from the supplied GOOGL example. `Metadata.FieldCoverage` lists populated/unavailable fields for each annual and quarterly period, plus provider-only and user-input groups. `Metadata.AvailableSections`, `UnavailableSections`, `PeerGroup`, `Calculations`, `Sources`, and `Warnings` explain the output.

## Definitions that can differ from the reference

- Financial totals and share counts use millions; prices/per-share values are unscaled.
- Growth and ratio rates are decimal fractions; ownership `*Pct` fields use percentage points.
- ROE uses average beginning/ending common equity. DTC uses long-term debt divided by long-term debt plus common equity.
- Free cash flow is operating cash flow minus capex; cash flow per share divides it by split-normalized diluted weighted-average shares.
- Interest coverage uses `(PTP + interest expense) / interest expense`.
- Quick ratio uses cash plus short-term investments plus receivables, divided by current liabilities.
- Total debt requires a reported aggregate or a complete component sum; no missing debt component is silently treated as zero.
- A reported SEC net-income fallback can include preferred/noncontrolling claims depending on the selected tag; the exact tag is retained in `Sources` for review. Company and vendor accounting definitions can therefore differ even for the same fiscal year.

## Primary references

- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [yfinance Ticker methods](https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.html)
- [Yahoo annual analyst estimates through yfinance](https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.get_earnings_estimate.html)
- [Yahoo industry data through yfinance](https://ranaroussi.github.io/yfinance/reference/api/yfinance.Industry.html)

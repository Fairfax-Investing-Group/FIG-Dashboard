# Sources and connection contract

Official interfaces verified on 2026-10-16:

- NYSE listing directory: https://www.nyse.com/listings_directory/stock
  Its `https://www.nyse.com/api/quotes/filter` responses include multiple
  exchanges; retain only explicit quote MIC `XNYS`. Do not accept XASE, ARCX,
  XNAS, XNCM, or XNMS as main NYSE.
- Nasdaq Trader other-listed symbol directory:
  https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt
  Supplement issues omitted by NYSE's EQUITY query using exact exchange `N`,
  excluding test issues. Only the explicit ETF flag supplies a type. Do not
  guess common, preferred, ADR, fund or warrant types from ticker/name.
- SEC exchange/CIK file: https://www.sec.gov/files/company_tickers_exchange.json
  SEC warns this search aid does not guarantee completeness. A missing match
  remains an explicit coverage issue.
- SEC submissions and bulk metadata specification:
  https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- SEC archive and fair-access requirements:
  https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
- Arelle standards-aware processor: https://arelle.org/
- SEC inline transformations, pinned source:
  https://github.com/Arelle/EDGAR/tree/4891c4c9889c77af247428ceff4fa7cc52d534ea/transform
- PyIceberg operations: https://py.iceberg.apache.org/api/
- Cloudflare Basin Catalog REST/PyIceberg:
  https://developers.cloudflare.com/basin-catalog/config-examples/pyiceberg/
- R2 S3 operations: https://developers.cloudflare.com/r2/api/s3/api/

The public NYSE web endpoint is not a guaranteed bulk-data service/SLA. Its
response is audited and retained; schema/pagination inconsistencies abort a
snapshot. Public availability is not a grant of unrestricted redistribution
rights. Confirm the intended production reuse of exchange reference data with
the source; do not substitute proprietary BetterInvesting/Morningstar data.

## Analyst and ownership source exports

No analyst or ownership feed is configured. The following is a **schema
contract**, not sample production values. Supply a JSON object with:

- `source_url`: actual HTTPS source URL.
- `usage_rights`: specific license/authorization statement covering this use.
- `rows`: source records; unsupported/calculated columns are rejected.

Both record types require `company_id` (existing deterministic UUID), `source`,
`as_of_date` (YYYY-MM-DD) and timezone-aware `collected_at` (ISO-8601).

Analyst records require `fiscal_year`, at least one of `revenue_estimate` and
`eps_estimate`; optional estimate-count fields preserve provider counts.
Revenue requires sourced `currency`; EPS requires sourced `eps_basis` such as
the provider's explicit GAAP/adjusted and diluted/basic definition. Counts are
nonnegative integers. Values/counts are exact JSON strings or null.

Ownership records require `ownership_type` (`insider` or `institutional`),
`value`, and `unit` (`fraction`, `percent`, `shares`). Ranges are checked against
the stated unit. An external percentage is permitted as a point-in-time
source observation. Ratios derived from the financial lake are not accepted.

Original imports are immutable Raw objects. Deterministic row identity includes
all source snapshot content and its original hash. Reimporting identical bytes
does not duplicate rows. A corrected export or later snapshot produces another
version rather than overwriting prior information. Rebuild uses these originals.
The importer cannot verify a third party's claimed license; operators must
provide actual lawful source material. No vendor scraping is implemented.

## Resume from retained local Raw on R2

Create the two dedicated buckets and enable Basin on `financial-lake`. Configure
all R2/Basin environment variables from `.env.example`. Stop other writers while
copying; transfer both objects and receipts using the immutable adapter:

```sh
export FINANCIAL_STORAGE=r2
# Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, BASIN_CATALOG_URI,
# BASIN_WAREHOUSE and BASIN_TOKEN to the actual provisioned credentials/settings.
.venv/bin/python - <<'PY'
from pathlib import Path
from fairfax_financial.core import Settings
from fairfax_financial.storage import Objects
source = Objects(Settings(Path('data').resolve(), storage='local'))
target = Objects(Settings.env())
assert target.client is not None, 'Configure R2 before copying'
for path in source.keys():
    if path.startswith(('objects/', 'receipts/')):
        target.put(path, source.get(path))
PY
.venv/bin/financial rebuild
# Review the measured projection and provision sufficient capacity, then set
# FINANCIAL_STORAGE_LIMIT_BYTES accordingly before starting the full backfill.
.venv/bin/financial backfill --until 2026-10-16
.venv/bin/financial validate --companyfacts
.venv/bin/financial storage-report
```

The adapter refuses differing bytes at an existing immutable key. Investigate
any collision rather than overwriting it. This transfer is **not executed** in
the current environment because the remote credentials are unavailable.

Alternatively, copy only the retained `data/raw/` directory into a fresh data
root on a volume with sufficient space, set `FINANCIAL_DATA_DIR` to that new
absolute root, run `rebuild`, review/set the storage guard, and resume `backfill`.
Keep the original Raw copy until verification passes. Do not reuse the moved
local catalog/lake metadata: they contain absolute paths to the previous volume.

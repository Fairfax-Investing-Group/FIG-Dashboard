# Fairfax financial source lake

Python code for an immutable Raw → Silver → Gold financial database. There is no
frontend, public API, stock-price store, or investment calculation engine.

**Status:** the repository implements and tests the local storage path. A dated
main-NYSE universe and a small real-filing pilot have been acquired locally.
The complete ten-year backfill is a separate, resumable operation; see
[the execution report](docs/EXECUTION.md) for measured completion and blockers.
R2/Basin are supported adapters, not a claim of remote deployment.

## Install

Python 3.13 is required. The checked lock records the exact tested environment.

```sh
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.lock
.venv/bin/pip install --no-deps -e .
export SEC_USER_AGENT='Fairfax Investing Group Thomas Duong thomas@fairfaxinvestinggroup.com'
```

The contact above was explicitly supplied by the project owner. Set a truthful
identity for a different operator. Credentials belong in environment variables;
`.env` is ignored and is **not automatically loaded**.

```sh
.venv/bin/financial bootstrap-universe --as-of 2026-10-16
.venv/bin/financial bootstrap-sec --discover-only --until 2026-10-16
# Pilot, selected from the snapshotted current universe:
.venv/bin/financial bootstrap-sec --cik 19617 --cik 200406 --cik 726728
.venv/bin/financial parse-xbrl
.venv/bin/financial build-silver
.venv/bin/financial build-gold
.venv/bin/financial validate --companyfacts
.venv/bin/financial storage-report
# Full universe, ten-year window, with measured pilot storage preflight:
.venv/bin/financial backfill --until 2026-10-16
# Refresh membership and metadata; cached filing bundles and parse runs are reused:
.venv/bin/financial update
# Actually purge registered Silver/Gold tables, then rebuild OFFLINE from Raw:
.venv/bin/financial rebuild
```

`data/` is ignored. Preserve `data/raw/` durably: its objects **and receipts** are
needed for a rebuild. `catalog.db` is only the local Iceberg catalog; financial
facts live in Parquet managed by Iceberg. One writer per data directory is
required and enforced with an OS lock. Local tests use disposable catalogs.
Do not run multiple workers against the same R2 buckets using different lock
folders. Distributed writers are intentionally outside this implementation.

Commands return exit 2 for external prerequisites/storage guards and exit 1 for
validation/parse failures. Inspect immutable `backfill-report`, `issue`, and
`validation-report` receipts and `silver.data_quality_flags`. Do not equate a
successful metadata discovery with acquisition or parsing completion.

## Data contract

[Architecture and source semantics](docs/ARCHITECTURE.md) describe every layer,
identity limits, period handling, amendments, accuracy and provenance. Gold is
**long form**: one source primitive per issuer/accession/exact reported
period/unit/canonical field. `value` is an exact normalized lexical number,
never a floating-point approximation. A future query can pivot these rows.

No computed quarters, ratios, TTM, growth, averages, financial scores, market
prices, valuation inputs, or application state are persisted. EPS is retained
as explicitly reported. Missing facts remain absent. A source-reported total
may remain in Silver even when Gold retains the constituent debt primitives.

Analyst estimates and ownership tables start empty. There is no licensed
provider configured. `import-snapshots analyst|ownership path.json` ingests an
explicitly licensed source export; [the import contract](docs/SOURCES.md)
requires source URL, usage rights, as-of date and collection time. Different
source snapshots are retained, including corrections on the same as-of date.

## Cloudflare

Provision two dedicated buckets, `financial-raw` and `financial-lake`, and enable
Basin Catalog on the latter. Copy the exact catalog URI and warehouse from
Cloudflare; do not synthesize an endpoint. Set variables in [.env.example](.env.example).
The adapter only accesses configured buckets and managed Silver/Gold tables.
It never creates or changes websites, DNS, domains, Workers or Pages.

The implementation follows the current official
[Basin PyIceberg example](https://developers.cloudflare.com/basin-catalog/config-examples/pyiceberg/)
and [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
Basin supplies an Iceberg REST catalog; PyIceberg writes Parquet to its warehouse.
No Basin SQL integration is used. Remote credentials and a live catalog are
required before remote integration can be verified.

A 9,000,000,000-byte default guard protects raw writes; full backfills also
project raw+lake growth from measured pilot files and check local free space. Inventory includes historical
Iceberg data/metadata. Override `FINANCIAL_STORAGE_LIMIT_BYTES` only after
reviewing the projection and storage capacity. The estimate is not a guarantee:
pilot companies are not a representative statistical sample. Configure Basin
maintenance/snapshot retention in accordance with recovery needs; do not delete
Iceberg data files by hand. Keep Raw immutable regardless of lake compaction.

## Verification

```sh
.venv/bin/ruff check src tests
.venv/bin/ruff format --check src tests
.venv/bin/pytest -q
```

Tests use a small retained archive of actual filings and their taxonomies,
including iXBRL scaling, dimensions, extensions, relationships, reported YTD,
rounding, amendment identities, complete source lineage and Company Facts
comparison. The suite actually deletes Silver/Gold, rebuilds them offline and
compares every table's semantic hash. No fabricated financial histories are used.

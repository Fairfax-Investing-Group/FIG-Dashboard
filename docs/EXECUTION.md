# Execution record — October 16, 2026

**Status: local foundation verified; complete financial backfill blocked.**
The full universe's filing metadata was discovered. Only the seven real pilot
filings below have financial source material acquired and parsed. No complete
NYSE financial database or Cloudflare deployment is claimed.

Measured machine-readable evidence is in [run-results.json](run-results.json).
The durable local database and immutable sources are in ignored `data/`.

## Completed and verified

- Dated authoritative universe: **3,237 main-NYSE securities**, with **2,222
  unique mapped SEC issuers**. NYSE quote MIC `XNYS` is filtered explicitly;
  Nasdaq Trader exchange `N` supplements non-common issues.
- All **2,222 mapped current issuers** were processed for filing discovery.
  **52,939 requested-form filings** were discovered for filing dates
  **2016-10-16 through 2026-10-16**, with **zero discovery failures**.
- Local metadata contains **52,979 filings**: those current-issuer filings plus
  40 historical Exxon issuer filings retained during pilot validation.
  The historical issuer and current XOM holding-company CIK are separate.
- **Seven actual filing bundles** retain source instances/iXBRL, extension
  schemas, linkbases and standard taxonomy dependencies. The pilot covers
  JPMorgan, Johnson & Johnson, Realty Income and historical Exxon.
- **109,931 Silver source facts**, **52,811 relationships**, and **410 Gold source
  rows** (256 annual, 154 quarterly/cumulative/other reported periods) were built.
  Gold values trace directly to original facts and versioned mappings.
- Realty Income's original 2018 annual report, accession
  `0000726728-19-000038`, and its amendment, `0000726728-19-000041`, coexist.
  Their separate acceptance times and reported values are preserved.
- **18 automated tests passed** in the final offline run, including full-row
  hashes across actual table deletion/reconstruction, new-filing incremental
  ingestion, idempotency, units/scale/dimensions, original/amended financials,
  source-only mappings, SEC retry handling and R2/Basin interface contracts.
- The actual local Silver/Gold tables were also purged and rebuilt from the
  retained full Raw store: **7 parsed, 0 failed**; structural/lineage validation
  reported **0 errors**, with 17 retained disclosure-context diagnostics.
- Live Company Facts reference validation compared **4,215 values**, with
  **0 mismatches**. Another 1,225 candidate observations had no matching
  reference entry; extensions/dimensions/reference coverage are not fabricated.
  No filing-derived value was replaced to match Company Facts.
- Lint, formatting and installed dependency checks passed. Scratch downloads,
  profiles, temporary test catalogs/Parquet and console logs were removed.
  Small permanent real-source fixtures remain in the test suite.

## Exact full-backfill stop

The complete-universe `backfill --until 2026-10-16` command was attempted. Its
preflight, based on four measured pilot filings at that time, projected:

| Measurement | Bytes |
| --- | ---: |
| Projected persistent raw + lake | 75,388,886,062 |
| Additional projected storage | 75,256,127,917 |
| Local space then available | 15,883,321,344 |
| Configured initial storage guard | 9,000,000,000 |

The projection uses measured mean filing-source bytes, active financial Parquet
bytes, and a metadata reserve. It is **not a measured full-dataset size or a
statistically representative estimate**; subsequent pilot coverage increased
to seven filings. It nevertheless exceeds available local capacity by a large
margin. Full-universe filing-document acquisition stopped before starting.

No Cloudflare credentials or connected Cloudflare integration were available.
A direct R2 configuration check returned `R2 requires R2_ENDPOINT,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY`. No buckets, catalog, DNS, websites or
other Cloudflare resources were created or changed. **Persistent R2 usage is
unmeasured, not zero.** The JSON report separately records measured local
logical bytes, filesystem allocation and free space after cleanup.

## Coverage and remaining actions

1. Provision dedicated R2/Basin storage and credentials, or a larger local
   volume. Transfer retained Raw, rebuild the catalog/lake, review the measured
   projection, explicitly configure sufficient storage guard/capacity, and run
   `financial backfill --until 2026-10-16`. Follow the exact connection/transfer
   steps in [SOURCES.md](SOURCES.md#resume-from-retained-local-raw-on-r2).
   Then run validation and measure actual remote usage. Remote integration and
   full-scale performance remain unverified until that connection exists.
2. Resolve **893 securities without a unique SEC CIK association** using sourced
   issue/issuer reference data. **3,158 security types remain unknown** and all
   **3,237 security IDs are explicitly provisional** pending permanent issue
   identifiers/sourced ticker-change aliases. Company CIK identities are stable.
3. **659 mapped issuers have no requested 10-K/10-Q forms in the window**. This
   includes possible foreign issuers, funds and recently established issuers;
   no missing years were created. The current automatic acquisition scope is
   the requested 10-K/10-Q forms and amendments. Foreign/fund forms such as
   20-F/40-F/6-K and alternative lawful sources require additional coverage work.
4. The 42 mapping rules are conservative. Extensions, dimensional facts and
   other unmapped facts remain losslessly available in Silver. Each parsed
   filing has an explicit canonical-field coverage report; review and version
   additional mappings rather than guessing missing totals/classifications.
5. Analyst and ownership tables contain **zero records** because no licensed
   source is configured. Schemas and provenance-preserving snapshot import
   support exist. Supply an actual authorized export/provider before loading.

One initial classic-HTML acquisition error remains in the immutable audit log.
It was resolved by the corrected separate-XBRL-instance fallback; both paired
filings now parse. An `issue-resolution` Raw receipt links the correction to
the actual retained amendment bundle. No unresolved pilot parsing failure or
Company Facts mismatch remains.

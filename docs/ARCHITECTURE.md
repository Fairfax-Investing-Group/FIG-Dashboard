# Storage and accounting semantics

## Raw/Bronze

Each source payload is SHA-256 addressed, deterministically gzip compressed,
and written once. An immutable receipt records URL, source hash, uncompressed
and stored sizes, acquisition time, purpose and CIK/accession metadata when
applicable. Identical bytes share one object even if referenced by multiple
filings. Receipts themselves are part of Raw. Acquisition records reference
source receipts; they contain observed filing metadata, not financial estimates.

NYSE API requests and responses, consolidated Nasdaq Trader directory, SEC
CIK mapping, relevant submissions metadata, filing directory, primary inline
document/submitted instance and filed schemas/linkbases are retained.
Standard taxonomy dependency documents are recursively collected once and
shared by content hash. Images, certifications, graphic exhibits, complete
submission text and SEC-generated duplicate instances are not archived.
If a primary document is not XML/iXBRL, the code looks for a submitted XBRL
instance; a filing without an instance is retained as filing metadata and a
recorded acquisition failure. This is common for amendments that have no XBRL.

Submissions metadata uses SEC's official static per-issuer JSON files, including
all referenced historical shards overlapping the requested filing-date window.
It does not repeatedly query Company Facts to construct financial histories.
No redundant daily bulk ZIP is retained. The current automatic scope is
10-K, 10-K/A, 10-Q and 10-Q/A. Foreign issuers and funds that file other forms
remain in the universe with explicit missing-coverage flags. 20-F/40-F/6-K and
non-SEC reporting sources need additional acquisition/normalization work.
A ten-year *filing-date* window can include older comparative accounting periods;
these are real observations and are not assigned a manufactured fiscal year.

A filing bundle is published only when its source dependency graph is complete.
Failed downloads can resume from individual immutable receipts. All external
requests, retries and redirects share a sequential client capped below five
requests/second, below SEC's documented ten-request/second maximum. HTTP 403
stops that source attempt; three consecutive source refusals stop a batch.
There is no proxy rotation or access bypass. Retry-After/backoff is respected.

## Silver

- `companies`: CIK-derived UUIDv5 issuer identities and sourced metadata.
- `securities`: issue identities, current symbols and explicit source type, with
  unresolved identity/classification coverage flags.
- `universe_snapshots`: dated security membership (not just unique issuers), with snapshot identity
  and collection time so same-day refreshes do not blend old/new membership.
- `filings`: accession identity, form, report date, filing date and exact SEC
  acceptance timestamp when available. Originals and amendments coexist.
- `financial_facts`: each original concept, namespace, source lexical and
  transformed value, context XML, dimensions, units, instant/duration dates,
  reported fiscal focus, source hash/URL/path and parser/rule versions.
- `relationships`: presentation, calculation and dimensional relationship arcs.
- `concept_mappings`: immutable versioned configuration rules.
- `source_manifest`: receipt projection; Raw remains authoritative.
- `data_quality_flags`: errors, diagnostics and explicit coverage limitations.
- `parse_runs`: successful input-hash/parser/config checkpoints for resumability.

Arelle runs offline on disposable copies whose taxonomy references resolve to
retained originals. The SEC's own inline transformation code is vendored at a
pinned commit, with its licenses and origin. No visual-table interpretation is
used. Invalid numeric facts remain in Silver and are excluded from Gold.
XML contexts, namespaces, units, dimensions, nils, scale, sign, precision and
all original concepts survive normalization. Parsing exceptions quarantine the
filing rather than publishing a successful checkpoint.

## Identity limits

A company UUID is deterministic from its zero-padded CIK. A company ticker
change does not change its identity/history. The current NYSE web directory
does not supply a permanent issue identifier. Security IDs therefore use an
explicit provisional registry key (MIC, CIK when mapped, first symbol).
They are deterministic across rebuilds from the same Bronze snapshots.

A sourced alias in `config/security_aliases.json` binds an old and new ticker
to one `security_key`; each alias must include a real `source_url`. Do not
infer issue continuity from name similarity. Unresolved ticker changes remain
separate provisional issues until evidence is supplied. SEC mapping joins use
published symbols, with dot/dash normalization; ambiguous/unmapped cases are
flagged and retained without a guessed CIK. New legal issuers get new CIK
identities: predecessor histories are not silently merged. In the acquired
snapshot, current XOM maps to holding-company CIK 2115436; the historical
Exxon CIK 34088 is retained only as a separately identified real pilot source.

## Gold

`company_metadata`, `annual_reported_facts`, `quarterly_reported_facts`,
`analyst_estimates`, `ownership_snapshots` contain sourced data only.
Canonical facts have per-value lineage to a Silver fact and mapping rule.
Accessions never collapse into a latest-only row; select a filing/acceptance
cutoff and an explicit restatement policy at query time. An amendment does
not automatically supersede every value in an original filing.

Period shape is labeled from exact dates: reported quarter (70–110 days),
six-month YTD (150–210), nine-month YTD (240–300), annual (330–400), instant,
or other reported duration. These are shape labels, not inferred fiscal
quarters. No YTD subtraction or annual-minus-nine-month Q4 is materialized.
An instant on a 10-K routes to annual facts; other instants route to quarterly
facts. Thus the quarterly table also contains exact reported cumulative and
other-duration facts: always filter `period_kind` before downstream analysis.
Only contexts ending on the filing report date can inherit its sourced fiscal
focus; comparative periods retain null fiscal identifiers and exact dates.

Only explicitly configured concepts, valid numeric values, correctly typed
units, and whole-entity contexts enter Gold. Dimensions and extensions remain
in Silver unless a reviewed exact rule is added. All canonical rule matches
must agree within their original XBRL accuracy intervals. For consistent
rounding duplicates the most precise **reported original** is selected.
Inconsistent alternatives are withheld and flagged. No balancing or averaging
creates replacement financial values.

Mappings distinguish parent net income (`NetIncomeLoss`) from income including
noncontrolling interests (`ProfitLoss`), common-only versus all dividends paid,
and declared versus paid per-share dividends. Short-term borrowings, current
long-term maturities and commercial paper are separate source primitives;
there is no invented total debt. Missing preferred-dividend mappings remain
missing: a concept containing preferred dividends **and other adjustments**
is not substituted as preferred dividends. Taxonomy coverage is intentionally
conservative; missing canonical fields are a coverage limitation, not zero.

## Physical layout and reproducibility

Iceberg v2 tables use Zstandard Parquet; large fact tables bucket issuer IDs
into 32 partitions. Filing-scoped atomic replacements remove obsolete
normalization results without rewriting every issuer. Deterministic fact IDs
include accession, original source hash and original positional element path (without long-concept-name truncation). Repeating
unchanged upserts does not create snapshots. Immutable raw receipts, not a
mutable local job state file, supply restart/rebuild inputs.

`rebuild` purges only the registered project Silver/Gold tables. It does not
remove Raw, unrelated namespaces or Cloudflare configuration. Tests rebuild
all managed tables twice and compare sorted full-row hashes, excluding no
financial columns. Iceberg file names/snapshot IDs are physical build metadata
and need not be byte-identical. A rebuild that cannot parse retained sources
reports failure rather than quietly omitting them.

Single-machine writes are supported; parallel distributed ingestion is not.
Per-filing batches bound parser memory. Table scans for structural validation
select keys; source/Gold validation then works per accession. On a full lake,
plan periodic compaction/snapshot expiry with Basin maintenance and measure
storage before choosing a longer retention policy. Nothing deletes or expires
Raw automatically.

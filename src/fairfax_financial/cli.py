from __future__ import annotations

import fcntl
import json
import shutil
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import typer

from . import sec, universe
from .core import Blocked, Settings, now
from .http import Fetcher
from .pipeline import Pipeline
from .validation import company_facts
from .validation import validate as validate_lake

app = typer.Typer(
    no_args_is_help=True,
    pretty_exceptions_enable=False,
    help="Build a source-only NYSE financial lake. No application or market-price system.",
)


def show(result):
    typer.echo(json.dumps(result, indent=2, default=str))


@contextmanager
def session():
    settings = Settings.env()
    with (settings.root / ".writer.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise typer.BadParameter("Another pipeline writer holds the data-directory lock") from None
        try:
            yield Pipeline(settings)
        except Blocked as error:
            typer.echo("BLOCKED: " + str(error), err=True)
            raise typer.Exit(2) from error


def cutoff(until):
    end = date.fromisoformat(until)
    try:
        return end.replace(year=end.year - 10).isoformat()
    except ValueError:
        return end.replace(year=end.year - 10, day=28).isoformat()


@app.command("bootstrap-universe")
def bootstrap_universe(as_of: str = date.today().isoformat()):
    with session() as p:
        h = Fetcher(p.settings.user_agent)
        try:
            universe.acquire(p.raw, h, as_of)
            show(p.silver())
        finally:
            h.close()


def selected_ciks(p, ciks):
    snapshots = p.lake.rows("silver.universe_snapshots")
    if not snapshots:
        raise Blocked("No raw universe: run bootstrap-universe first")
    latest = max(
        snapshots, key=lambda r: (r["snapshot_date"], r.get("collected_at") or "", r.get("snapshot_id") or "")
    )
    members = {
        r["company_id"]
        for r in snapshots
        if r.get("snapshot_id") == latest.get("snapshot_id") and r["snapshot_date"] == latest["snapshot_date"]
    }
    available = {r["cik"] for r in p.lake.rows("silver.companies") if r["id"] in members}
    requested = {str(int(c)).zfill(10) for c in ciks} if ciks else available
    if requested - available:
        raise Blocked(
            "CIKs are not uniquely mapped in latest main-NYSE universe: " + str(requested - available)
        )
    return sorted(requested)


def bootstrap(p, ciks, since, until, discover_only=False, refresh=False):
    if date.fromisoformat(since) > date.fromisoformat(until):
        raise ValueError("since must be no later than until")
    selected = selected_ciks(p, ciks)
    h = Fetcher(p.settings.user_agent)
    result = dict(
        started_at=now(),
        since=since,
        until=until,
        issuers_selected=len(selected),
        issuers_discovered=0,
        filings_discovered=0,
        bundles_acquired=0,
        failures=[],
        discover_only=discover_only,
        complete=False,
    )
    try:
        filings = []
        refusals = 0
        for i, cik in enumerate(selected):
            try:
                _, found = sec.discover(p.raw, h, cik, since, until, refresh=refresh)
                filings.extend(found)
                result["issuers_discovered"] += 1
                refusals = 0
            except Exception as error:
                sec.issue(p.raw, "discovery_failure", error, cik=cik)
                result["failures"].append(dict(cik=cik, stage="discovery", reason=str(error)))
                refusals = refusals + 1 if isinstance(error, Blocked) else 0
                if refusals >= 3:
                    result["stopped_reason"] = "Three consecutive source refusals; no bypass attempted"
                    break
            if (i + 1) % 50 == 0:
                typer.echo(f"Discovery {i + 1}/{len(selected)}: {len(filings)} relevant filings", err=True)
        result["filings_discovered"] = len(filings)
        p.silver()
        if not discover_only:
            known = {b["filing"]["id"] for _, b in p.raw.payloads("filing-bundle")}
            result["bundles_preexisting"] = len(known)
            # Projection is deliberately transparent, based on measured pilot data.
            # Repeated taxonomy objects and metadata are not counted per filing.
            bundles = [b for _, b in p.raw.payloads("filing-bundle")]
            refs = {r["id"]: r for r in p.raw.receipts()}
            if bundles:
                own_bytes = [
                    sum(
                        refs[r]["stored_size"]
                        for u, r in b["documents"].items()
                        if "/Archives/edgar/data/" in u
                    )
                    for b in bundles
                ]
                mean = sum(own_bytes) / len(own_bytes)
                usage = p.raw.usage(refresh=True)
                # Lake estimate is measured from pilot tables, including metadata,
                # not an invented financial value. Actual accounting remains separate.
                pilot_tables = [
                    "silver.financial_facts",
                    "silver.relationships",
                    "gold.annual_reported_facts",
                    "gold.quarterly_reported_facts",
                ]
                pilot_lake = sum(
                    task.file.file_size_in_bytes
                    for name in pilot_tables
                    for task in p.lake.catalog.load_table(name).scan().plan_files()
                )
                per_filing_lake = pilot_lake / len(bundles) + 65536
                projected = int(usage + max(0, len(filings) - len(known)) * (mean + per_filing_lake))
                result["storage_projection"] = dict(
                    current_bytes=usage,
                    projected_bytes=projected,
                    pilot_filings=len(bundles),
                    mean_filing_raw_bytes=int(mean),
                    mean_filing_lake_bytes=int(per_filing_lake),
                    limit_bytes=p.settings.limit_bytes,
                    method="pilot mean raw filing + active financial Parquet bytes + 64 KiB/file metadata reserve; not a guarantee",
                )
                if p.settings.storage == "local":
                    free = shutil.disk_usage(p.settings.root).free
                    result["storage_projection"]["available_local_bytes"] = free
                    if projected - usage > max(0, free - 1_073_741_824):
                        raise Blocked(
                            f"Insufficient local capacity: full backfill projects {projected:,} total bytes "
                            f"({projected - usage:,} additional) with {free:,} bytes free. "
                            "Provide R2/Basin credentials and sufficient storage, or move FINANCIAL_DATA_DIR "
                            "to a larger volume. No full acquisition was started."
                        )
                if projected > p.settings.limit_bytes:
                    raise Blocked(
                        f"Full backfill projects {projected:,} bytes from {len(bundles)} pilot filings "
                        f"versus {p.settings.limit_bytes:,}-byte guard. See backfill report; "
                        "provision storage and explicitly raise FINANCIAL_STORAGE_LIMIT_BYTES to continue."
                    )
            refusals = 0
            for i, filing in enumerate(filings):
                if filing["id"] in known:
                    continue
                try:
                    sec.acquire_filing(p.raw, h, filing)
                    result["bundles_acquired"] += 1
                    refusals = 0
                except Exception as error:
                    sec.issue(
                        p.raw,
                        "acquisition_failure",
                        error,
                        cik=filing["cik"],
                        accession=filing["accession_number"],
                    )
                    result["failures"].append(
                        dict(
                            cik=filing["cik"],
                            accession=filing["accession_number"],
                            stage="acquisition",
                            reason=str(error),
                        )
                    )
                    if isinstance(error, Blocked) and "Storage guard" in str(error):
                        raise
                    refusals = refusals + 1 if isinstance(error, Blocked) else 0
                    if refusals >= 3:
                        result["stopped_reason"] = (
                            "Three consecutive source refusals; resumable after access is restored"
                        )
                        break
                if (i + 1) % 25 == 0:
                    typer.echo(f"Acquisition {i + 1}/{len(filings)}", err=True)
        result["complete"] = (
            result["issuers_discovered"] == len(selected)
            and not result["failures"]
            and "stopped_reason" not in result
        )
        return result
    except Blocked as error:
        result["stopped_reason"] = str(error)
        raise
    finally:
        result["finished_at"] = now()
        p.raw.record("backfill-report", result)
        p.silver()
        show(result)
        h.close()


@app.command("bootstrap-sec")
def bootstrap_sec(
    cik: list[str] = typer.Option(None),
    since: str | None = None,
    until: str = date.today().isoformat(),
    discover_only: bool = False,
):
    with session() as p:
        bootstrap(p, cik, since or cutoff(until), until, discover_only)


@app.command("parse-xbrl")
def parse_xbrl():
    with session() as p:
        result = p.parse()
        show(result)
        if result["failed"]:
            raise typer.Exit(1)


@app.command("build-silver")
def build_silver():
    with session() as p:
        show(p.silver())


@app.command("build-gold")
def build_gold():
    with session() as p:
        show(p.gold())


@app.command()
def validate(companyfacts: bool = False, cik: list[str] = typer.Option(None)):
    with session() as p:
        result = validate_lake(p)
        if companyfacts:
            h = Fetcher(p.settings.user_agent)
            try:
                # Only issuers with parsed facts; no Company Facts bootstrap.
                successful = {
                    r["accession_number"]
                    for r in p.lake.rows("silver.parse_runs")
                    if r["status"] == "success"
                }
                available = {
                    f["cik"] for f in p.lake.rows("silver.filings") if f["accession_number"] in successful
                }
                chosen = [str(int(c)).zfill(10) for c in cik] if cik else sorted(available)
                result["companyfacts"] = company_facts(p, h, chosen, refresh=True)
            finally:
                h.close()
        show(result)
        if result["new_validation_issues"] or result.get("companyfacts", {}).get("mismatches"):
            raise typer.Exit(1)


@app.command()
def rebuild():
    """Purge only managed Silver/Gold; reconstruct offline from immutable Raw."""
    with session() as p:
        result = p.rebuild()
        result["validation"] = validate_lake(p)
        show(result)
        if result["parse"]["failed"] or result["validation"]["new_validation_issues"]:
            raise typer.Exit(1)


@app.command()
def backfill(until: str = date.today().isoformat()):
    """Attempt the complete current-NYSE ten-year backfill, subject to storage guard."""
    with session() as p:
        bootstrap(p, None, cutoff(until), until)
        show(p.parse())
        show(p.gold())
        show(validate_lake(p))


@app.command()
def update(as_of: str = date.today().isoformat()):
    """Refresh universe + recent metadata; acquire/parse only missing filings."""
    with session() as p:
        h = Fetcher(p.settings.user_agent)
        try:
            universe.acquire(p.raw, h, as_of)
        finally:
            h.close()
        p.silver()
        # Metadata refresh covers the full rolling window but cached history and
        # filing bundles are reused. No daily bulk archives or historical rebuilds.
        before = {r["id"] for r in p.lake.rows("silver.parse_runs")}
        bootstrap(p, None, cutoff(as_of), as_of, refresh=True)
        show(p.parse())
        changed = {r["accession_number"] for r in p.lake.rows("silver.parse_runs") if r["id"] not in before}
        show(p.gold(changed))
        show(validate_lake(p, changed))


@app.command("storage-report")
def storage_report():
    with session() as p:
        show(
            dict(
                storage=p.settings.storage,
                persistent_bytes=p.raw.usage(refresh=True),
                guard_bytes=p.settings.limit_bytes,
                raw_objects=len(list(p.raw.keys("objects/"))),
                remote_verified=p.settings.storage == "r2",
            )
        )


@app.command("import-snapshots")
def import_snapshots(kind: str, path: Path):
    """Import lawfully obtained analyst/ownership source snapshots (no scraping)."""
    from .snapshots import ingest

    with session() as p:
        show(ingest(p, kind, path))

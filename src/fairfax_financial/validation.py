from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

import polars as pl
from pyiceberg.expressions import EqualTo

from . import sec
from .core import canonical, key
from .numeric import consistent
from .schema import SCHEMAS


def validate(pipeline, accessions=None):
    lake, raw = pipeline.lake, pipeline.raw
    issues = []
    counts = {}

    def add(code, details, f=None, severity="error"):
        f = f or {}
        row = dict(
            code=code,
            severity=severity,
            company_id=f.get("company_id"),
            accession_number=f.get("accession_number"),
            fact_id=f.get("id"),
            details=details,
            source_id=None,
        )
        row["id"] = key(row)
        issues.append(row)

    # Scan keys only; never load the full 10-year fact lake into memory.
    for name in SCHEMAS:
        keys = lake.catalog.load_table(name).scan(selected_fields=("id",)).to_arrow()
        df = pl.from_arrow(keys)
        counts[name] = df.height
        if df["id"].null_count() or df["id"].n_unique() != df.height:
            add("duplicate_key", name)
    receipts = {r["source_hash"] for r in raw.receipts()}
    mappings = {m["id"] for m in lake.rows("silver.concept_mappings")}
    successful = {r["accession_number"] for r in lake.rows("silver.parse_runs") if r["status"] == "success"}
    for filing in lake.rows("silver.filings"):
        if filing["accession_number"] not in successful:
            continue
        accession = filing["accession_number"]
        if accessions is not None and accession not in accessions:
            continue
        facts = lake.rows("silver.financial_facts", EqualTo("accession_number", accession))
        index = {f["id"]: f for f in facts}
        conflicts = {}
        for f in facts:
            if not all(
                f.get(n) for n in ["source_url", "source_hash", "context_id", "namespace", "fact_path"]
            ):
                add("missing_provenance", "Required provenance absent", f)
            if f["source_hash"] not in receipts:
                add("missing_raw_source", f["source_hash"], f)
            try:
                start, end = f["period_start"], f["period_end"] or f["instant_date"]
                if not end or (start and date.fromisoformat(start) > date.fromisoformat(end)):
                    raise ValueError("Malformed period")
                date.fromisoformat(end)
                date.fromisoformat(f["filed_at"])
                if date.fromisoformat(end) > date.fromisoformat(f["filed_at"]):
                    add("future_reported_context", end, f, "diagnostic")
                if start and (date.fromisoformat(end) - date.fromisoformat(start)).days > 800:
                    add("unusual_duration", start + ".." + end, f, "diagnostic")
            except (ValueError, TypeError):
                add("impossible_date", canonical([f["period_start"], f["period_end"], f["instant_date"]]), f)
            if f["is_numeric"] and not f["is_nil"] and f["is_valid"]:
                if not f["unit"]:
                    add("invalid_unit", "No unit", f)
                ident = (
                    f["namespace"],
                    f["concept"],
                    f["period_start"],
                    f["period_end"],
                    f["instant_date"],
                    f["dimensions"],
                    f["unit"],
                    f["xml_lang"],
                )
                conflicts.setdefault(ident, []).append(f)
        for group in conflicts.values():
            if not consistent(group):
                add("conflicting_source_facts", canonical([f["id"] for f in group]), group[0])
        for table in ["gold.annual_reported_facts", "gold.quarterly_reported_facts"]:
            for g in lake.rows(table, EqualTo("source_accession", accession)):
                original = index.get(g["source_fact_id"])
                if not original or original["value"] != g["value"] or original["unit"] != g["unit"]:
                    add("gold_lineage_mismatch", g["id"])
                if g["mapping_id"] not in mappings:
                    add("missing_mapping", g["id"])
    lake.upsert("silver.data_quality_flags", issues)
    return dict(
        counts=counts,
        new_validation_issues=sum(r["severity"] == "error" for r in issues),
        diagnostics=sum(r["severity"] == "diagnostic" for r in issues),
    )


def company_facts(pipeline, fetcher, ciks, refresh=False):
    comparisons, mismatches, unmatched = 0, [], 0
    for cik in ciks:
        url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{int(cik):010d}.json"
        ref = sec.get_source(pipeline.raw, fetcher, url, "companyfacts-validation", {"cik": cik}, refresh)
        data = json.loads(pipeline.raw.read(ref))
        facts = pipeline.lake.rows("silver.financial_facts", EqualTo("cik", cik))
        for f in facts:
            if not f["is_numeric"] or not f["is_valid"] or f["is_nil"] or f["dimensions"] != "{}":
                continue
            units = data.get("facts", {}).get(f["taxonomy"], {}).get(f["concept"], {}).get("units", {})
            unit = json.loads(f["unit"])
            name = "*".join(unit["numerator"]) + (
                "/" + "*".join(unit["denominator"]) if unit["denominator"] else ""
            )
            matches = [
                v
                for v in units.get(name, [])
                if v.get("accn") == f["accession_number"]
                and v.get("end") == (f["period_end"] or f["instant_date"])
                and v.get("start") == f["period_start"]
            ]
            if not matches:
                unmatched += 1
                continue
            comparisons += 1
            tolerance = Decimal(0)
            if f["decimals"] and f["decimals"].lstrip("-").isdigit():
                tolerance = Decimal("0.5") * Decimal(10) ** -int(f["decimals"])
            if not any(abs(Decimal(str(v["val"])) - Decimal(f["value"])) <= tolerance for v in matches):
                issue = sec.issue(
                    pipeline.raw,
                    "companyfacts_mismatch",
                    canonical(
                        dict(parsed=f["value"], reference=[v["val"] for v in matches], fact_id=f["id"])
                    ),
                    cik=cik,
                    accession=f["accession_number"],
                    source_id=ref["id"],
                )
                mismatches.append(issue)
    pipeline.lake.upsert("silver.data_quality_flags", mismatches)
    result = dict(
        compared=comparisons,
        mismatches=len(mismatches),
        unmatched=unmatched,
        note="Reference-only; no filing-derived values changed",
    )
    pipeline.raw.record("validation-report", result)
    return result

from __future__ import annotations

import json
from pathlib import Path

from pyiceberg.expressions import EqualTo

from . import sec, universe
from .core import canonical, key
from .lake import Lake
from .normalize import configuration, normalize
from .parser import PARSER_VERSION, parse
from .storage import Objects


class Pipeline:
    def __init__(self, settings):
        self.settings = settings
        self.raw = Objects(settings)
        self.lake = Lake(settings)
        self.lake.objects = self.raw
        self.lake.initialize()

    def silver(self):
        alias_path = Path("config/security_aliases.json")
        aliases = json.loads(alias_path.read_text()) if alias_path.exists() else []
        companies, securities, snapshots, flags = universe.build(self.raw, aliases)
        companies = {r["id"]: r for r in companies}
        companies.update({r["id"]: r for r in sec.metadata(self.raw)})
        self.lake.upsert("silver.companies", list(companies.values()))
        self.lake.upsert("silver.securities", securities)
        self.lake.upsert("silver.universe_snapshots", snapshots)
        # The same accession can occur in multiple refreshed metadata snapshots.
        # Keep the newest source metadata row; original snapshots remain in Raw.
        filing_versions = sorted(
            self.raw.payloads("filing"), key=lambda rf: (rf[0]["collected_at"], rf[0]["id"])
        )
        filings = {f["id"]: f for _, f in filing_versions}
        self.lake.upsert("silver.filings", list(filings.values()))
        self.lake.upsert("silver.concept_mappings", configuration()[1])
        flags.extend(p for _, p in self.raw.payloads("issue"))
        for code, details in [
            (
                "analyst_source_unconfigured",
                "No licensed analyst consensus provider configured; snapshots absent",
            ),
            ("ownership_source_unconfigured", "No licensed ownership provider configured; snapshots absent"),
        ]:
            if not self.raw.receipts("external-" + code.split("_")[0]):
                flags.append(dict(id=key(code), code=code, severity="coverage", details=details))
        self.lake.upsert("silver.data_quality_flags", list({r["id"]: r for r in flags}.values()))
        manifests = []
        for r in self.raw.receipts():
            row = {
                k: r[k]
                for k in [
                    "id",
                    "source_url",
                    "source_hash",
                    "storage_path",
                    "kind",
                    "size",
                    "stored_size",
                    "collected_at",
                ]
            }
            row.update(
                cik=r["metadata"].get("cik"),
                accession_number=r["metadata"].get("accession_number"),
                metadata=canonical(r["metadata"]),
            )
            manifests.append(row)
        for start in range(0, len(manifests), 1000):
            self.lake.upsert("silver.source_manifest", manifests[start : start + 1000])
        return {"companies": len(companies), "securities": len(securities), "snapshots": len(snapshots)}

    def parse(self):
        previous = {r["id"] for r in self.lake.rows("silver.parse_runs") if r["status"] == "success"}
        result = dict(parsed=0, skipped=0, failed=0)
        for _, bundle in self.raw.payloads("filing-bundle"):
            accession = bundle["filing"]["accession_number"]
            input_hash = key(bundle["documents"], PARSER_VERSION, configuration()[0])
            rid = key("parse", accession, input_hash)
            if rid in previous:
                result["skipped"] += 1
                continue
            try:
                facts, rels, flags = parse(self.raw, bundle, configuration()[0])
                # Validation exceptions indicate an incomplete parser run. Quarantine,
                # never publish a partially validated filing as successful.
                self.lake.upsert("silver.data_quality_flags", flags)
                if any("exception:" in r["details"] for r in flags):
                    raise ValueError("Arelle validation exception; see parser diagnostic")
                self.lake.replace("silver.financial_facts", facts, "accession_number", accession)
                self.lake.replace("silver.relationships", rels, "accession_number", accession)
                self.lake.upsert("silver.data_quality_flags", flags)
                self.lake.upsert(
                    "silver.parse_runs",
                    [
                        dict(
                            id=rid,
                            accession_number=accession,
                            input_hash=input_hash,
                            parser_version=PARSER_VERSION,
                            status="success",
                        )
                    ],
                )
                result["parsed"] += 1
            except Exception as error:
                flag = sec.issue(
                    self.raw, "parse_failure", error, cik=bundle["filing"]["cik"], accession=accession
                )
                self.lake.upsert("silver.data_quality_flags", [flag])
                result["failed"] += 1
        return result

    def gold(self, accessions=None):
        self.lake.upsert("gold.company_metadata", self.lake.rows("silver.companies"))
        successful = {
            r["accession_number"] for r in self.lake.rows("silver.parse_runs") if r["status"] == "success"
        }
        filings = [f for f in self.lake.rows("silver.filings") if f["accession_number"] in successful]
        result = dict(annual=0, quarterly=0, conflicts=0)
        for filing in filings:
            accession = filing["accession_number"]
            if accessions is not None and accession not in accessions:
                continue
            facts = self.lake.rows("silver.financial_facts", EqualTo("accession_number", accession))
            if not facts:
                continue
            annual, quarterly, flags = normalize(facts)
            self.lake.replace("gold.annual_reported_facts", annual, "source_accession", accession)
            self.lake.replace("gold.quarterly_reported_facts", quarterly, "source_accession", accession)
            self.lake.upsert("silver.data_quality_flags", flags)
            result["annual"] += len(annual)
            result["quarterly"] += len(quarterly)
            result["conflicts"] += len(flags)
        self.external()
        return result

    def external(self):
        for kind, table in [("analyst", "gold.analyst_estimates"), ("ownership", "gold.ownership_snapshots")]:
            rows = []
            for receipt, payload in self.raw.payloads("external-" + kind):
                for source in payload["rows"]:
                    row = dict(source, source_id=receipt["id"])
                    row["id"] = key(kind, row)
                    rows.append(row)
            self.lake.upsert(table, rows)

    def rebuild(self):
        self.lake.reset()
        silver = self.silver()
        parsed = self.parse()
        gold = self.gold()
        return dict(silver=silver, parse=parsed, gold=gold)

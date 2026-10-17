from pyiceberg.expressions import And, EqualTo, NotEqualTo

from fairfax_financial.core import key
from fairfax_financial.normalize import INPUT_COLUMNS, configuration, normalize
from fairfax_financial.numeric import consistent, precision_rank
from fairfax_financial.schema import SCHEMAS
from fairfax_financial.validation import company_facts, validate


def table_digest(pipeline, name, where=None):
    # Hash every column, one row at a time: no giant JSON/string copy of text blocks.
    scan = pipeline.lake.catalog.load_table(name).scan(**({"row_filter": where} if where is not None else {}))
    hashes = []
    for batch in scan.to_arrow_batch_reader():
        for offset in range(batch.num_rows):
            row = batch.slice(offset, 1).to_pylist()[0]
            hashes.append((row["id"], key(row)))
    return key(sorted(hashes))


def semantic_digest(pipeline):
    return {name: table_digest(pipeline, name) for name in SCHEMAS}


def test_offline_rebuild_idempotency_and_source_lineage(real_pipeline):
    p = real_pipeline
    result = p.rebuild()
    assert result["parse"] == dict(parsed=7, skipped=0, failed=0)
    facts = p.lake.rows(
        "silver.financial_facts",
        columns=(
            "id",
            "source_url",
            "source_hash",
            "context_id",
            "fact_path",
            "is_valid",
            "scale",
            "source_document",
            "dimensions",
            "taxonomy",
            "form",
            "instant_date",
            "period_start",
            "period_end",
            "accession_number",
        ),
    )
    assert len(facts) > 10_000
    assert all(f["source_url"].startswith("https://www.sec.gov/Archives/") for f in facts)
    assert all(f["source_hash"] and f["context_id"] and f["fact_path"] for f in facts)
    assert all(f["is_valid"] for f in facts)
    assert any(f["scale"] is not None for f in facts)
    assert any(f["source_document"].endswith(".xml") for f in facts)
    assert any(f["dimensions"] != "{}" for f in facts)
    assert any(f["taxonomy"] not in {"us-gaap", "dei", "srt"} for f in facts)
    assert {f["form"] for f in facts} == {"10-K", "10-Q", "10-K/A"}
    assert any(f["instant_date"] for f in facts)
    assert any(f["period_start"] and f["period_end"] for f in facts)
    rels = p.lake.rows("silver.relationships")
    assert any(r["arcrole"].endswith("parent-child") for r in rels)
    assert any(r["arcrole"].endswith("summation-item") for r in rels)
    gold = p.lake.rows("gold.annual_reported_facts") + p.lake.rows("gold.quarterly_reported_facts")
    index = {f["id"]: f for f in facts}
    for number in p.lake.rows(
        "silver.financial_facts", EqualTo("is_numeric", True), columns=("id", "value", "unit")
    ):
        index[number["id"]].update(number)
    assert gold
    assert any(g["period_kind"] == "reported_six_month_ytd" for g in gold)
    for g in gold:
        source = index[g["source_fact_id"]]
        assert g["value"] == source["value"] and g["unit"] == source["unit"]
        assert source["dimensions"] == "{}"
        assert g["source_accession"] == source["accession_number"]
        assert g["mapping_id"] in {r["id"] for r in configuration()[1]}
        if (source["period_end"] or source["instant_date"]) != next(
            f["report_date"]
            for f in p.lake.rows("silver.filings")
            if f["accession_number"] == g["source_accession"]
        ):
            assert g["fiscal_year"] is None  # No fiscal focus copied to comparative periods.
    coverage = [
        r for r in p.lake.rows("silver.data_quality_flags") if r["code"] == "canonical_fields_unavailable"
    ]
    assert coverage and all(r["severity"] == "coverage" for r in coverage)
    assert p.lake.rows("gold.analyst_estimates") == []
    assert p.lake.rows("gold.ownership_snapshots") == []
    report = validate(p)
    assert report["new_validation_issues"] == 0
    assert report["diagnostics"] > 0  # Future debt/disclosure contexts remain reported facts.
    first = semantic_digest(p)
    snapshots = {
        n: p.lake.catalog.load_table(n).current_snapshot().snapshot_id
        for n in SCHEMAS
        if p.lake.catalog.load_table(n).current_snapshot()
    }
    assert p.parse() == dict(parsed=0, skipped=7, failed=0)
    p.gold()
    validate(p)
    assert semantic_digest(p) == first
    assert all(
        p.lake.catalog.load_table(n).current_snapshot().snapshot_id == sid for n, sid in snapshots.items()
    )
    # Hard acceptance: actually purge every managed Silver/Gold table and rebuild offline.
    p.rebuild()
    validate(p)
    assert semantic_digest(p) == first


def test_companyfacts_reference_only(real_pipeline):
    p = real_pipeline
    if not p.lake.rows("silver.financial_facts", columns=("id",)):
        p.rebuild()

    class NoNetwork:
        def fetch(self, *args, **kwargs):
            raise AssertionError("Fixture reference should run without network")

    before = table_digest(p, "silver.financial_facts")
    ciks = sorted({f["cik"] for f in p.lake.rows("silver.financial_facts", columns=("cik",))})
    result = company_facts(p, NoNetwork(), ciks)
    assert result["compared"] > 2000
    assert result["mismatches"] == 0
    assert table_digest(p, "silver.financial_facts") == before


def test_reported_rounding_does_not_create_derived_values(real_pipeline):
    p = real_pipeline
    if not p.lake.rows("silver.financial_facts", columns=("id",)):
        p.rebuild()
    facts = p.lake.rows(
        "silver.financial_facts",
        And(EqualTo("concept", "Assets"), EqualTo("dimensions", "{}")),
        columns=INPUT_COLUMNS,
    )
    groups = {}
    for f in facts:
        groups.setdefault((f["accession_number"], f["instant_date"], f["unit"]), []).append(f)
    found = False
    for group in groups.values():
        if len({f["value"] for f in group}) > 1:
            found = True
            assert consistent(group)
            annual, quarterly, flags = normalize(group)
            assert not flags
            most_precise = min(group, key=lambda f: (-precision_rank(f), f["id"]))
            assert (annual + quarterly)[0]["source_fact_id"] == most_precise["id"]
            assert (annual + quarterly)[0]["value"] == most_precise["value"]
    assert found


def test_amendment_identity_is_preserved(real_pipeline):
    p = real_pipeline
    filings = p.lake.rows("silver.filings")
    amendment = next(f for f in filings if f["accession_number"] == "0000726728-19-000041")
    original = next(f for f in filings if f["accession_number"] == "0000726728-19-000038")
    assert amendment["cik"] == original["cik"]
    assert amendment["report_date"] == original["report_date"] == "2018-12-31"
    assert original["accepted_at"] < amendment["accepted_at"]
    assert original["id"] != amendment["id"]
    facts = p.lake.rows("silver.financial_facts", columns=("accession_number",))
    gold = p.lake.rows("gold.annual_reported_facts")
    for filing in [original, amendment]:
        assert any(f["accession_number"] == filing["accession_number"] for f in facts)
        assert any(g["source_accession"] == filing["accession_number"] for g in gold)


def test_source_only_mapping_configuration():
    _, rules = configuration()
    denied = {
        "roe",
        "roa",
        "free_cash_flow",
        "ttm",
        "growth",
        "price",
        "book_value_per_share",
        "current_ratio",
    }
    assert not denied & {r["field"] for r in rules}
    keys = [(r["taxonomy"], r["concept"]) for r in rules]
    assert len(keys) == len(set(keys))
    assert all(r["period_type"] in {"instant", "duration"} for r in rules)


def test_incremental_arrival_parses_only_new_real_filing(fixture_root, tmp_path):
    import shutil

    from fairfax_financial.core import Settings
    from fairfax_financial.pipeline import Pipeline
    from fairfax_financial.storage import Objects

    original = Objects(Settings(fixture_root))
    new_ref, new_bundle = next(
        (r, b)
        for r, b in original.payloads("filing-bundle")
        if b["filing"]["accession_number"] == "0000019617-17-000314"
    )
    raw_root = tmp_path / "raw"
    shutil.copytree(fixture_root / "raw", raw_root)
    (raw_root / "receipts" / "filing-bundle" / f"{new_ref['id']}.json").unlink()
    pipeline = Pipeline(Settings(tmp_path))
    pipeline.silver()
    assert pipeline.parse() == dict(parsed=6, skipped=0, failed=0)
    pipeline.gold()
    before_facts = table_digest(pipeline, "silver.financial_facts")
    before_gold = pipeline.lake.rows("gold.annual_reported_facts") + pipeline.lake.rows(
        "gold.quarterly_reported_facts"
    )
    pipeline.raw.save(original.read(new_ref), new_ref["source_url"], new_ref["kind"], new_ref["metadata"])
    assert pipeline.parse() == dict(parsed=1, skipped=6, failed=0)
    accession = new_bundle["filing"]["accession_number"]
    pipeline.gold({accession})
    old_facts = table_digest(pipeline, "silver.financial_facts", NotEqualTo("accession_number", accession))
    old_gold = [
        r
        for n in ["gold.annual_reported_facts", "gold.quarterly_reported_facts"]
        for r in pipeline.lake.rows(n)
        if r["source_accession"] != accession
    ]
    assert old_facts == before_facts
    assert key(sorted(old_gold, key=lambda r: r["id"])) == key(sorted(before_gold, key=lambda r: r["id"]))
    assert validate(pipeline, {accession})["new_validation_issues"] == 0

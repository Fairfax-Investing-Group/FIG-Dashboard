from fairfax_financial.core import key
from fairfax_financial.normalize import configuration, normalize
from fairfax_financial.numeric import consistent, precision_rank
from fairfax_financial.schema import SCHEMAS
from fairfax_financial.validation import company_facts, validate


def semantic_digest(pipeline):
    return {name: key(sorted(pipeline.lake.rows(name), key=lambda r: r["id"])) for name in SCHEMAS}


def test_offline_rebuild_idempotency_and_source_lineage(real_pipeline):
    p = real_pipeline
    result = p.rebuild()
    assert result["parse"] == dict(parsed=4, skipped=0, failed=0)
    facts = p.lake.rows("silver.financial_facts")
    assert len(facts) > 10_000
    assert all(f["source_url"].startswith("https://www.sec.gov/Archives/") for f in facts)
    assert all(f["source_hash"] and f["context_id"] and f["fact_path"] for f in facts)
    assert all(f["is_valid"] for f in facts)
    assert any(f["scale"] is not None for f in facts)
    assert any(f["dimensions"] != "{}" for f in facts)
    assert any(f["taxonomy"] not in {"us-gaap", "dei", "srt"} for f in facts)
    assert {f["form"] for f in facts} == {"10-K", "10-Q"}
    assert any(f["instant_date"] for f in facts)
    assert any(f["period_start"] and f["period_end"] for f in facts)
    rels = p.lake.rows("silver.relationships")
    assert any(r["arcrole"].endswith("parent-child") for r in rels)
    assert any(r["arcrole"].endswith("summation-item") for r in rels)
    gold = p.lake.rows("gold.annual_reported_facts") + p.lake.rows("gold.quarterly_reported_facts")
    index = {f["id"]: f for f in facts}
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
    assert p.parse() == dict(parsed=0, skipped=4, failed=0)
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
    if not p.lake.rows("silver.financial_facts"):
        p.rebuild()

    class NoNetwork:
        def fetch(self, *args, **kwargs):
            raise AssertionError("Fixture reference should run without network")

    before = key(p.lake.rows("silver.financial_facts"))
    ciks = sorted({f["cik"] for f in p.lake.rows("silver.financial_facts")})
    result = company_facts(p, NoNetwork(), ciks)
    assert result["compared"] > 2000
    assert result["mismatches"] == 0
    assert key(p.lake.rows("silver.financial_facts")) == before


def test_reported_rounding_does_not_create_derived_values(real_pipeline):
    p = real_pipeline
    if not p.lake.rows("silver.financial_facts"):
        p.rebuild()
    facts = [
        f
        for f in p.lake.rows("silver.financial_facts")
        if f["concept"] == "Assets" and f["dimensions"] == "{}"
    ]
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


def test_amendment_identity_is_preserved(real_raw):
    filings = [f for _, f in real_raw.payloads("filing")]
    amendments = [f for f in filings if f["form"].endswith("/A")]
    assert amendments
    for amendment in amendments:
        assert any(
            f["cik"] == amendment["cik"]
            and f["accession_number"] != amendment["accession_number"]
            and not f["form"].endswith("/A")
            for f in filings
        )


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

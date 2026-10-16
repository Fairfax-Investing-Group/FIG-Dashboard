import json
from pathlib import Path

from fairfax_financial.core import Settings
from fairfax_financial.storage import Objects
from fairfax_financial.universe import build


def test_real_directory_filter_and_identity(tmp_path):
    # Small verbatim source excerpts with provenance, captured by live integration run.
    fixture = Path(__file__).parent / "fixtures" / "universe.json"
    if not fixture.exists():
        import pytest

        pytest.skip("Real universe fixture has not been captured")
    source = json.loads(fixture.read_text())
    raw = Objects(Settings(tmp_path))
    refs = {}
    for kind, obj in source.items():
        refs[kind] = raw.save(obj["body"].encode(), obj["url"], kind, {"date": obj["date"]})["id"]
    raw.record(
        "universe-bundle",
        dict(
            date=source["nyse-directory"]["date"],
            nyse=[refs["nyse-directory"]],
            other=refs["other-listed"],
            tickers=refs["sec-tickers"],
        ),
    )
    companies, securities, snapshots, flags = build(raw)
    assert companies
    assert all(s["mic"] == "XNYS" for s in securities)
    assert build(raw) == (companies, securities, snapshots, flags)

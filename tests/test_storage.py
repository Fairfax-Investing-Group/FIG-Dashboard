import gzip

import pytest

from fairfax_financial.core import Blocked, Settings, company_id, security_id
from fairfax_financial.lake import Lake
from fairfax_financial.storage import Objects


def test_raw_is_immutable_and_deduplicated(tmp_path):
    raw = Objects(Settings(tmp_path))
    a = raw.save(b"source", "https://source.example/a", "test")
    b = raw.save(b"source", "https://source.example/b", "test")
    assert a["storage_path"] == b["storage_path"]
    assert len(list(raw.keys("objects/"))) == 1
    assert raw.read(a) == b"source"
    assert raw.save(b"source", "https://source.example/a", "test") == a
    with pytest.raises(ValueError, match="collision"):
        raw.put(a["storage_path"], b"different")
    (raw.root / a["storage_path"]).write_bytes(gzip.compress(b"corrupt"))
    with pytest.raises(ValueError, match="hash mismatch"):
        raw.read(a)


def test_storage_guard(tmp_path):
    with pytest.raises(Blocked, match="Storage guard"):
        Objects(Settings(tmp_path, limit_bytes=10)).save(b"source", "https://example.com", "test")


def test_stable_ids():
    assert company_id("0000019617") == company_id(19617)
    assert security_id("fig-registry", "immutable-issue") == security_id("fig-registry", "immutable-issue")


def test_iceberg_upsert(tmp_path):
    lake = Lake(Settings(tmp_path))
    lake.initialize()
    row = dict(id=company_id(19617), cik="0000019617", name="JPMORGAN CHASE & CO")
    lake.upsert("silver.companies", [row])
    first = lake.catalog.load_table("silver.companies").current_snapshot().snapshot_id
    lake.upsert("silver.companies", [row])
    assert len(lake.rows("silver.companies")) == 1
    assert lake.catalog.load_table("silver.companies").current_snapshot().snapshot_id == first
    lake.reset()
    assert lake.rows("silver.companies") == []

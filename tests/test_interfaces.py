import io

import httpx
import pytest
from botocore.response import StreamingBody
from botocore.stub import Stubber

from fairfax_financial.core import Blocked, Settings
from fairfax_financial.http import Fetcher
from fairfax_financial.lake import Lake
from fairfax_financial.storage import Objects


def test_sec_identity_refusal_and_retry_after(monkeypatch):
    calls = []
    sleeps = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "7"})
        return httpx.Response(200, content=b"source")

    monkeypatch.setattr("fairfax_financial.http.time.sleep", sleeps.append)
    h = Fetcher("", transport=httpx.MockTransport(handler))
    with pytest.raises(Blocked, match="SEC_USER_AGENT"):
        h.fetch("https://data.sec.gov/submissions/CIK0000019617.json")
    assert not calls
    h.user_agent = "Fairfax Investing Group Thomas Duong thomas@fairfaxinvestinggroup.com"
    assert h.fetch("https://data.sec.gov/submissions/CIK0000019617.json") == b"source"
    assert len(calls) == 2 and 7 in sleeps
    h.close()


def test_source_refusal_is_not_bypassed():
    h = Fetcher("", transport=httpx.MockTransport(lambda r: httpx.Response(403)))
    with pytest.raises(Blocked, match="no bypass"):
        h.fetch("https://www.nyse.com/api/quotes/filter")
    h.close()


def test_r2_s3_contract(tmp_path, monkeypatch):
    # Test-only credentials; Stubber prevents every network call.
    for name, value in {
        "R2_ENDPOINT": "https://r2.invalid",
        "R2_ACCESS_KEY_ID": "test-key",
        "R2_SECRET_ACCESS_KEY": "test-secret",
    }.items():
        monkeypatch.setenv(name, value)
    raw = Objects(Settings(tmp_path, storage="r2"))
    assert raw.client.meta.endpoint_url == "https://r2.invalid"
    with Stubber(raw.client) as stub:
        args = dict(Bucket="financial-raw", Key="objects/a")
        stub.add_client_error(
            "head_object", service_error_code="404", http_status_code=404, expected_params=args
        )
        stub.add_response("list_objects_v2", {}, dict(Bucket="financial-raw"))
        stub.add_response("list_objects_v2", {}, dict(Bucket="financial-lake"))
        stub.add_response("put_object", {}, dict(**args, Body=b"source", IfNoneMatch="*"))
        raw.put("objects/a", b"source")
        stub.add_response("head_object", dict(ContentLength=6), args)
        stub.add_response("get_object", dict(Body=StreamingBody(io.BytesIO(b"source"), 6)), args)
        raw.put("objects/a", b"source")  # Existing identical content performs no mutation.
        stub.add_response(
            "list_objects_v2",
            dict(Contents=[dict(Key="objects/a", Size=6)]),
            dict(Bucket="financial-raw", Prefix="objects/"),
        )
        assert list(raw.keys("objects/")) == ["objects/a"]
        stub.assert_no_pending_responses()


def test_basin_uses_exact_configured_rest_interface(tmp_path, monkeypatch):
    values = {
        "BASIN_CATALOG_URI": "https://catalog.invalid/exact/path",
        "BASIN_WAREHOUSE": "source-warehouse",
        "BASIN_TOKEN": "test-token",
        "R2_ENDPOINT": "https://r2.invalid",
        "R2_ACCESS_KEY_ID": "test-key",
        "R2_SECRET_ACCESS_KEY": "test-secret",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    calls = []
    monkeypatch.setattr("fairfax_financial.lake.load_catalog", lambda *a, **kw: calls.append((a, kw)))
    Lake(Settings(tmp_path, storage="r2"))
    config = calls[0][1]
    assert config["type"] == "rest"
    assert config["uri"] == values["BASIN_CATALOG_URI"]
    assert config["warehouse"] == values["BASIN_WAREHOUSE"]
    assert config["s3.region"] == "auto"


def test_no_cloud_credentials_are_invented(tmp_path, monkeypatch):
    for name in [
        "R2_ENDPOINT",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "BASIN_CATALOG_URI",
        "BASIN_WAREHOUSE",
        "BASIN_TOKEN",
    ]:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(Blocked, match="R2 requires"):
        Objects(Settings(tmp_path, storage="r2"))
    with pytest.raises(Blocked, match="Basin requires"):
        Lake(Settings(tmp_path, storage="r2"))


def test_long_retry_after_defers_batch_without_early_retry(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "120"})

    monkeypatch.setattr("fairfax_financial.http.time.sleep", lambda seconds: None)
    h = Fetcher("", transport=httpx.MockTransport(handler))
    with pytest.raises(Blocked, match="deferred without early retry"):
        h.fetch("https://source.example/data")
    with pytest.raises(Blocked, match="cooldown"):
        h.fetch("https://source.example/other")
    assert len(calls) == 1
    h.close()


def test_http_date_retry_after_is_honored(monkeypatch):
    from email.utils import parsedate_to_datetime

    deadline = "Fri, 16 Oct 2026 21:00:00 GMT"
    monkeypatch.setattr(
        "fairfax_financial.http.time.time", lambda: parsedate_to_datetime(deadline).timestamp() - 12
    )
    sleeps = []
    monkeypatch.setattr("fairfax_financial.http.time.sleep", sleeps.append)
    responses = iter(
        [httpx.Response(429, headers={"Retry-After": deadline}), httpx.Response(200, content=b"source")]
    )
    h = Fetcher("", transport=httpx.MockTransport(lambda r: next(responses)))
    assert h.fetch("https://source.example/data") == b"source"
    assert 12 in sleeps
    h.close()

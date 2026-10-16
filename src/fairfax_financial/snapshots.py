from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse

from .core import Blocked
from .schema import SCHEMAS


def ingest(pipeline, kind, path):
    if kind not in {"analyst", "ownership"}:
        raise ValueError("kind must be analyst or ownership")
    data = path.read_bytes()
    payload = json.loads(data)
    required = {"source_url", "usage_rights", "rows"}
    if not required <= payload.keys() or not payload["usage_rights"].strip():
        raise Blocked("A source URL and explicit usage-rights statement are required")
    if urlparse(payload["source_url"]).scheme != "https":
        raise ValueError("source_url must be HTTPS")
    companies = {r["id"] for r in pipeline.lake.rows("silver.companies")}
    table = "gold.analyst_estimates" if kind == "analyst" else "gold.ownership_snapshots"
    allowed = set(SCHEMAS[table].names) - {"id", "source_id"}
    for row in payload["rows"]:
        if set(row) - allowed:
            raise ValueError("Unsupported fields: " + str(set(row) - allowed))
        if not {"company_id", "source", "as_of_date", "collected_at"} <= row.keys():
            raise ValueError("Snapshot missing required provenance")
        if row["company_id"] not in companies or not row["source"].strip():
            raise ValueError("Unknown company or absent source")
        collected = datetime.fromisoformat(row["collected_at"].replace("Z", "+00:00"))
        if collected.tzinfo is None or date.fromisoformat(row["as_of_date"]) > collected.date():
            raise ValueError("Snapshot has invalid point-in-time dates")
        numeric = ["revenue_estimate", "eps_estimate", "revenue_estimate_count", "eps_estimate_count"]
        if kind == "analyst":
            if not row.get("fiscal_year") or not any(row.get(k) is not None for k in numeric[:2]):
                raise ValueError("Analyst snapshot requires fiscal year and at least one estimate")
            if row.get("revenue_estimate") is not None and not row.get("currency"):
                raise ValueError("Revenue estimate requires sourced currency")
            if row.get("eps_estimate") is not None and not row.get("eps_basis"):
                raise ValueError("EPS estimate requires provider's sourced basis")
        else:
            numeric = ["value"]
            if row.get("ownership_type") not in {"insider", "institutional"}:
                raise ValueError("ownership_type must be insider or institutional")
            if row.get("unit") not in {"percent", "fraction", "shares"}:
                raise ValueError("Unknown ownership unit")
            if row.get("value") is None:
                raise ValueError("Ownership value absent")
        for field in numeric:
            value = row.get(field)
            if value is None:
                continue
            if not isinstance(value, str):
                raise ValueError("Exact numeric values must be JSON strings, not floating-point numbers")
            try:
                number = Decimal(value)
                if not number.is_finite():
                    raise InvalidOperation()
                if field.endswith("count") and (number != int(number) or number < 0):
                    raise ValueError("Estimate counts must be nonnegative integers")
                if kind == "ownership":
                    cap = {"fraction": 1, "percent": 100}.get(row["unit"])
                    if number < 0 or (cap is not None and number > cap):
                        raise ValueError("Ownership value outside sourced unit range")
            except InvalidOperation as error:
                raise ValueError("Invalid snapshot numeric value") from error
    pipeline.raw.save(
        data, payload["source_url"], "external-" + kind, {"usage_rights": payload["usage_rights"]}
    )
    pipeline.external()
    pipeline.silver()
    return dict(kind=kind, rows=len(payload["rows"]), source=payload["source_url"])

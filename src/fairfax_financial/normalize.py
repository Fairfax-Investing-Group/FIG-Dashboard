from __future__ import annotations

import json
from datetime import date
from decimal import Decimal, InvalidOperation
from importlib.resources import files

from .core import canonical, key
from .numeric import consistent, precision_rank


def configuration():
    data = files("fairfax_financial").joinpath("mappings.json").read_text()
    rules = json.loads(data)
    version = "1/" + key(rules)[:16]
    rows = []
    for rule in rules:
        rows.append(
            dict(
                id=key(version, rule),
                version=version,
                **{k: rule[k] for k in ("taxonomy", "concept", "field", "period_type", "unit_kind")},
                rule=canonical(rule),
            )
        )
    return version, rows


def period_kind(fact):
    if fact["instant_date"]:
        return "instant"
    if not fact["period_start"] or not fact["period_end"]:
        return None
    days = (date.fromisoformat(fact["period_end"]) - date.fromisoformat(fact["period_start"])).days + 1
    # Shape labels do not assign fiscal years or infer standalone quarters.
    for label, lo, hi in [
        ("reported_quarter", 70, 110),
        ("reported_six_month_ytd", 150, 210),
        ("reported_nine_month_ytd", 240, 300),
        ("reported_annual", 330, 400),
    ]:
        if lo <= days <= hi:
            return label
    return "reported_other_duration"


def normalize(facts):
    version, mappings = configuration()
    lookup = {(r["taxonomy"], r["concept"]): r for r in mappings}
    groups, flags = {}, []

    def flag(code, candidates, details):
        sample = candidates[0][0]
        payload = dict(
            code=code,
            severity="error",
            company_id=sample["company_id"],
            accession_number=sample["accession_number"],
            fact_id=sample["id"],
            details=details,
            source_id=None,
        )
        payload["id"] = key(payload)
        flags.append(payload)

    for f in facts:
        rule = lookup.get((f["taxonomy"], f["concept"]))
        if not rule or not f["is_numeric"] or not f["is_valid"] or f["is_nil"] or f["dimensions"] != "{}":
            continue
        kind = period_kind(f)
        if bool(f["instant_date"]) != (rule["period_type"] == "instant"):
            flag("mapping_period_mismatch", [(f, rule, kind)], rule["id"])
            continue
        unit = json.loads(f["unit"] or "{}")
        num, den = unit.get("numerator", []), unit.get("denominator", [])
        currency = len(num) == 1 and len(num[0]) == 3 and num[0].isupper()
        valid_unit = {
            "money": currency and not den,
            "shares": num == ["shares"] and not den,
            "per_share": currency and den == ["shares"],
        }.get(rule["unit_kind"], False)
        if not valid_unit:
            flag("mapping_unit_mismatch", [(f, rule, kind)], f["unit"])
            continue
        try:
            if not Decimal(f["value"]).is_finite():
                raise InvalidOperation()
        except (InvalidOperation, TypeError):
            flag("invalid_numeric_value", [(f, rule, kind)], str(f["value"]))
            continue
        group = (
            f["company_id"],
            f["accession_number"],
            rule["field"],
            f["period_start"],
            f["period_end"],
            f["instant_date"],
            f["unit"],
        )
        groups.setdefault(group, []).append((f, rule, kind))
    annual, quarterly = [], []
    for group, candidates in sorted(groups.items(), key=lambda x: canonical(x[0])):
        # Never resolve contradictory alternatives by an arbitrary priority.
        if not consistent([f for f, _, _ in candidates]):
            flag("conflicting_canonical_facts", candidates, canonical([f["id"] for f, _, _ in candidates]))
            continue
        f, rule, kind = min(candidates, key=lambda x: (-precision_rank(x[0]), x[0]["id"]))
        row = dict(
            id=key(group, version),
            company_id=f["company_id"],
            cik=f["cik"],
            fiscal_year=f["fiscal_year"],
            fiscal_period=f["fiscal_period"],
            period_start=f["period_start"],
            period_end=f["period_end"],
            instant_date=f["instant_date"],
            period_kind=kind,
            form=f["form"],
            filed_at=f["filed_at"],
            accepted_at=f["accepted_at"],
            source_accession=f["accession_number"],
            field=rule["field"],
            value=f["value"],
            unit=f["unit"],
            source_fact_id=f["id"],
            mapping_id=rule["id"],
            normalization_version=version,
        )
        if kind == "reported_annual" or (kind == "instant" and f["form"].startswith("10-K")):
            annual.append(row)
        else:
            quarterly.append(row)
    return annual, quarterly, flags

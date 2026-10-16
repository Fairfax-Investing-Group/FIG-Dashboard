"""Temporary XBRL accuracy checks, never persisted as financial measurements."""

from decimal import Decimal


def precision_rank(fact):
    decimals = fact.get("decimals")
    if decimals == "INF":
        return Decimal("Infinity")
    if decimals and decimals.lstrip("-").isdigit():
        return Decimal(decimals)
    precision = fact.get("precision")
    if precision == "INF":
        return Decimal("Infinity")
    if precision and precision.isdigit():
        value = Decimal(fact["value"])
        return Decimal(precision) - value.copy_abs().adjusted() - 1 if value else Decimal("Infinity")
    return Decimal("-Infinity")


def interval(fact):
    value = Decimal(fact["value"])
    rank = precision_rank(fact)
    # Unknown accuracy cannot justify reconciliation of unequal values.
    radius = Decimal(0) if not rank.is_finite() else Decimal("0.5") * Decimal(10) ** -int(rank)
    return value - radius, value + radius


def consistent(facts):
    intervals = [interval(f) for f in facts]
    return max(lo for lo, _ in intervals) <= min(hi for _, hi in intervals)

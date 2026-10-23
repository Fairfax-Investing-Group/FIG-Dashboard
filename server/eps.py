"""Rebase SEC diluted EPS using split events after each source filing's share basis."""
from __future__ import annotations

from datetime import date
import math


def normalize_eps(rows: list, splits: list, as_of: str, history_start: str | None = None) -> list:
    adjusted = []
    events = []
    end = date.fromisoformat(as_of)
    start = date.fromisoformat(history_start) if history_start else None
    for event in splits:
        split_date = date.fromisoformat(event['date'])
        ratio = float(event['ratio'])
        if not math.isfinite(ratio) or ratio <= 0:
            raise ValueError('Invalid stock split ratio.')
        if split_date <= end:
            events.append((split_date, ratio))
    for row in rows:
        # Always start from the retained SEC value, making normalization idempotent.
        reported = row.get('epsReported', row.get('eps'))
        item = {**row, 'eps': None, 'epsReported': reported, 'epsSplitFactor': None}
        source = row.get('epsSource')
        if reported is not None and source and source.get('filed'):
            try:
                basis_date = date.fromisoformat(source['filed'])
            except (ValueError, TypeError):
                adjusted.append(item)
                continue
            if basis_date > end or (start and basis_date < start):
                adjusted.append(item)
                continue
            factor = math.prod(ratio for split_date, ratio in events if split_date > basis_date)
            value = reported / factor
            if not math.isfinite(value):
                raise ValueError('EPS split adjustment produced an invalid value.')
            item.update(eps=value, epsSplitFactor=factor)
        adjusted.append(item)
    return adjusted

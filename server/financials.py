"""Normalize SEC Company Facts annual durations without confusing filing FY with period FY."""
from __future__ import annotations

from datetime import date
import math
import re

# Order matters: prefer the broadest standard concept over overlapping alternatives.
CONCEPTS = {
    'sales': [
        ('us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'),
        ('us-gaap', 'RevenueFromContractWithCustomerIncludingAssessedTax'),
        ('us-gaap', 'Revenues'),
        ('us-gaap', 'SalesRevenueNet'),
        ('ifrs-full', 'Revenue'),
    ],
    'eps': [
        ('us-gaap', 'EarningsPerShareDiluted'),
        ('ifrs-full', 'DilutedEarningsLossPerShare'),
    ],
    'pretaxProfit': [
        ('us-gaap', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest'),
        ('us-gaap', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'),
        ('us-gaap', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterest'),
        ('ifrs-full', 'ProfitLossBeforeTax'),
    ],
}
ANNUAL_FORMS = {'10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A'}
ANNUAL_FALLBACK_FORMS = {'6-K', '6-K/A'}


def annual_facts(payload: dict, metric: str, today: date) -> list:
    result = []
    for priority, (taxonomy, concept) in enumerate(CONCEPTS[metric]):
        units = payload.get('facts', {}).get(taxonomy, {}).get(concept, {}).get('units', {})
        for unit, facts in units.items():
            if not re.fullmatch(r'[A-Z]{3}' + (r'/shares' if metric == 'eps' else ''), unit):
                continue
            for fact in facts:
                try:
                    start, end = date.fromisoformat(fact['start']), date.fromisoformat(fact['end'])
                    filed = date.fromisoformat(fact['filed'])
                    value = float(fact['val'])
                except (KeyError, ValueError, TypeError):
                    continue
                # Quarterly and YTD facts must never become annual chart points.
                if fact.get('form') not in ANNUAL_FORMS | ANNUAL_FALLBACK_FORMS or not 330 <= (end - start).days <= 380:
                    continue
                if end > today or filed > today or not math.isfinite(value):
                    continue
                result.append({
                    'start': str(start), 'end': str(end), 'value': value, 'unit': unit,
                    'filed': str(filed), 'accession': fact.get('accn'),
                    'concept': f'{taxonomy}:{concept}', 'priority': priority,
                    'form': fact['form'], 'formPriority': int(fact['form'] not in ANNUAL_FORMS),
                })
    return result


def normalize_financials(payload: dict, today: date | None = None) -> dict:
    today = today or date.today()
    candidates = {metric: annual_facts(payload, metric, today) for metric in CONCEPTS}
    # Use the most recent annual reporting currency, never a mixture of currencies.
    all_facts = [item for facts in candidates.values() for item in facts]
    currency_facts = sorted(all_facts, key=lambda item: (item['end'], -item['priority'], item['filed']), reverse=True)
    currency = currency_facts[0]['unit'].split('/')[0] if currency_facts else None
    currencies = {item['unit'].split('/')[0] for item in all_facts}
    for metric in candidates:
        unit = f'{currency}/shares' if metric == 'eps' else currency
        candidates[metric] = [item for item in candidates[metric] if item['unit'] == unit]

    anchor = [item for facts in candidates.values() for item in facts]
    # Use actual period ends. SEC's `fy` describes the filing, including its comparatives.
    window_start = f'{today.year - 10}-01-01'
    ends = sorted({item['end'] for item in anchor if item['end'] >= window_start}, reverse=True)
    periods = []
    for end in ends:
        # Collapse small date shifts and avoid two full-year periods from the same fiscal cycle.
        if periods and (date.fromisoformat(periods[-1]) - date.fromisoformat(end)).days < 300:
            continue
        periods.append(end)
        if len(periods) == 10:
            break

    rows = []
    for end in reversed(periods):
        row = {'periodEnd': end}
        for metric, facts in candidates.items():
            matching = [item for item in facts if abs((date.fromisoformat(item['end']) - date.fromisoformat(end)).days) <= 7]
            # Prefer concept semantics; within that concept select the newest restatement.
            matching.sort(key=lambda item: (item['formPriority'], item['priority'], -date.fromisoformat(item['filed']).toordinal(), -date.fromisoformat(item['start']).toordinal()))
            chosen = matching[0] if matching else None
            row[metric] = chosen['value'] if chosen else None
            row[f'{metric}Source'] = {k: chosen[k] for k in ('concept', 'filed', 'accession', 'unit', 'start', 'end', 'form')} if chosen else None
        rows.append(row)
    warnings = []
    if len(currencies) > 1:
        warnings.append(f'Financials use {currency}, the most recent reporting currency. Facts in other currencies are omitted, not converted.')
    if not rows:
        warnings.append('No supported full-year financial facts were found in SEC Company Facts.')
    elif len(rows) < 10:
        warnings.append(f'SEC provides {len(rows)} full-year periods for the supported financial concepts; a full decade is unavailable.')
    for previous, current in zip(rows, rows[1:]):
        if (date.fromisoformat(current['periodEnd']) - date.fromisoformat(previous['periodEnd'])).days > 550:
            warnings.append(f'Annual reporting gap between {previous["periodEnd"]} and {current["periodEnd"]}. No supported full-year facts were found for the intervening period; values are not estimated.')
    for metric, label in [('sales', 'Sales'), ('eps', 'Diluted EPS'), ('pretaxProfit', 'Pre-tax profit')]:
        missing = sum(row[metric] is None for row in rows)
        if missing:
            warnings.append(f'{label} is unavailable for {missing} of {len(rows)} periods. Missing values are not zero.')
    return {'currency': currency, 'annual': rows, 'warnings': warnings}

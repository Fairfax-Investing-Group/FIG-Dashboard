"""Check split-normalized weighted shares against earnings and other share facts."""
from copy import deepcopy
from datetime import date
import math


def positive(value):
    return isinstance(value, (int, float)) and math.isfinite(value) and value > 0


def agrees(value, reference, tolerance):
    return positive(value) and positive(reference) and abs(value / reference - 1) <= tolerance


def expected_shares(row):
    values, sources = row['Values'], row['Sources']
    eps, income = values.get('EPS'), values.get('NetIncome')
    if eps is None or income is None or not math.isfinite(eps) or abs(eps) < .05:
        return None
    # Compare the same duration, and only after the EPS share basis is verified.
    periods = [sources.get(key) or {} for key in ('EPS', 'NetIncome', 'SharesOut')]
    if not periods[0].get('SplitFactor') or not periods[2].get('SplitFactor'):
        return None
    if not periods[0].get('Start') or any(
        (source.get('Start'), source.get('End')) != (periods[0]['Start'], periods[0].get('End'))
        for source in periods[1:]
    ):
        return None
    # A common-income numerator already includes preferred distributions.
    if not (periods[1].get('Concept') or '').endswith(':NetIncomeLossAvailableToCommonStockholdersBasic'):
        income -= values.get('PrefDiv') or 0
    expected = income / eps
    return expected if positive(expected) else None


def normalize_share_counts(statements):
    """Return copies plus notices; never infer scale from a time-series jump alone.

    A candidate must match earnings/EPS within 2%, and be supported by
    period-end shares or a nearby independently earnings-validated period.
    Only known thousand-unit errors are corrected. Suspicious but unsupported
    counts are withheld rather than used to calculate misleading FCF/share.
    """
    result = deepcopy(statements)
    rows = list(result.get('annual', {}).values()) + list(result.get('quarterly', []))
    expected = [expected_shares(row) for row in rows]
    # Freeze anchors before editing, so one inferred correction cannot validate another.
    anchors = []
    for row, estimate in zip(rows, expected):
        raw = row['Values'].get('SharesOut')
        end_source = row['Sources'].get('EndShares') or {}
        end_supported = (end_source.get('SplitFactor') and end_source.get('End') == row['AsOfDataDate']
                         and agrees(row['Values'].get('EndShares'), estimate, .35)
                         and any(agrees(raw * factor if positive(raw) else None, estimate, .02)
                                 for factor in (1000, .001)))
        if agrees(raw, estimate, .02) or end_supported:
            anchors.append((row, estimate))
    notices = []
    for row, estimate in zip(rows, expected):
        if estimate is None:
            continue
        values, sources = row['Values'], row['Sources']
        raw = values.get('SharesOut')
        factors = [factor for factor in (1000, .001) if positive(raw) and agrees(raw * factor, estimate, .02)]
        if len(factors) != 1:
            continue
        factor = factors[0]
        corrected = raw * factor
        evidence = []
        end_source = sources.get('EndShares') or {}
        if end_source.get('SplitFactor') and end_source.get('End') == row['AsOfDataDate'] and agrees(values.get('EndShares'), corrected, .35):
            evidence.append({'Field': 'EndShares', 'Value': values['EndShares'], 'Source': end_source})
        for other, other_estimate in anchors:
            if other is row or ('QuarterNo' in other) != ('QuarterNo' in row):
                continue
            days = abs((date.fromisoformat(other['AsOfDataDate']) - date.fromisoformat(row['AsOfDataDate'])).days)
            if 0 < days <= (200 if 'QuarterNo' in row else 800) and agrees(other_estimate, corrected, .35):
                evidence.append({'Field': 'SharesOut', 'PeriodEnd': other['AsOfDataDate'],
                                 'ExpectedShares': other_estimate, 'Source': other['Sources'].get('SharesOut'),
                                 'EndSharesSource': other['Sources'].get('EndShares')})
        check = {'Status': 'corrected' if evidence else 'unverified', 'OriginalValue': raw,
                 'Factor': factor, 'ExpectedShares': estimate, 'Evidence': evidence,
                 'EstimateInputs': {key: sources.get(key) for key in ('EPS', 'NetIncome', 'PrefDiv')}}
        values['SharesOut'] = corrected if evidence else None
        sources['SharesOut'] = {**sources['SharesOut'], 'ShareCountCheck': check}
        # Basic shares can carry the same thousand-unit error. Require the now
        # validated diluted count as well as agreement with earnings/EPS.
        basic = values.get('BasicShares')
        basic_source = sources.get('BasicShares') or {}
        if evidence and basic_source.get('SplitFactor') and (
            basic_source.get('Start'), basic_source.get('End')) == (
                sources['SharesOut'].get('Start'), sources['SharesOut'].get('End')) and agrees(basic * factor if positive(basic) else None, corrected, .05):
            values['BasicShares'] = basic * factor
            sources['BasicShares'] = {**basic_source, 'ShareCountCheck': {
                **check, 'OriginalValue': basic, 'Evidence': [{'Field': 'SharesOut', 'Value': corrected}]}}
        action = f'corrected by a factor of {factor:g}' if evidence else 'withheld because corroborating share data is unavailable'
        notices.append(f"{row['AsOfDataDate']}: diluted share count {action} after earnings/EPS validation.")
    return result, notices

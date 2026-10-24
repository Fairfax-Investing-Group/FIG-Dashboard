"""Extract extended SEC statements with explicit durations, units and provenance."""
from datetime import date, timedelta
import math

from server.financials import CONCEPTS

DURATION = {
    'Sales': CONCEPTS['sales'], 'EPS': CONCEPTS['eps'], 'PTP': CONCEPTS['pretaxProfit'],
    'NetIncome': [('us-gaap', 'NetIncomeLossAvailableToCommonStockholdersBasic'), ('us-gaap', 'NetIncomeLoss'), ('us-gaap', 'ProfitLoss'), ('ifrs-full', 'ProfitLoss')],
    'SharesOut': [('us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding'), ('ifrs-full', 'AdjustedWeightedAverageShares')],
    'BasicShares': [('us-gaap', 'WeightedAverageNumberOfSharesOutstandingBasic'), ('ifrs-full', 'WeightedAverageNumberOfSharesOutstanding')],
    'Dividend': [('us-gaap', 'CommonStockDividendsPerShareDeclared'), ('us-gaap', 'CommonStockDividendsPerShareCashPaid'), ('ifrs-full', 'DividendsRecognisedAsDistributionsToOwnersPerShare')],
    'CostofRevenue': [('us-gaap', 'CostOfRevenue'), ('us-gaap', 'CostOfGoodsAndServicesSold'), ('ifrs-full', 'CostOfSales')],
    'OperatingIncome': [('us-gaap', 'OperatingIncomeLoss'), ('ifrs-full', 'ProfitLossFromOperatingActivities')],
    'OperatingCashFlow': [('us-gaap', 'NetCashProvidedByUsedInOperatingActivities'), ('ifrs-full', 'CashFlowsFromUsedInOperatingActivities')],
    'CapitalExpenditures': [('us-gaap', 'PaymentsToAcquirePropertyPlantAndEquipment'), ('ifrs-full', 'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities')],
    'IncomeTax': [('us-gaap', 'IncomeTaxExpenseBenefit'), ('ifrs-full', 'IncomeTaxExpenseContinuingOperations')],
    'PrefDiv': [('us-gaap', 'PreferredStockDividendsAndOtherAdjustments')],
    'InterestExpense': [('us-gaap', 'InterestExpenseNonOperating'), ('us-gaap', 'InterestExpenseNonoperating'), ('us-gaap', 'InterestAndDebtExpense'), ('us-gaap', 'InterestExpense'), ('ifrs-full', 'FinanceCosts')],
}
INSTANT = {
    'TotalAssets': [('us-gaap', 'Assets'), ('ifrs-full', 'Assets')],
    'CommonStockEquity': [('us-gaap', 'StockholdersEquity'), ('ifrs-full', 'EquityAttributableToOwnersOfParent')],
    'CurrentAssets': [('us-gaap', 'AssetsCurrent'), ('ifrs-full', 'CurrentAssets')],
    'CurrentLiabilities': [('us-gaap', 'LiabilitiesCurrent'), ('ifrs-full', 'CurrentLiabilities')],
    'CashEquiv': [('us-gaap', 'CashAndCashEquivalentsAtCarryingValue'), ('ifrs-full', 'CashAndCashEquivalents')],
    'ShortTermInvestments': [('us-gaap', 'ShortTermInvestments'), ('us-gaap', 'MarketableSecuritiesCurrent')],
    'AccountsReceivable': [('us-gaap', 'AccountsReceivableNetCurrent'), ('us-gaap', 'AccountsNotesAndOtherReceivablesNetCurrent'), ('ifrs-full', 'TradeAndOtherCurrentReceivables')],
    'Inventory': [('us-gaap', 'InventoryNet'), ('ifrs-full', 'Inventories')],
    'Goodwill': [('us-gaap', 'Goodwill'), ('ifrs-full', 'Goodwill')],
    'LtDebt': [('us-gaap', 'LongTermDebtNoncurrent'), ('us-gaap', 'LongTermDebt'), ('ifrs-full', 'NoncurrentBorrowings')],
    'CurrentDebt': [('us-gaap', 'LongTermDebtCurrent'), ('ifrs-full', 'CurrentPortionOfNoncurrentBorrowings')],
    'ShortTermDebt': [('us-gaap', 'ShortTermBorrowings'), ('us-gaap', 'ShortTermDebt'), ('ifrs-full', 'CurrentBorrowings')],
    'DebtTotalReported': [('us-gaap', 'DebtAndCapitalLeaseObligations')],
    'EndShares': [('us-gaap', 'CommonStockSharesOutstanding'), ('dei', 'EntityCommonStockSharesOutstanding')],
    'PrefStock': [('us-gaap', 'PreferredStockValue')],
}
SHARES = {'SharesOut', 'BasicShares', 'EndShares'}
PER_SHARE = {'EPS', 'Dividend'}
ADDITIVE = set(DURATION) - SHARES - PER_SHARE
FORMS = {'10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F', '40-F/A', '6-K', '6-K/A'}


def facts_for(payload, field, currency, today):
    mapping = DURATION if field in DURATION else INSTANT
    unit = 'shares' if field in SHARES else f'{currency}/shares' if field in PER_SHARE else currency
    result = []
    for priority, (taxonomy, concept) in enumerate(mapping[field]):
        values = payload.get('facts', {}).get(taxonomy, {}).get(concept, {}).get('units', {}).get(unit, [])
        for fact in values:
            try:
                end, filed = date.fromisoformat(fact['end']), date.fromisoformat(fact['filed'])
                start = date.fromisoformat(fact['start']) if field in DURATION else None
                value = float(fact['val'])
            except (KeyError, ValueError, TypeError):
                continue
            if end > today or filed > today or not math.isfinite(value) or fact.get('form') not in FORMS:
                continue
            if start and (end - start).days <= 0:
                continue
            result.append({'start': start, 'end': end, 'filed': filed, 'value': value, 'priority': priority,
                           'concept': f'{taxonomy}:{concept}', 'unit': unit, 'accession': fact.get('accn'), 'form': fact.get('form')})
    return result


def select(candidates):
    return min(candidates, key=lambda fact: (fact['priority'], -fact['filed'].toordinal(), -(fact['start'] or fact['end']).toordinal())) if candidates else None


def provenance(fact):
    return {'Concept': fact['concept'], 'Filed': str(fact['filed']), 'Accession': fact['accession'], 'Form': fact['form'], 'Unit': fact['unit'],
            'Start': str(fact['start']) if fact['start'] else None, 'End': str(fact['end'])}


def fiscal_period(end, fiscal_month):
    year = end.year + (end.month > fiscal_month)
    quarter = ((end.month - fiscal_month - 1) % 12) // 3 + 1
    return year, quarter


def extract_statements(payload, currency, annual, today=None, submissions=None):
    today = today or date.today()
    if not currency:
        return {'annual': {}, 'quarterly': []}
    candidates = {field: facts_for(payload, field, currency, today) for field in (*DURATION, *INSTANT)}
    recent = (submissions or {}).get('filings', {}).get('recent', {})
    filings = {}
    for form, report, filed, accession in zip(recent.get('form', []), recent.get('reportDate', []), recent.get('filingDate', []), recent.get('accessionNumber', [])):
        try:
            end, filing_date = date.fromisoformat(report), date.fromisoformat(filed)
        except (ValueError, TypeError):
            continue
        if form not in FORMS or end > today or filing_date > today:
            continue
        if end not in filings or filings[end]['Filed'] < filed:
            filings[end] = {'Form': form, 'Filed': filed, 'Accession': accession}
    cutoff = date(today.year - 10, 1, 1)
    # Quarter anchors must be actual roughly 90-day income periods, not YTD facts.
    ends = sorted({fact['end'] for field in ('Sales', 'EPS', 'PTP', 'NetIncome') for fact in candidates[field]
                   if fact['end'] >= cutoff and 70 <= (fact['end'] - fact['start']).days <= 110})
    # A 10-Q may expose only cumulative facts. Include its report date so Q2/Q3
    # are still extracted by differencing YTD values, even without a 90-day anchor.
    last_annual = max((date.fromisoformat(row['periodEnd']) for row in annual), default=cutoff)
    ends = sorted(set(ends) | {end for end, filing in filings.items() if end > last_annual and filing['Form'] in {'10-Q', '10-Q/A'}} |
                  {fact['end'] for field in ('Sales', 'PTP', 'NetIncome') for fact in candidates[field]
                   if fact['end'] > last_annual and fact['form'] in {'10-Q', '10-Q/A'} and 70 <= (fact['end'] - fact['start']).days <= 300})
    # Annual periods can also supply a Q4 anchor for additive statements.
    ends = sorted(set(ends) | {date.fromisoformat(row['periodEnd']) for row in annual})
    unique = []
    for end in ends:
        if unique and (end - unique[-1]).days < 60:
            unique[-1] = end
        else:
            unique.append(end)
    fiscal_month = date.fromisoformat(annual[-1]['periodEnd']).month if annual else 12

    def statement(end, full_year):
        fields, sources = {}, {}
        for field, facts in candidates.items():
            matching = [fact for fact in facts if abs((fact['end'] - end).days) <= 7 and (
                field in INSTANT or (330 <= (fact['end'] - fact['start']).days <= 380 if full_year else 70 <= (fact['end'] - fact['start']).days <= 110))]
            chosen = select(matching)
            if chosen:
                fields[field], sources[field] = chosen['value'], provenance(chosen)
            elif not full_year and field in ADDITIVE:
                # Subtract a prior cumulative period of the same concept/unit/start.
                current = select([fact for fact in facts if abs((fact['end'] - end).days) <= 7 and 150 <= (fact['end'] - fact['start']).days <= 380])
                if current:
                    previous = select([fact for fact in facts if fact['concept'] == current['concept'] and fact['start'] == current['start'] and
                                       70 <= (current['end'] - fact['end']).days <= 110 and fact['filed'] <= current['filed']])
                    if previous:
                        fields[field] = current['value'] - previous['value']
                        sources[field] = {**provenance(current), 'Start': str(previous['end'] + timedelta(days=1)), 'DerivedFrom': [provenance(current), provenance(previous)], 'Calculation': 'current-YTD minus prior-YTD'}
        if full_year:
            for key in ('TotalAssets', 'CommonStockEquity'):
                beginning = select([fact for fact in candidates[key] if 330 <= (end - fact['end']).days <= 380])
                if beginning:
                    fields[f'{key}Begin'], sources[f'{key}Begin'] = beginning['value'], provenance(beginning)
        filing = filings.get(end)
        if not filing:
            primary = next((sources[key] for key in ('Sales', 'EPS', 'PTP', 'NetIncome') if key in sources), {})
            filing = {key: primary[key] for key in ('Form', 'Filed', 'Accession') if key in primary}
        return {**filing, 'AsOfDataDate': str(end), 'FiscalYear': end.year if full_year else fiscal_period(end, fiscal_month)[0],
                **({} if full_year else {'QuarterNo': fiscal_period(end, fiscal_month)[1]}), 'Values': fields, 'Sources': sources}

    return {'annual': {row['periodEnd']: statement(date.fromisoformat(row['periodEnd']), True) for row in annual},
            'quarterly': [statement(end, False) for end in unique]}


def adjust_statement(statement, splits, as_of, history_start):
    """Normalize share counts and every per-share fact on its own filing basis."""
    result = {**statement, 'Values': dict(statement['Values']), 'Sources': dict(statement['Sources'])}
    for field in SHARES | PER_SHARE:
        if field not in result['Values']:
            continue
        source = result['Sources'].get(field) or {}
        filed = source.get('Filed')
        verified = filed and history_start and as_of and history_start <= filed <= as_of and splits is not None
        factor = math.prod(event['ratio'] for event in splits if filed < event['date'] <= as_of) if verified else None
        if factor is None or not math.isfinite(factor) or factor <= 0:
            result['Values'][field] = None
            continue
        value = result['Values'][field] * factor if field in SHARES else result['Values'][field] / factor
        result['Values'][field] = value if math.isfinite(value) else None
        result['Sources'][field] = {**source, 'SplitFactor': factor, 'SplitAsOf': as_of}
    return result

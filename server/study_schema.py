"""Versioned study JSON: millions for company totals, per-share values unscaled."""
from copy import deepcopy
from datetime import date
import math
from numbers import Real

from server.schema_fields import ANNUAL_FIELDS, AVERAGE_FIELDS, COMPANY_FIELDS, SCALE_FIELDS, STUDY_FIELDS


def finite(value):
    if isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value):
        return value if type(value) in (int, float) else float(value)
    return None


def growth_rate(annual, key):
    """Log-linear regression; rates in the JSON are decimal fractions."""
    values = [(row['FiscalYear'], row[key]) for row in annual if row[key] is not None]
    if len(values) < 2 or any(value <= 0 for _, value in values):
        return None
    mean_year = sum(year for year, _ in values) / len(values)
    mean_log = sum(math.log(value) for _, value in values) / len(values)
    variance = sum((year - mean_year) ** 2 for year, _ in values)
    if not variance:
        return None
    slope = sum((year - mean_year) * (math.log(value) - mean_log) for year, value in values) / variance
    try:
        return finite(math.expm1(slope))
    except OverflowError:
        return None


def fact_source(source):
    if not source:
        return None
    return {field.title(): source.get(field) for field in ('concept', 'filed', 'accession', 'unit', 'start', 'end')}


def normalize_study(study):
    """Convert legacy snapshots to the canonical, idempotent data contract."""
    if study.get('SchemaVersion') == 1:
        return deepcopy(study)
    adjustment = study.get('epsAdjustment') or {'status': 'unavailable'}
    normalized = adjustment.get('status') == 'normalized'
    annual = []
    for row in sorted(study.get('annual', []), key=lambda row: row.get('periodEnd', '')):
        end = row.get('periodEnd')
        if not end:
            continue
        period = date.fromisoformat(end)
        sales = finite(row.get('sales'))
        ptp = finite(row.get('pretaxProfit'))
        factor = finite(row.get('epsSplitFactor'))
        eps = finite(row.get('eps')) if normalized and factor is not None and factor > 0 else None
        item = dict.fromkeys(ANNUAL_FIELDS)
        item.update({
            'FiscalYear': period.year, 'AsOfDataDate': end,
            'Sales': sales / 1_000_000 if sales is not None else None,
            'EPS': eps, 'PTP': ptp / 1_000_000 if ptp is not None else None,
            'PtpOnSales': finite(ptp / sales) if ptp is not None and sales else None,
            'NoDataForYear': all(value is None for value in (sales, eps, ptp)),
            'EPSSplitFactor': factor if eps is not None else None,
            'Sources': {name: fact_source(row.get(f'{metric}Source')) for name, metric in [('Sales', 'sales'), ('EPS', 'eps'), ('PTP', 'pretaxProfit')]},
        })
        # These are aliases of the same verified company totals, not new facts.
        item['TotalRevenue'], item['PretaxIncome'] = item['Sales'], item['PTP']
        annual.append(item)
    chart_prices = [
        {'Date': row['date'], 'Close': row['close']}
        for row in sorted(study.get('prices', []), key=lambda row: row['date'])
        if finite(row.get('close')) is not None
    ]
    interval = study.get('priceInterval', '1d')
    daily = chart_prices if interval == '1d' else []
    weekly = chart_prices if interval == '1wk' else []
    monthly = {}
    for point in daily:
        month = point['Date'][:7]
        monthly[month] = {'Month': month, 'Date': point['Date'], 'Close': point['Close']}
    company = study.get('company') or {}
    identity = dict.fromkeys(COMPANY_FIELDS)
    cik = company.get('cik')
    identity.update({
        'Ticker': company.get('ticker'), 'CompanyName': company.get('name'), 'FullName': company.get('name'),
        'ExchangeType': company.get('exchange'), 'CentralIndexKey': f'{cik:010d}' if cik is not None else None,
        'FiscalYearLast': annual[-1]['FiscalYear'] if annual else None,
        'FYMonth': date.fromisoformat(annual[-1]['AsOfDataDate']).month if annual else None,
        'ClosingPrice': daily[-1]['Close'] if daily else None,
        'DateOfClosingPrice': daily[-1]['Date'] if daily else None,
    })
    header = dict.fromkeys(STUDY_FIELDS)
    header.update({
        'StudyID': study['id'], 'StudyName': f"{company.get('ticker', '')} stock study".strip(),
        'Ticker': company.get('ticker'), 'DateCreated': study.get('createdAt'),
        'DateModified': study.get('createdAt'), 'Saved': True,
    })
    sources = {}
    for key, name in [('sec', 'SEC'), ('yfinance', 'YahooFinance')]:
        source = study.get('sources', {}).get(key, {})
        sources[name] = {
            'Status': source.get('status', 'error'), 'URL': source.get('url', ''),
            'RetrievedAt': source.get('retrievedAt'), 'Error': source.get('error'),
        }
    document = {
        'SchemaVersion': 1, 'CompanyTK6': None, 'Study': header,
        'ScaleFactors': dict.fromkeys(SCALE_FIELDS), 'Company': identity,
        'AnnualData': annual, 'QuarterlyData': [], 'Peers': [], 'IndustryAverage': [],
        'IndustryAvgsAndRates': dict.fromkeys(AVERAGE_FIELDS), 'PeerGroupAverage': [],
        'PeerGroupAvgsAndRates': dict.fromkeys(AVERAGE_FIELDS),
        'ComputedValues': {
            'GrowthMethod': 'log-linear-regression',
            **{f'{key}GrowthRate': growth_rate(annual, key) for key in ('Sales', 'EPS', 'PTP')},
        },
        'DailyPrices': daily, 'WeeklyPrices': weekly, 'MonthlyPrices': list(monthly.values()),
        'LegendSeries': [{'Key': key, 'Name': name, 'Color': color} for key, name, color in [('Sales', 'Sales', '#36a655'), ('EPS', 'Split-normalized EPS', '#d946cf'), ('PTP', 'Pre-tax profit', '#2874d0'), ('Price', 'Split-normalized price', '#64748b')]], 'Notes': [], 'AnalystEstimates': [], 'StudyAudit': None,
        'Metadata': {
            'FinancialCurrency': study.get('financialCurrency'), 'PriceCurrency': study.get('priceCurrency'),
            'Units': {'CompanyTotals': 'millions', 'PerShare': 'currency/share', 'Rates': 'decimal-fraction', 'Dates': 'ISO-8601'},
            'EPSAdjustment': {
                'Status': adjustment['status'], 'AsOf': adjustment.get('asOf'),
                'Method': adjustment.get('method'), 'HistoryStart': adjustment.get('historyStart'),
                'Events': [{'Date': event['date'], 'Ratio': event['ratio']} for event in adjustment.get('events', [])],
            },
            'PriceAdjustment': 'split-adjusted-without-dividends',
            'PriceInterval': interval,
            'Sources': sources, 'Warnings': list(study.get('warnings', [])),
            'UnavailableSections': ['QuarterlyData', 'Peers', 'IndustryAverage', 'PeerGroupAverage', 'AnalystEstimates', 'ScaleFactors'],
        },
    }

    from server.enrichment import apply_enrichment
    return apply_enrichment(document, study)

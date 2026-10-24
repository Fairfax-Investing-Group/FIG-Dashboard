"""Map additional SEC/Yahoo observations into the study contract."""
from datetime import date, timedelta
import math

from server.study_schema import finite, growth_rate
from server.schema_fields import ANNUAL_FIELDS, COMPANY_FIELDS, AVERAGE_FIELDS

PER_SHARE = {'EPS', 'Dividend', 'BookValue', 'CashFlow', 'HighPrice', 'LowPrice'}
RATIOS = {'PtpOnSales', 'ROE', 'DTC', 'TaxRate', 'Payout', 'CurrentRatio', 'QuickRatio', 'InterestCoverage', 'HighPE', 'LowPE'}


def divide(numerator, denominator):
    return finite(numerator / denominator) if numerator is not None and denominator is not None and denominator != 0 else None


def sum_complete(values):
    return sum(values) if all(value is not None for value in values) else None


def statement_record(statement, history, price_currency, financial_currency):
    values = {key: finite(value) for key, value in statement['Values'].items()}
    sources = dict(statement['Sources'])

    def derived(key, value, inputs, description):
        values[key] = finite(value)
        if values[key] is not None:
            sources[key] = {'Calculation': description, 'Inputs': {name: sources.get(name) for name in inputs}}

    derived('FreeCashFlow', values.get('OperatingCashFlow') - values.get('CapitalExpenditures') if values.get('OperatingCashFlow') is not None and values.get('CapitalExpenditures') is not None else None,
            ['OperatingCashFlow', 'CapitalExpenditures'], 'operating cash flow minus capital expenditures')
    debt = values.get('TotalDebt', values.get('DebtTotalReported'))
    if debt is None:
        debt = sum_complete([values.get('LtDebt'), values.get('CurrentDebt'), values.get('ShortTermDebt')])
        # A combined long-term debt fact cannot be added to its current portion.
        if (sources.get('LtDebt') or {}).get('Concept', '').endswith(':LongTermDebt'):
            debt = None
    if values.get('TotalDebt') is None:
        derived('TotalDebt', debt, ['DebtTotalReported'] if values.get('DebtTotalReported') is not None else ['LtDebt', 'CurrentDebt', 'ShortTermDebt'], 'reported total debt, or complete sum of noncurrent/current/short-term debt')
    for key, num, den in [('PtpOnSales', 'PTP', 'Sales'), ('TaxRate', 'IncomeTax', 'PTP'), ('CurrentRatio', 'CurrentAssets', 'CurrentLiabilities'), ('Payout', 'Dividend', 'EPS'),
                          ('BookValue', 'CommonStockEquity', 'EndShares'), ('CashFlow', 'FreeCashFlow', 'SharesOut')]:
        derived(key, divide(values.get(num), values.get(den)), [num, den], f'{num} / {den}')
    equity = values.get('CommonStockEquity')
    avg_equity = sum_complete([equity, values.get('CommonStockEquityBegin')])
    derived('ROE', divide(values.get('NetIncome'), avg_equity / 2 if avg_equity is not None else None), ['NetIncome', 'CommonStockEquity', 'CommonStockEquityBegin'], 'net income / average beginning and ending common equity')
    derived('DTC', divide(values.get('LtDebt'), sum_complete([values.get('LtDebt'), equity])), ['LtDebt', 'CommonStockEquity'], 'long-term debt / (long-term debt + common equity)')
    liquid = sum_complete([values.get('CashEquiv'), values.get('ShortTermInvestments'), values.get('AccountsReceivable')])
    derived('QuickRatio', divide(liquid, values.get('CurrentLiabilities')), ['CashEquiv', 'ShortTermInvestments', 'AccountsReceivable', 'CurrentLiabilities'], '(cash + short-term investments + receivables) / current liabilities')
    interest = values.get('InterestExpense')
    derived('InterestCoverage', divide(sum_complete([values.get('PTP'), interest]), interest), ['PTP', 'InterestExpense'], '(pre-tax profit + interest expense) / interest expense')
    for key, original in [('TotalRevenue', 'Sales'), ('PretaxIncome', 'PTP'), ('NetIncomeCommon', 'NetIncome')]:
        values[key], sources[key] = values.get(original), sources.get(original)
    # Real daily intraday high/low values, never maxima/minima of daily closes.
    end = statement['AsOfDataDate']
    start = (sources.get('Sales') or sources.get('PTP') or {}).get('Start')
    eligible = [point for point in history if start and start <= point['date'] <= end]
    complete = eligible and (date.fromisoformat(eligible[0]['date']) - date.fromisoformat(start)).days <= 7 and (date.fromisoformat(end) - date.fromisoformat(eligible[-1]['date'])).days <= 7
    if complete and price_currency == financial_currency:
        for field, column, function in [('HighPrice', 'high', max), ('LowPrice', 'low', min)]:
            observed = [finite(point.get(column)) for point in eligible]
            if all(value is not None for value in observed):
                values[field] = function(observed)
                sources[field] = {'Provider': 'Yahoo Finance', 'Start': start, 'End': end, 'SplitAdjusted': True}
        for field, price in [('HighPE', 'HighPrice'), ('LowPE', 'LowPrice')]:
            derived(field, divide(values.get(price), values.get('EPS')) if (values.get('EPS') or 0) > 0 else None, [price, 'EPS'], f'{price} / split-normalized EPS')
    record = dict.fromkeys(ANNUAL_FIELDS)
    record.update({'FiscalYear': statement['FiscalYear'], 'AsOfDataDate': end, 'Sources': sources})
    record.update({key: statement[key] for key in ('Form', 'Filed', 'Accession') if key in statement})
    if 'QuarterNo' in statement:
        record['QuarterNo'] = statement['QuarterNo']
    for key in ANNUAL_FIELDS:
        if key in values:
            value = values[key]
            record[key] = value if key in PER_SHARE | RATIOS or value is None else value / 1_000_000
    record['NoDataForYear'] = all(record.get(key) is None for key in ('Sales', 'EPS', 'PTP'))
    record['EPSSplitFactor'] = (sources.get('EPS') or {}).get('SplitFactor')
    return record


PROFILE_FIELDS = {
    'WebURL': 'website', 'SectorDesc': 'sector', 'IndustryDesc': 'industry', 'SectorCode': 'sectorKey', 'IndustryCode': 'industryKey', 'Description': 'longBusinessSummary',
    'FullName': 'longName', 'Country': 'country', 'beta': 'beta', 'InsiderOwnershipPct': 'heldPercentInsiders',
    'InstitutionalOwnershipPct': 'heldPercentInstitutions', 'Dividend': 'trailingAnnualDividendRate',
    'IndicatedDividend': 'dividendRate', 'HighPriceTtm': 'fiftyTwoWeekHigh', 'LowPriceTtm': 'fiftyTwoWeekLow',
}


def enrich_company(document, profile, annual, quarterly):
    company = document['Company']
    # Company totals are stored in millions, including share and volume counts.
    for field, key in [('MarketCap', 'marketCap'), ('EnterpriseValue', 'enterpriseValue'),
                       ('SharesOutstanding', 'sharesOutstanding'), ('AverageVolume', 'averageVolume')]:
        value = finite(profile.get(key))
        company[field] = value / 1e6 if value is not None else None
    for field, key in PROFILE_FIELDS.items():
        value = profile.get(key)
        if isinstance(value, str):
            company[field] = value
        elif finite(value) is not None:
            company[field] = value * 100 if field in {'InsiderOwnershipPct', 'InstitutionalOwnershipPct'} else value
    # Quote-currency per-share fields cannot silently be combined with another reporting currency.
    if document['Metadata']['PriceCurrency'] != document['Metadata']['FinancialCurrency']:
        for key in ('Dividend', 'IndicatedDividend'):
            company[key] = None
    company['DatasourceType'] = company['DataSource'] = 'SEC Company Facts + Yahoo Finance'
    company['GroupType'] = profile.get('quoteType')
    if profile.get('financialCurrency') == document['Metadata']['FinancialCurrency']:
        if company.get('TotalDebt') is None and finite(profile.get('totalDebt')) is not None:
            company['TotalDebt'] = profile['totalDebt'] / 1e6
    if annual:
        last = annual[-1]
        for field in ('TotalDebt',):
            if last.get(field) is not None:
                company[field] = last[field]
    if not quarterly:
        return
    last = quarterly[-1]
    ago = next((row for row in reversed(quarterly) if row['FiscalYear'] == last['FiscalYear'] - 1 and row['QuarterNo'] == last['QuarterNo']), None)
    company.update({'YearLast': last['FiscalYear'], 'QuarterLast': last['QuarterNo'], 'QuarterLastDataDate': last['AsOfDataDate'], 'DateOfLastQuarter': last['AsOfDataDate'],
                    'YearAgo': ago['FiscalYear'] if ago else None, 'YearAgoQuarter': ago['QuarterNo'] if ago else None})
    if last.get('TotalDebt') is not None:
        company['TotalDebt'] = last['TotalDebt']
    for prefix, metric in [('EPS', 'EPS'), ('Sales', 'Sales'), ('TotalDebt', 'TotalDebt'), ('DTC', 'DTC')]:
        current, prior = last.get(metric), ago.get(metric) if ago else None
        company[f'{prefix}QuarterLast'] = current
        company[f'{prefix}QuarterYearAgo'] = prior
        ratio = divide(current, prior)
        company[f'{prefix}QuarterChange'] = ratio - 1 if ratio is not None else None
    company['QuarterLastText'] = f"Q{last['QuarterNo']} {last['FiscalYear']}"
    company['QuarterYearAgoText'] = f"Q{ago['QuarterNo']} {ago['FiscalYear']}" if ago else None
    company['BasicShares'] = last.get('BasicShares')
    company['DilutedShares'] = last.get('SharesOut')
    company['PrefStock'], company['PrefDiv'] = last.get('PrefStock'), last.get('PrefDiv')
    fields = {'CashEquiv': 'CashEquiv', 'Receivables': 'AccountsReceivable', 'Inventories': 'Inventory', 'CurrentAssets': 'CurrentAssets', 'ShortTermDebt': 'ShortTermDebt', 'Liabilities': 'CurrentLiabilities', 'TotalDebt': 'TotalDebt'}
    for name, metric in fields.items():
        for suffix, row in [('QuarterLast', last), ('QuarterYearAgo', ago)]:
            company[f'{name}{suffix}'] = row.get(metric) if row else None
    for target, original in [('TotalAssetsQuarterLast', 'TotalAssets'), ('AssetsQuarterLast', 'TotalAssets'), ('CommonStockEquityQuarterLast', 'CommonStockEquity'), ('GoodwillQuarterLast', 'Goodwill'),
                             ('CurrRatioLQ', 'CurrentRatio'), ('CurrentRatioQuarterLast', 'CurrentRatio'), ('QuickRatioLQ', 'QuickRatio'), ('QuickRatioQuarterLast', 'QuickRatio'), ('InterestCoverageQuarterLast', 'InterestCoverage')]:
        company[target] = last.get(original)
    recent = quarterly[-4:]
    consecutive = len(recent) == 4 and all((b['FiscalYear'] * 4 + b['QuarterNo']) - (a['FiscalYear'] * 4 + a['QuarterNo']) == 1 for a, b in zip(recent, recent[1:]))
    if consecutive:
        for field, metric in [('TotalRevenueTTM', 'Sales'), ('CostofRevenueTTM', 'CostofRevenue'), ('OperatingIncomeTTM', 'OperatingIncome'), ('PretaxIncomeTTM', 'PTP'), ('OperatingCashFlowTTM', 'OperatingCashFlow'), ('NetIncomeCommonTTM', 'NetIncomeCommon'), ('FreeCashFlowTTM', 'FreeCashFlow')]:
            company[field] = sum_complete([row.get(metric) for row in recent])
        interest = sum_complete([row.get('InterestExpense') for row in recent])
        company['InterestCvgTTM'] = divide(sum_complete([company.get('PretaxIncomeTTM'), interest]), interest)


def apply_enrichment(document, data):
    history = data.get('priceHistory', [])
    currency, price_currency = document['Metadata']['FinancialCurrency'], document['Metadata']['PriceCurrency']
    rich = data.get('statements') or {}
    market = data.get('market') or {}
    fallback_periods = market.get('statementFallbacks', {})
    period_ends = sorted(set(fallback_periods.get('quarterly', {})) | {row['AsOfDataDate'] for row in document['AnnualData']} |
                         {row['AsOfDataDate'] for row in rich.get('quarterly', [])})
    adjustment = data.get('epsAdjustment') or {}
    def with_fallback(statement, frequency):
        supplemental = market.get('statementFallbacks', {}).get(frequency, {}).get(statement['AsOfDataDate'], {})
        values, sources = dict(statement['Values']), dict(statement['Sources'])
        if market.get('profile', {}).get('financialCurrency') == currency:
            for key, value in supplemental.get('Values', {}).items():
                if values.get(key) is None:
                    values[key] = value
                    sources[key] = supplemental['Sources'][key]
            end = statement['AsOfDataDate']
            # Yahoo statement per-share bases are ambiguous across splits. Use
            # them only when complete split history proves no intervening split.
            verified = (adjustment.get('status') == 'normalized' and adjustment.get('historyStart') and adjustment.get('asOf') and
                        adjustment['historyStart'] <= end <= adjustment['asOf'] and
                        not any(end < event['date'] <= adjustment['asOf'] for event in adjustment.get('events', [])))
            if verified:
                preceding = [value for value in period_ends if 70 <= (date.fromisoformat(end) - date.fromisoformat(value)).days <= 110]
                start = str(date.fromisoformat(preceding[-1]) + timedelta(days=1)) if preceding else None
                if frequency == 'annual':
                    start = (sources.get('Sales') or sources.get('PTP') or {}).get('Start')
                    if not start:
                        prior_year = [value for value in period_ends if 330 <= (date.fromisoformat(end) - date.fromisoformat(value)).days <= 380]
                        start = str(date.fromisoformat(prior_year[-1]) + timedelta(days=1)) if prior_year else None
                for key, value in supplemental.get('PerShareCandidates', {}).items():
                    if values.get(key) is None and finite(value) is not None:
                        values[key] = value
                        sources[key] = {**supplemental['PerShareSources'][key], 'Start': start if key != 'EndShares' else None,
                                        'SplitFactor': 1, 'SplitAsOf': adjustment['asOf'], 'Verification': 'No splits since reporting period end'}
        return {**statement, 'Values': values, 'Sources': sources}
    annual_by_date = {row['AsOfDataDate']: row for row in document['AnnualData']}
    for end, statement in rich.get('annual', {}).items():
        original = annual_by_date.get(end)
        if original is None:
            continue
        statement = with_fallback(statement, 'annual')
        statement = {**statement, 'Values': {**statement['Values'], 'Sales': original['Sales'] * 1e6 if original['Sales'] is not None else statement['Values'].get('Sales'), 'EPS': original['EPS'], 'PTP': original['PTP'] * 1e6 if original['PTP'] is not None else statement['Values'].get('PTP')}}
        record = statement_record(statement, history, price_currency, currency)
        # Preserve the established SEC concept selection and EPS validation for the core series.
        for key in ('Sales', 'EPS', 'PTP', 'TotalRevenue', 'PretaxIncome', 'PtpOnSales', 'EPSSplitFactor'):
            if original.get(key) is not None or key in {'EPS', 'EPSSplitFactor'}:
                record[key] = original.get(key)
        record['Sources'].update({key: original['Sources'][key] for key in ('Sales', 'EPS', 'PTP') if original['Sources'].get(key) is not None})
        original.update(record)
    quarter_statements = list(rich.get('quarterly', []))
    if document['AnnualData'] and market.get('profile', {}).get('financialCurrency') == currency:
        from server.fundamentals import fiscal_period
        fiscal_month = int(document['AnnualData'][-1]['AsOfDataDate'][5:7])
        for end, supplemental in sorted(fallback_periods.get('quarterly', {}).items()):
            if date.fromisoformat(end) > date.today() or any(abs((date.fromisoformat(row['AsOfDataDate']) - date.fromisoformat(end)).days) <= 7 for row in quarter_statements):
                continue
            if not supplemental.get('Values') and not supplemental.get('PerShareCandidates'):
                continue
            year, quarter = fiscal_period(date.fromisoformat(end), fiscal_month)
            quarter_statements.append({'AsOfDataDate': end, 'FiscalYear': year, 'QuarterNo': quarter, 'Values': {}, 'Sources': {}})
    quarter_statements = [with_fallback(statement, 'quarterly') for statement in sorted(quarter_statements, key=lambda row: row['AsOfDataDate'])]
    quarterly = [statement_record(statement, history, price_currency, currency) for statement in quarter_statements]
    # Retain helper balance metrics needed for current-company snapshots.
    for row, statement in zip(quarterly, quarter_statements):
        for key in ('CashEquiv', 'CurrentAssets', 'CurrentLiabilities', 'ShortTermDebt', 'BasicShares', 'PrefStock', 'PrefDiv', 'InterestExpense'):
            value = finite(statement['Values'].get(key))
            row[key] = value / 1e6 if value is not None else None
    document['QuarterlyData'] = quarterly
    market = data.get('market') or {}
    enrich_company(document, market.get('profile') or {}, document['AnnualData'], quarterly)
    document['AnalystEstimates'] = market.get('analystEstimates', [])
    if market.get('profile', {}).get('financialCurrency') == currency:
        for field, value in market.get('companyEstimates', {}).items():
            document['Company'][field] = value
    elif document['AnalystEstimates']:
        document['AnalystEstimates'] = []
        document['Metadata']['Warnings'].append('Analyst estimates were omitted because their currency could not be matched to the reporting currency.')
    submissions = data.get('submissions') or {}
    if submissions.get('sic'):
        document['Company']['SIC'] = str(submissions['sic'])
        if str(submissions['sic']) == '6798':
            document['Company']['IsREIT'] = True
    document['Metadata']['Warnings'].extend(market.get('warnings', []))
    document['Metadata']['Sources']['YahooCompany'] = market.get('source', {'Status': 'unavailable', 'URL': None, 'RetrievedAt': None, 'Error': None})
    for key in ('Sales', 'EPS', 'PTP'):
        document['ComputedValues'][f'{key}GrowthRate'] = growth_rate(document['AnnualData'], key)
    for key in ('PtpOnSales', 'ROE', 'DTC', 'TotalDebt', 'HighPE', 'LowPE', 'Payout', 'TotalAssets'):
        observations = [row[key] for row in document['AnnualData'] if finite(row.get(key)) is not None]
        document['ComputedValues'][f'{key}Avg'] = sum(observations) / len(observations) if observations else None
    for key in document['ScaleFactors']:
        observations = [point['Close'] for point in document['DailyPrices']] if key == 'Price' else [row.get(key) for row in document['AnnualData']]
        observations = [value for value in observations if finite(value) is not None]
        baseline = next((value for value in observations if value != 0), None)
        if baseline is not None:
            indexed = [value / abs(baseline) * 100 for value in observations]
            signed = any(value <= 0 for value in indexed)
            transformed = [math.copysign(math.log1p(abs(value)), value) if signed else math.log(value) for value in indexed]
            span = max(transformed) - min(transformed)
            document['ScaleFactors'][key] = finite(3.4 / span) if span else 0
    document['Metadata']['ClassificationProvider'] = 'Yahoo Finance sector/industry keys; SEC SIC (not Morningstar classification codes)'
    document['Metadata']['ScaleFactorsMethod'] = 'dashboard log-space coefficient: bandHeight / transformed range; independent vertical offsets; not vendor chart factors'
    document['Metadata']['Units']['OwnershipPercentages'] = 'percentage-points'
    document['Metadata']['AvailableSections'] = [key for key in ('AnnualData', 'QuarterlyData', 'AnalystEstimates', 'DailyPrices', 'WeeklyPrices', 'MonthlyPrices') if document.get(key)]
    if any(value is not None for value in document['ScaleFactors'].values()):
        document['Metadata']['AvailableSections'].append('ScaleFactors')
    document['Metadata']['UnavailableSections'] = [key for key in document['Metadata']['UnavailableSections'] if (not any(value is not None for value in document['ScaleFactors'].values()) if key == 'ScaleFactors' else not document.get(key))]
    document['Metadata']['UnavailableSections'] = list(dict.fromkeys(document['Metadata']['UnavailableSections']))
    document['Metadata']['FieldCoverage'] = {
        'Company': {'Available': [key for key in COMPANY_FIELDS if document['Company'].get(key) is not None], 'Unavailable': [key for key in COMPANY_FIELDS if document['Company'].get(key) is None]},
        'AnnualData': {str(row['FiscalYear']): {'Available': [key for key in ANNUAL_FIELDS if row.get(key) is not None], 'Unavailable': [key for key in ANNUAL_FIELDS if row.get(key) is None]} for row in document['AnnualData']},
        'QuarterlyData': {f"{row['FiscalYear']}Q{row['QuarterNo']}": {'Available': [key for key in ANNUAL_FIELDS if row.get(key) is not None], 'Unavailable': [key for key in ANNUAL_FIELDS if row.get(key) is None]} for row in quarterly},
        'ProviderOnly': ['IssueId', 'DailyCompanyId', 'DailyDateId', 'QualityRating', 'FinancialScore', 'IndustryAverage', 'Morningstar peer-group universe/methodology'],
        'UserInputs': ['Study.Proj*', 'Study.PreparedBy', 'Study.Comment', 'Notes', 'outlier flags'],
    }
    document['Metadata']['Calculations'] = {'CashFlow': 'free cash flow / split-normalized diluted weighted-average shares', 'DTC': 'long-term debt / (long-term debt + common equity)',
                                             'ROE': 'net income / average beginning and ending common equity', 'TaxRate': 'income tax expense / pre-tax profit',
                                             'QuickRatio': '(cash + short-term investments + receivables) / current liabilities', 'InterestCoverage': '(pre-tax profit + interest expense) / interest expense'}
    return document

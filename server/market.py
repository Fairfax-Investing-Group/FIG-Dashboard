"""Optional Yahoo company/analyst/industry observations; price failures stay isolated."""
from datetime import date, datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import os
import yfinance as yf

from server.study_schema import finite
from server.yahoo_profile import get_profile


def estimates(profile, earnings, revenue, today=None):
    today = today or date.today()
    fiscal_end = finite(profile.get('nextFiscalYearEnd'))
    base_year = datetime.fromtimestamp(fiscal_end, timezone.utc).year if fiscal_end is not None else None
    records, company = [], {}
    if base_year is None:
        return records, company
    for period, offset in [('0y', 0), ('+1y', 1)]:
        eps = earnings.loc[period] if period in earnings.index else {}
        sales = revenue.loc[period] if period in revenue.index else {}
        amount, per_share = finite(sales.get('avg')), finite(eps.get('avg'))
        if amount is None and per_share is None:
            continue
        records.append({'FiscalYear': base_year + offset, 'SalesEst': amount / 1e6 if amount is not None else None,
                        'EpsEst': per_share, 'NumOfSalesEst': finite(sales.get('numberOfAnalysts')), 'NumOfEpsEst': finite(eps.get('numberOfAnalysts')),
                        'DataSource': 'Yahoo Finance', 'DataLocked': None, 'DataStatus': None,
                        'SplitAsOf': today.isoformat(), 'ShareBasis': 'provider-current-share-basis'})
        if period == '0y':
            company.update({'EpsCurrentAnalystEst': per_share, 'NumOfSalesAvgEst': finite(sales.get('numberOfAnalysts')), 'NumOfEpsAvgEst': finite(eps.get('numberOfAnalysts'))})
        if period == '+1y':
            company.update({'AnalystSalesEstGrowthRate': finite(sales.get('growth')), 'AnalystSalesEstGrowthAmt': amount / 1e6 if amount is not None else None,
                            'AnalystEPSEstGrowthRate': finite(eps.get('growth')), 'AnalystEPSEstGrowthAmt': per_share})
    return records, company


def statement_fallbacks(stock, profile, stock_factory=None):
    currency = profile.get('financialCurrency')
    result, failures = {'annual': {}, 'quarterly': {}}, []
    if not currency:
        return result, failures
    mappings = {
        'balance': {'TotalDebt': 'TotalDebt', 'PrefStock': 'PreferredStock', 'CashEquiv': 'CashAndCashEquivalents', 'ShortTermInvestments': 'OtherShortTermInvestments', 'CurrentAssets': 'CurrentAssets', 'CurrentLiabilities': 'CurrentLiabilities', 'TotalAssets': 'TotalAssets', 'CommonStockEquity': 'StockholdersEquity', 'AccountsReceivable': 'AccountsReceivable', 'Inventory': 'Inventory', 'Goodwill': 'Goodwill', 'LtDebt': 'LongTermDebt'},
        'income': {'InterestExpense': 'InterestExpense', 'Sales': 'TotalRevenue', 'PTP': 'PretaxIncome', 'NetIncome': 'NetIncomeCommonStockholders', 'CostofRevenue': 'CostOfRevenue', 'OperatingIncome': 'OperatingIncome', 'IncomeTax': 'TaxProvision'},
        'cashflow': {'OperatingCashFlow': 'OperatingCashFlow', 'CapitalExpenditures': 'CapitalExpenditure'},
    }
    def load_category(category):
        worker = stock_factory() if stock_factory else stock
        result, failures = {'annual': {}, 'quarterly': {}}, []
        for name, freq in [('annual', 'yearly'), ('quarterly', 'quarterly')]:
            try:
                frame = worker.get_balance_sheet(freq=freq) if category == 'balance' else worker.get_income_stmt(freq=freq) if category == 'income' else worker.get_cash_flow(freq=freq)
                for column in frame.columns:
                    end = column.date().isoformat()
                    row = result[name].setdefault(end, {'Values': {}, 'Sources': {}})
                    for target, key in mappings[category].items():
                        if key in frame.index:
                            value = finite(frame.at[key, column])
                            if value is not None:
                                row['Values'][target] = -value if category == 'cashflow' and target == 'CapitalExpenditures' else value
                                row['Sources'][target] = {'Provider': 'Yahoo Finance', 'Field': key, 'End': end, 'Unit': currency, 'Duration': 'annual' if name == 'annual' else 'instant' if category == 'balance' else 'standalone-quarter'}
                    # Keep per-share inputs separate until split-history verification.
                    share_fields = {'EndShares': 'OrdinarySharesNumber'} if category == 'balance' else {'EPS': 'DilutedEPS', 'SharesOut': 'DilutedAverageShares'} if category == 'income' else {}
                    for target, key in share_fields.items():
                        if key in frame.index and finite(frame.at[key, column]) is not None:
                            row.setdefault('PerShareCandidates', {})[target] = finite(frame.at[key, column])
                            row.setdefault('PerShareSources', {})[target] = {'Provider': 'Yahoo Finance', 'Field': key, 'End': end, 'Unit': f'{currency}/shares' if target == 'EPS' else 'shares'}
            except Exception:
                failures.append(f'{name} {category} statement fallback')
        return result, failures

    if stock_factory:
        with ThreadPoolExecutor(max_workers=3) as executor:
            categories = list(executor.map(load_category, ('balance', 'income', 'cashflow')))
    else:
        categories = [load_category(category) for category in ('balance', 'income', 'cashflow')]
    for category, errors in categories:
        failures.extend(errors)
        for frequency, periods in category.items():
            for end, values in periods.items():
                row = result[frequency].setdefault(end, {})
                for section, fields in values.items():
                    row.setdefault(section, {}).update(fields)

    return result, failures


def fallback_financials(market):
    profile = market.get('profile') or {}
    currency = profile.get('financialCurrency')
    if not currency:
        return None
    raw = market.get('statementFallbacks') or {}
    annual = []
    statements = {'annual': {}, 'quarterly': []}
    for end, statement in sorted(raw.get('annual', {}).items()):
        values = statement['Values']
        if values.get('Sales') is None and values.get('PTP') is None:
            continue
        row = {'periodEnd': end, 'sales': values.get('Sales'), 'pretaxProfit': values.get('PTP'), 'eps': None}
        for metric, key in [('sales', 'Sales'), ('pretaxProfit', 'PTP')]:
            src = statement['Sources'].get(key)
            row[f'{metric}Source'] = {'concept': f"Yahoo Finance:{src['Field']}", 'filed': None, 'accession': None, 'unit': currency, 'start': None, 'end': end} if src else None
        annual.append(row)
        statements['annual'][end] = {**statement, 'FiscalYear': int(end[:4]), 'AsOfDataDate': end}
    if not annual:
        return None
    from server.fundamentals import fiscal_period
    month = int(annual[-1]['periodEnd'][5:7])
    for end, statement in sorted(raw.get('quarterly', {}).items()):
        if statement['Values'].get('Sales') is None and statement['Values'].get('PTP') is None:
            continue
        year, quarter = fiscal_period(date.fromisoformat(end), month)
        statements['quarterly'].append({**statement, 'AsOfDataDate': end, 'FiscalYear': year, 'QuarterNo': quarter})
    return {'currency': currency, 'annual': annual, 'statements': statements,
            'warnings': ['SEC annual statements are unavailable. Yahoo statement totals are used; unverified historical per-share figures remain unavailable.']}


def peer_limit():
    try:
        return max(0, min(int(os.environ.get('STUDY_PEER_LIMIT', '3')), 5))
    except ValueError:
        return 3


def fetch_market(stock, include_peers=True, fundamentals_only=False, profile=None):
    warnings, analyst, company, peer_symbols = [], [], {}, []
    errors = []
    if profile is None:
        try:
            profile = get_profile(stock.ticker, stock=stock)
        except Exception:
            profile = {}
            errors.append('company profile')
    if fundamentals_only:
        return {'profile': profile, 'warnings': warnings,
                'source': {'Status': 'ok' if profile else 'error', 'URL': f'https://finance.yahoo.com/quote/{stock.ticker}/',
                           'RetrievedAt': datetime.now(timezone.utc).isoformat(), 'Error': ', '.join(errors) or None}}
    def analyst_data():
        # These share one yfinance analysis response, so keep this pair sequential.
        return estimates(profile, stock.get_earnings_estimate(), stock.get_revenue_estimate())

    def peers():
        limit = peer_limit()
        if not include_peers or not limit or not profile.get('industryKey'):
            return []
        top = yf.Industry(profile['industryKey']).top_companies
        return [str(symbol) for symbol in top.index if str(symbol) != stock.ticker][:limit + 2] if top is not None else []

    with ThreadPoolExecutor(max_workers=3) as executor:
        analyst_task = executor.submit(analyst_data)
        statements_task = executor.submit(statement_fallbacks, stock, profile, stock_factory=lambda: yf.Ticker(stock.ticker))
        peers_task = executor.submit(peers)
        try:
            analyst, company = analyst_task.result()
            if not analyst:
                warnings.append('Yahoo annual analyst estimates are unavailable or lack a fiscal-year anchor.')
        except Exception:
            errors.append('analyst estimates')
        fallbacks, statement_errors = statements_task.result()
        errors.extend(statement_errors)
        try:
            peer_symbols = peers_task.result()
        except Exception:
            errors.append('industry peer candidates')
    if errors:
        warnings.append(f"Yahoo {', '.join(errors)} could not be loaded; financials and prices are preserved.")
    return {'profile': profile, 'statementFallbacks': fallbacks, 'analystEstimates': analyst, 'companyEstimates': company, 'peerSymbols': peer_symbols,
            'warnings': warnings, 'source': {'Status': 'ok' if profile else 'error', 'URL': f'https://finance.yahoo.com/quote/{stock.ticker}/',
                                           'RetrievedAt': datetime.now(timezone.utc).isoformat(), 'Error': ', '.join(errors) or None}}

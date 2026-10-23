"""Optional Yahoo company/analyst/industry observations; price failures stay isolated."""
from datetime import date, datetime, timezone
import os
import yfinance as yf

from server.study_schema import finite


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


def statement_fallbacks(stock, profile):
    currency = profile.get('financialCurrency')
    result, failures = {'annual': {}, 'quarterly': {}}, []
    if not currency:
        return result, failures
    mappings = {
        'balance': {'TotalDebt': 'TotalDebt', 'PrefStock': 'PreferredStock', 'CashEquiv': 'CashAndCashEquivalents', 'ShortTermInvestments': 'OtherShortTermInvestments', 'CurrentAssets': 'CurrentAssets', 'CurrentLiabilities': 'CurrentLiabilities', 'TotalAssets': 'TotalAssets', 'CommonStockEquity': 'StockholdersEquity', 'AccountsReceivable': 'AccountsReceivable', 'Inventory': 'Inventory', 'Goodwill': 'Goodwill', 'LtDebt': 'LongTermDebt'},
        'income': {'InterestExpense': 'InterestExpense', 'Sales': 'TotalRevenue', 'PTP': 'PretaxIncome', 'NetIncome': 'NetIncomeCommonStockholders', 'CostofRevenue': 'CostOfRevenue', 'OperatingIncome': 'OperatingIncome', 'IncomeTax': 'TaxProvision'},
        'cashflow': {'OperatingCashFlow': 'OperatingCashFlow', 'CapitalExpenditures': 'CapitalExpenditure'},
    }
    for name, freq in [('annual', 'yearly'), ('quarterly', 'quarterly')]:
        for category in ('balance', 'income', 'cashflow'):
            try:
                frame = stock.get_balance_sheet(freq=freq) if category == 'balance' else stock.get_income_stmt(freq=freq) if category == 'income' else stock.get_cash_flow(freq=freq)
                for column in frame.columns:
                    end = column.date().isoformat()
                    row = result[name].setdefault(end, {'Values': {}, 'Sources': {}})
                    for target, key in mappings[category].items():
                        if key in frame.index:
                            value = finite(frame.at[key, column])
                            if value is not None:
                                row['Values'][target] = -value if category == 'cashflow' and target == 'CapitalExpenditures' else value
                                row['Sources'][target] = {'Provider': 'Yahoo Finance', 'Field': key, 'End': end, 'Unit': currency, 'Duration': 'annual' if name == 'annual' else 'instant' if category == 'balance' else 'standalone-quarter'}
            except Exception:
                failures.append(f'{name} {category} statement fallback')
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


def fetch_market(stock, include_peers=True):
    warnings, profile, analyst, company, peer_symbols = [], {}, [], {}, []
    errors = []
    try:
        profile = stock.get_info() or {}
    except Exception:
        errors.append('company profile')
    try:
        earnings, revenue = stock.get_earnings_estimate(), stock.get_revenue_estimate()
        analyst, company = estimates(profile, earnings, revenue)
        if not analyst:
            warnings.append('Yahoo annual analyst estimates are unavailable or lack a fiscal-year anchor.')
    except Exception:
        errors.append('analyst estimates')
    fallbacks, statement_errors = statement_fallbacks(stock, profile)
    errors.extend(statement_errors)
    limit = peer_limit()
    if include_peers and limit and profile.get('industryKey'):
        try:
            top = yf.Industry(profile['industryKey']).top_companies
            if top is not None:
                peer_symbols = [str(symbol) for symbol in top.index if str(symbol) != stock.ticker][:limit + 2]
        except Exception:
            errors.append('industry peer candidates')
    if errors:
        warnings.append(f"Yahoo {', '.join(errors)} could not be loaded; financials and prices are preserved.")
    return {'profile': profile, 'statementFallbacks': fallbacks, 'analystEstimates': analyst, 'companyEstimates': company, 'peerSymbols': peer_symbols,
            'warnings': warnings, 'source': {'Status': 'ok' if profile else 'error', 'URL': f'https://finance.yahoo.com/quote/{stock.ticker}/',
                                           'RetrievedAt': datetime.now(timezone.utc).isoformat(), 'Error': ', '.join(errors) or None}}

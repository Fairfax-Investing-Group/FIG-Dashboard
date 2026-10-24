from datetime import date
import unittest
from unittest.mock import Mock, patch
import pandas as pd
import numpy as np

from server.fundamentals import extract_statements, adjust_statement
from server.enrichment import statement_record
from server.market import estimates, fetch_market, fallback_financials, statement_fallbacks
from server.study_schema import finite, normalize_study
from server.peers import peer_averages


def fact(value, end='2023-12-31', start=None, filed='2024-02-01', form='10-K'):
    item = {'val': value, 'end': end, 'filed': filed, 'form': form, 'accn': 'test'}
    if start:
        item['start'] = start
    return item


def payload():
    return {'facts': {'us-gaap': {}}}


def put(data, tag, values, unit='USD'):
    data['facts']['us-gaap'][tag] = {'units': {unit: values}}


def statement(values, sources=None):
    return {'FiscalYear': 2023, 'AsOfDataDate': '2023-12-31', 'Values': values, 'Sources': sources or {}}


class FundamentalsTests(unittest.TestCase):
    def test_missing_interim_periods_are_added_without_overwriting_sec_values(self):
        end = '2026-04-30'
        supplemental = {'Values': {'Sales': 30e6, 'PTP': 6e6, 'OperatingCashFlow': 5e6, 'CapitalExpenditures': 1e6, 'CommonStockEquity': 60e6},
                        'Sources': {key: {'Provider': 'Yahoo Finance', 'Field': key, 'End': end} for key in ('Sales', 'PTP', 'OperatingCashFlow', 'CapitalExpenditures', 'CommonStockEquity')},
                        'PerShareCandidates': {'EPS': 0.6, 'SharesOut': 10e6, 'EndShares': 10e6},
                        'PerShareSources': {key: {'Provider': 'Yahoo Finance', 'Field': key, 'End': end} for key in ('EPS', 'SharesOut', 'EndShares')}}
        raw = {'id': 'test', 'company': {}, 'annual': [{'periodEnd': '2026-01-31', 'sales': 100e6}], 'warnings': [],
               'financialCurrency': 'USD', 'priceCurrency': 'USD',
               'epsAdjustment': {'status': 'normalized', 'historyStart': '2016-01-01', 'asOf': '2026-10-23', 'events': []},
               'statements': {'quarterly': [{'AsOfDataDate': '2025-07-31', 'FiscalYear': 2026, 'QuarterNo': 2, 'Form': '6-K', 'Values': {'Sales': 20e6}, 'Sources': {}}]},
               'market': {'profile': {'financialCurrency': 'USD'}, 'statementFallbacks': {'quarterly': {
                   '2025-07-31': {'Values': {'Sales': 999e6}, 'Sources': {'Sales': {'Provider': 'Yahoo Finance'}}}, end: supplemental}}}}
        rows = normalize_study(raw)['QuarterlyData']
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['Sales'], 20)
        self.assertEqual((rows[1]['FiscalYear'], rows[1]['QuarterNo']), (2027, 1))
        self.assertEqual(rows[1]['Sales'], 30)
        self.assertEqual(rows[1]['EPS'], 0.6)
        self.assertEqual(rows[1]['EPSSplitFactor'], 1)
        self.assertEqual(rows[1]['BookValue'], 6)
        self.assertEqual(rows[1]['CashFlow'], 0.4)
        self.assertEqual(rows[1]['Sources']['SharesOut']['Start'], '2026-02-01')
        raw['epsAdjustment']['events'] = [{'date': '2026-08-01', 'ratio': 2}]
        row = normalize_study(raw)['QuarterlyData'][-1]
        self.assertEqual(row['Sales'], 30)
        self.assertIsNone(row['EPS'])
        self.assertIsNone(row['CashFlow'])
        raw['market']['profile']['financialCurrency'] = 'EUR'
        self.assertEqual(len(normalize_study(raw)['QuarterlyData']), 1)

    def test_all_10qs_after_the_latest_10k_include_ytd_only_quarters(self):
        data = payload()
        put(data, 'Revenues', [fact(100, start='2023-01-01'),
            fact(20, '2024-03-31', '2024-01-01', filed='2024-05-01', form='10-Q'),
            fact(50, '2024-06-30', '2024-01-01', filed='2024-08-01', form='10-Q'),
            fact(90, '2024-09-30', '2024-01-01', filed='2024-11-01', form='10-Q')])
        submissions = {'filings': {'recent': {
            'form': ['10-Q', '10-Q', '10-Q', '10-K'],
            'reportDate': ['2024-09-30', '2024-06-30', '2024-03-31', '2023-12-31'],
            'filingDate': ['2024-11-01', '2024-08-01', '2024-05-01', '2024-02-01'],
            'accessionNumber': ['q3', 'q2', 'q1', 'annual'],
        }}}
        result = extract_statements(data, 'USD', [{'periodEnd': '2023-12-31'}], date(2024, 11, 5), submissions=submissions)
        quarters = [row for row in result['quarterly'] if row['AsOfDataDate'] > '2023-12-31']
        self.assertEqual([row['QuarterNo'] for row in quarters], [1, 2, 3])
        self.assertEqual([row['Values']['Sales'] for row in quarters], [20, 30, 40])
        self.assertEqual([row['Form'] for row in quarters], ['10-Q'] * 3)
        self.assertEqual([row['Accession'] for row in quarters], ['q1', 'q2', 'q3'])
        self.assertEqual(statement_record(quarters[-1], [], 'USD', 'USD')['Form'], '10-Q')
        without_submissions = extract_statements(data, 'USD', [{'periodEnd': '2023-12-31'}], date(2024, 11, 5))
        self.assertEqual([row['Values']['Sales'] for row in without_submissions['quarterly'] if row['AsOfDataDate'] > '2023-12-31'], [20, 30, 40])

    def test_annual_and_standalone_quarters_stay_separate(self):
        data = payload()
        put(data, 'Revenues', [fact(100, start='2023-01-01'), fact(20, '2023-03-31', '2023-01-01', form='10-Q'), fact(50, '2023-06-30', '2023-01-01', form='10-Q')])
        result = extract_statements(data, 'USD', [{'periodEnd': '2023-12-31'}], date(2026, 10, 23))
        self.assertEqual(result['annual']['2023-12-31']['Values']['Sales'], 100)
        q1 = next(row for row in result['quarterly'] if row['QuarterNo'] == 1)
        self.assertEqual(q1['Values']['Sales'], 20)
        self.assertNotIn(50, [row['Values'].get('Sales') for row in result['quarterly']])

    def test_ytd_cash_flow_is_differenced_into_one_quarter(self):
        data = payload()
        put(data, 'Revenues', [fact(30, '2023-06-30', '2023-04-01', form='10-Q')])
        put(data, 'NetCashProvidedByUsedInOperatingActivities', [fact(20, '2023-03-31', '2023-01-01', form='10-Q'), fact(50, '2023-06-30', '2023-01-01', form='10-Q')])
        quarter = extract_statements(data, 'USD', [], date(2026, 10, 23))['quarterly'][0]
        self.assertEqual(quarter['Values']['OperatingCashFlow'], 30)
        self.assertEqual(quarter['Sources']['OperatingCashFlow']['Calculation'], 'current-YTD minus prior-YTD')
        self.assertEqual(quarter['Sources']['OperatingCashFlow']['Start'], '2023-04-01')

    def test_q4_additive_values_derive_from_annual_less_nine_months_but_eps_does_not(self):
        data = payload()
        put(data, 'Revenues', [fact(100, start='2023-01-01'), fact(70, '2023-09-30', '2023-01-01', form='10-Q')])
        put(data, 'EarningsPerShareDiluted', [fact(4, start='2023-01-01'), fact(3, '2023-09-30', '2023-01-01', form='10-Q')], 'USD/shares')
        quarter = extract_statements(data, 'USD', [{'periodEnd': '2023-12-31'}], date(2026, 10, 23))['quarterly'][0]
        self.assertEqual(quarter['Values']['Sales'], 30)
        self.assertNotIn('EPS', quarter['Values'])

    def test_noncalendar_fiscal_quarter_labels(self):
        data = payload()
        put(data, 'Revenues', [fact(30, '2023-09-30', '2023-07-01', form='10-Q')])
        result = extract_statements(data, 'USD', [{'periodEnd': '2023-06-30'}], date(2026, 10, 23))
        quarter = next(row for row in result['quarterly'] if row['AsOfDataDate'] == '2023-09-30')
        self.assertEqual((quarter['FiscalYear'], quarter['QuarterNo']), (2024, 1))

    def test_instant_balances_and_beginning_balances_use_actual_dates(self):
        data = payload()
        put(data, 'Assets', [fact(80, '2022-12-31'), fact(100)])
        put(data, 'StockholdersEquity', [fact(40, '2022-12-31'), fact(60)])
        values = extract_statements(data, 'USD', [{'periodEnd': '2023-12-31'}], date(2026, 10, 23))['annual']['2023-12-31']['Values']
        self.assertEqual((values['TotalAssets'], values['TotalAssetsBegin']), (100, 80))
        self.assertEqual(values['CommonStockEquityBegin'], 40)

    def test_share_counts_and_per_share_data_are_split_normalized_in_opposite_directions(self):
        raw = statement({'SharesOut': 100, 'EPS': 8, 'Dividend': 2}, {key: {'Filed': '2024-02-01'} for key in ('SharesOut', 'EPS', 'Dividend')})
        result = adjust_statement(raw, [{'date': '2025-01-01', 'ratio': 4}], '2026-10-23', '2016-01-01')
        self.assertEqual(result['Values'], {'SharesOut': 400, 'EPS': 2, 'Dividend': .5})
        self.assertEqual(raw['Values']['EPS'], 8)

    def test_unverified_share_basis_never_exposes_raw_per_share_figures(self):
        result = adjust_statement(statement({'SharesOut': 100, 'EPS': 8, 'Dividend': 2}), None, None, None)
        self.assertTrue(all(value is None for value in result['Values'].values()))

    def test_ratios_millions_cash_flow_and_book_value(self):
        row = statement_record(statement({'Sales': 100e6, 'PTP': 20e6, 'NetIncome': 10e6, 'IncomeTax': 4e6, 'OperatingCashFlow': 15e6, 'CapitalExpenditures': 5e6, 'SharesOut': 2e6, 'EndShares': 1e6, 'CommonStockEquity': 30e6, 'CommonStockEquityBegin': 20e6, 'LtDebt': 10e6, 'CurrentDebt': 2e6, 'ShortTermDebt': 3e6}), [], 'USD', 'USD')
        self.assertEqual(row['Sales'], 100)
        self.assertEqual(row['TotalDebt'], 15)
        self.assertEqual(row['FreeCashFlow'], 10)
        self.assertEqual(row['CashFlow'], 5)
        self.assertEqual(row['BookValue'], 30)
        self.assertAlmostEqual(row['ROE'], .4)
        self.assertEqual(row['TaxRate'], .2)
        self.assertEqual(row['DTC'], .25)

    def test_missing_debt_components_are_not_assumed_zero(self):
        row = statement_record(statement({'LtDebt': 5e6}), [], 'USD', 'USD')
        self.assertIsNone(row['TotalDebt'])
        self.assertEqual(row['LtDebt'], 5)

    def test_price_ranges_require_intraday_high_low_and_matching_currency(self):
        raw = statement({'EPS': 2}, {'Sales': {'Start': '2023-01-01'}})
        history = [{'date': '2023-01-03', 'close': 10, 'high': 12, 'low': 9}, {'date': '2023-12-29', 'close': 20, 'high': 25, 'low': 18}]
        row = statement_record(raw, history, 'USD', 'USD')
        self.assertEqual((row['HighPrice'], row['LowPrice'], row['HighPE']), (25, 9, 12.5))
        self.assertIsNone(statement_record(raw, history, 'CAD', 'USD')['HighPrice'])
        self.assertIsNone(statement_record(raw, history[1:], 'USD', 'USD')['HighPrice'])

    def test_analyst_years_counts_and_million_units(self):
        eps = pd.DataFrame({'avg': [5, 6], 'growth': [.1, .2], 'numberOfAnalysts': [8, 7]}, index=['0y', '+1y'])
        sales = pd.DataFrame({'avg': [100e6, 120e6], 'growth': [.1, .2], 'numberOfAnalysts': [9, 8]}, index=['0y', '+1y'])
        rows, company = estimates({'nextFiscalYearEnd': 1798675200}, eps, sales, date(2026, 10, 23))
        self.assertEqual([row['FiscalYear'] for row in rows], [2026, 2027])
        self.assertEqual(rows[0]['SalesEst'], 100)
        self.assertEqual(rows[0]['NumOfEpsEst'], 8)
        self.assertEqual(company['AnalystEPSEstGrowthRate'], .2)
        self.assertEqual(estimates({}, eps, sales)[0], [])

    def test_optional_market_failures_are_reported(self):
        stock = Mock(ticker='TEST')
        stock.get_info.side_effect = RuntimeError('provider offline')
        stock.get_earnings_estimate.side_effect = RuntimeError('provider offline')
        result = fetch_market(stock)
        self.assertEqual(result['profile'], {})
        self.assertEqual(result['analystEstimates'], [])
        self.assertTrue(result['warnings'])

    def test_peer_averages_exclude_cross_currency_values_and_preserve_missing(self):
        def member(currency, sales):
            return {'Metadata': {'FinancialCurrency': currency}, 'AnnualData': [{'FiscalYear': 2023, 'Sales': sales}]}
        rows, rates = peer_averages([member('USD', 100), member('USD', 200), member('EUR', 900)], 'USD')
        self.assertEqual(rows[0]['Sales'], 150)
        self.assertEqual(rows[0]['ObservationCounts']['Sales'], 2)
        self.assertIsNone(rows[0]['EPS'])


class ExpandedIntegrationTests(unittest.TestCase):
    def test_dataframe_numeric_scalars_become_json_safe_builtin_numbers(self):
        self.assertEqual(finite(np.int64(12)), 12)
        self.assertEqual(finite(np.float32(1.5)), 1.5)
        self.assertIsNone(finite(np.float64('nan')))
        self.assertIsNone(finite(True))

    def test_yahoo_capex_outflow_sign_and_statement_units(self):
        stock = Mock()
        end = pd.Timestamp('2025-12-31')
        stock.get_balance_sheet.return_value = pd.DataFrame({end: {'TotalDebt': 12e6}})
        stock.get_income_stmt.return_value = pd.DataFrame({end: {'InterestExpense': 1e6, 'TotalRevenue': 100e6, 'PretaxIncome': 20e6}})
        stock.get_cash_flow.return_value = pd.DataFrame({end: {'OperatingCashFlow': 30e6, 'CapitalExpenditure': -8e6}})
        rows, errors = statement_fallbacks(stock, {'financialCurrency': 'USD'})
        self.assertEqual(errors, [])
        values = rows['annual']['2025-12-31']['Values']
        self.assertEqual(values['CapitalExpenditures'], 8e6)
        row = statement_record(statement(values, rows['annual']['2025-12-31']['Sources']), [], 'USD', 'USD')
        self.assertEqual(row['FreeCashFlow'], 22)
        self.assertEqual(row['TotalDebt'], 12)
        self.assertEqual(row['InterestCoverage'], 21)

    def test_yahoo_monetary_fallback_never_invents_eps(self):
        market = {'profile': {'financialCurrency': 'USD'}, 'statementFallbacks': {
            'annual': {'2025-12-31': {'Values': {'Sales': 100e6, 'PTP': 20e6}, 'Sources': {key: {'Field': key, 'Unit': 'USD'} for key in ('Sales', 'PTP')}}},
            'quarterly': {'2026-03-31': {'Values': {'Sales': 30e6, 'PTP': 5e6}, 'Sources': {}}},
        }}
        financial = fallback_financials(market)
        self.assertEqual(financial['annual'][0]['sales'], 100e6)
        self.assertIsNone(financial['annual'][0]['eps'])
        self.assertEqual(financial['statements']['quarterly'][0]['QuarterNo'], 1)

    def test_enrichment_keeps_core_eps_and_updates_latest_company_debt(self):
        raw = {'id': 'test', 'company': {'ticker': 'TEST', 'cik': 1}, 'annual': [{'periodEnd': '2025-12-31', 'sales': 100e6, 'pretaxProfit': 20e6, 'eps': 2, 'epsSplitFactor': 1}],
               'financialCurrency': 'USD', 'priceCurrency': 'USD', 'warnings': [], 'epsAdjustment': {'status': 'normalized'},
               'statements': {'annual': {'2025-12-31': statement({'Sales': 999e6, 'EPS': 999, 'PTP': 999e6, 'TotalDebt': 10e6})},
                              'quarterly': [{**statement({'TotalDebt': 12e6, 'Sales': 30e6, 'PTP': 5e6}), 'FiscalYear': 2026, 'QuarterNo': 1, 'AsOfDataDate': '2026-03-31'}]}}
        result = normalize_study(raw)
        self.assertEqual(result['AnnualData'][0]['EPS'], 2)
        self.assertEqual(result['AnnualData'][0]['Sales'], 100)
        self.assertEqual(result['Company']['TotalDebt'], 12)
        self.assertEqual(result['Company']['TotalDebtQuarterLast'], 12)
        self.assertEqual(result['Metadata']['Units']['OwnershipPercentages'], 'percentage-points')

    def test_header_statistics_use_millions_and_preserve_unavailable_values(self):
        raw = {'id': 'test', 'company': {}, 'annual': [], 'warnings': [],
               'market': {'profile': {'marketCap': 7.9e9, 'enterpriseValue': 8.4e9,
                                      'sharesOutstanding': 84.2e6, 'averageVolume': 1.1e6}}}
        company = normalize_study(raw)['Company']
        self.assertEqual(company['MarketCap'], 7900)
        self.assertEqual(company['EnterpriseValue'], 8400)
        self.assertEqual(company['SharesOutstanding'], 84.2)
        self.assertEqual(company['AverageVolume'], 1.1)
        raw['market']['profile'] = {'marketCap': float('nan')}
        company = normalize_study(raw)['Company']
        for field in ('MarketCap', 'EnterpriseValue', 'SharesOutstanding', 'AverageVolume'):
            self.assertIsNone(company[field])

    def test_cross_currency_statement_fallbacks_and_analysts_are_omitted(self):
        raw = {'id': 'test', 'company': {'ticker': 'TEST', 'cik': 1}, 'annual': [{'periodEnd': '2023-12-31', 'sales': 100e6}],
               'financialCurrency': 'USD', 'priceCurrency': 'USD', 'warnings': [],
               'statements': {'annual': {'2023-12-31': statement({})}},
               'market': {'profile': {'financialCurrency': 'EUR'}, 'analystEstimates': [{'FiscalYear': 2026, 'EpsEst': 2}],
                          'statementFallbacks': {'annual': {'2023-12-31': {'Values': {'TotalDebt': 99e6}, 'Sources': {'TotalDebt': {'Provider': 'Yahoo Finance'}}}}}}}
        result = normalize_study(raw)
        self.assertIsNone(result['AnnualData'][0]['TotalDebt'])
        self.assertEqual(result['AnalystEstimates'], [])
        self.assertTrue(any('currency' in warning for warning in result['Metadata']['Warnings']))

    def test_new_datasets_survive_canonical_storage_without_recomputation(self):
        raw = {'id': 'test', 'company': {}, 'annual': [], 'warnings': [], 'financialCurrency': 'USD',
               'statements': {'quarterly': [{**statement({'Sales': 1e6}), 'QuarterNo': 4}]}}
        result = normalize_study(raw)
        self.assertEqual(result['QuarterlyData'][0]['Sales'], 1)
        self.assertEqual(normalize_study(result), result)

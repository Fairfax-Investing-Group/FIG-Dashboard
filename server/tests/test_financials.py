from datetime import date
import unittest

from server.financials import normalize_financials


def fact(start='2023-01-01', end='2023-12-31', value=100, filed='2024-02-01', **extra):
    return {'start': start, 'end': end, 'val': value, 'filed': filed, 'form': '10-K', 'fy': 2023, 'accn': '0000000001-24-000001', **extra}


def payload(revenue=None, eps=None, pretax=None):
    return {'facts': {'us-gaap': {
        'RevenueFromContractWithCustomerExcludingAssessedTax': {'units': {'USD': revenue or []}},
        'EarningsPerShareDiluted': {'units': {'USD/shares': eps or []}},
        'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest': {'units': {'USD': pretax or []}},
    }}}


class FinancialsTests(unittest.TestCase):
    def test_quarters_ytd_future_and_nonfinite_are_not_full_years(self):
        data = payload(revenue=[
            fact(), fact(end='2023-03-31', value=25), fact(end='2023-09-30', value=75),
            fact(value=500, form='10-Q'), fact(value=float('nan')),
            fact(value=999, filed='2028-02-01'),
        ])
        rows = normalize_financials(data, date(2026, 10, 23))['annual']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['sales'], 100)

    def test_comparative_fy_is_not_used_as_period_year_and_latest_restatement_wins(self):
        data = payload(revenue=[fact(), fact(value=110, filed='2025-02-01', fy=2024)])
        rows = normalize_financials(data)['annual']
        self.assertEqual(rows[0]['periodEnd'], '2023-12-31')
        self.assertEqual(rows[0]['sales'], 110)
        self.assertEqual(rows[0]['salesSource']['filed'], '2025-02-01')

    def test_ten_periods_not_ten_filing_year_labels(self):
        data = payload(revenue=[fact(start=f'{year}-01-01', end=f'{year}-12-31', filed=f'{year+1}-02-01', fy=2025, value=year) for year in range(2010, 2026)])
        rows = normalize_financials(data, date(2026, 10, 23))['annual']
        self.assertEqual(len(rows), 10)
        self.assertEqual(rows[0]['periodEnd'], '2016-12-31')
        self.assertEqual(rows[-1]['periodEnd'], '2025-12-31')

    def test_missing_is_null_and_losses_and_zero_are_preserved(self):
        result = normalize_financials(payload(revenue=[fact(value=0)], pretax=[fact(value=-50)]))
        row = result['annual'][0]
        self.assertEqual(row['sales'], 0)
        self.assertEqual(row['pretaxProfit'], -50)
        self.assertIsNone(row['eps'])
        self.assertTrue(any('Diluted EPS' in warning for warning in result['warnings']))

    def test_standard_concepts_preferred_and_currency_not_mixed(self):
        data = payload(revenue=[fact(value=100)], eps=[fact(value=2)])
        gaap = data['facts']['us-gaap']
        gaap['Revenues'] = {'units': {'USD': [fact(value=999, filed='2025-02-01')]}}
        gaap['EarningsPerShareDiluted']['units']['EUR/shares'] = [fact(value=10)]
        row = normalize_financials(data)['annual'][0]
        self.assertEqual(row['sales'], 100)
        self.assertEqual(row['eps'], 2)

    def test_ifrs_and_non_usd_supported(self):
        data = {'facts': {'ifrs-full': {
            'Revenue': {'units': {'EUR': [fact(value=300, form='20-F')]}},
            'ProfitLossBeforeTax': {'units': {'EUR': [fact(value=50, form='20-F')]}},
            'DilutedEarningsLossPerShare': {'units': {'EUR/shares': [fact(value=1.5, form='20-F')]}},
        }}}
        result = normalize_financials(data)
        self.assertEqual(result['currency'], 'EUR')
        self.assertEqual(result['annual'][0]['pretaxProfit'], 50)
        self.assertEqual(result['annual'][0]['eps'], 1.5)

    def test_date_shifts_do_not_duplicate_periods(self):
        data = payload(revenue=[fact(), fact(end='2023-12-30', value=95)])
        self.assertEqual(len(normalize_financials(data)['annual']), 1)

    def test_newer_eps_is_not_lost_when_revenue_concept_is_missing(self):
        data = payload(revenue=[fact()], eps=[fact(start='2025-01-01', end='2025-12-31', filed='2026-02-01', value=3.5)])
        rows = normalize_financials(data, date(2026, 10, 23))['annual']
        self.assertEqual(rows[-1]['periodEnd'], '2025-12-31')
        self.assertEqual(rows[-1]['eps'], 3.5)
        self.assertIsNone(rows[-1]['sales'])

    def test_stale_filings_do_not_extend_financials_outside_the_last_decade(self):
        data = payload(revenue=[fact(start='2008-01-01', end='2008-12-31', filed='2009-02-01')])
        self.assertEqual(normalize_financials(data, date(2026, 10, 23))['annual'], [])

    def test_no_supported_facts_returns_empty_not_fake_data(self):
        result = normalize_financials({'facts': {}})
        self.assertEqual(result['annual'], [])
        self.assertIsNone(result['currency'])
        self.assertTrue(result['warnings'])


if __name__ == '__main__':
    unittest.main()

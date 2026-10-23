from copy import deepcopy
import json
import unittest

from server.schema_fields import ANNUAL_FIELDS, COMPANY_FIELDS
from server.study_schema import normalize_study
from server.studies import normalized_only


def snapshot():
    return {
        'id': 'test-study', 'createdAt': '2026-10-23T12:00:00Z',
        'company': {'ticker': 'TEST', 'name': 'Test Company', 'cik': 123, 'exchange': 'Nasdaq'},
        'financialCurrency': 'USD', 'priceCurrency': 'CAD', 'warnings': [],
        'annual': [{
            'periodEnd': '2025-06-30', 'sales': 100_000_000, 'eps': 2, 'pretaxProfit': -5_000_000,
            'epsReported': 8, 'epsSplitFactor': 4,
            'epsSource': {'concept': 'us-gaap:EarningsPerShareDiluted', 'filed': '2025-08-01', 'accession': 'abc', 'unit': 'USD/shares', 'start': '2024-07-01', 'end': '2025-06-30'},
        }],
        'prices': [{'date': '2026-10-02', 'close': 52}, {'date': '2026-09-30', 'close': 50}, {'date': '2026-10-01', 'close': 51}],
        'sources': {'sec': {'status': 'ok', 'url': 'https://example.com/facts', 'retrievedAt': '2026-10-23T12:00:00Z', 'error': None}},
        'epsAdjustment': {'status': 'normalized', 'asOf': '2026-10-23', 'events': [{'date': '2025-09-01', 'ratio': 4}]},
    }


class StudySchemaTests(unittest.TestCase):
    def test_units_aliases_ratios_dates_and_provenance(self):
        document = normalize_study(snapshot())
        row = document['AnnualData'][0]
        self.assertEqual(row['Sales'], 100)
        self.assertEqual(row['PTP'], -5)
        self.assertEqual(row['EPS'], 2)
        self.assertEqual(row['EPSSplitFactor'], 4)
        self.assertEqual(row['PtpOnSales'], -0.05)
        self.assertEqual(row['TotalRevenue'], row['Sales'])
        self.assertEqual(row['PretaxIncome'], row['PTP'])
        self.assertEqual(row['AsOfDataDate'], '2025-06-30')
        self.assertEqual(row['Sources']['EPS']['Filed'], '2025-08-01')
        self.assertEqual(document['Company']['CentralIndexKey'], '0000000123')
        self.assertEqual(document['Company']['FYMonth'], 6)
        self.assertEqual(document['Metadata']['PriceCurrency'], 'CAD')

    def test_unsupported_values_are_null_not_zero_or_sample_values(self):
        document = normalize_study(snapshot())
        row = document['AnnualData'][0]
        self.assertTrue(set(ANNUAL_FIELDS).issubset(row))
        self.assertEqual(set(COMPANY_FIELDS), set(document['Company']))
        for field in ('ROE', 'SharesOut', 'NetIncome', 'HighPrice', 'SalesOutlier', 'DataStatus'):
            self.assertIsNone(row[field])
        self.assertEqual(document['QuarterlyData'], [])
        self.assertEqual(document['AnalystEstimates'], [])
        self.assertIsNone(document['Study']['ProjSalesGrowthRate'])
        self.assertEqual(document['ScaleFactors']['EPS'], 0)
        self.assertIn('not vendor', document['Metadata']['ScaleFactorsMethod'])

    def test_monthly_prices_are_last_observed_closes_not_ohlc(self):
        document = normalize_study(snapshot())
        self.assertEqual(document['DailyPrices'][0]['Date'], '2026-09-30')
        self.assertEqual(document['MonthlyPrices'], [
            {'Month': '2026-09', 'Date': '2026-09-30', 'Close': 50},
            {'Month': '2026-10', 'Date': '2026-10-02', 'Close': 52},
        ])
        self.assertEqual(document['Company']['ClosingPrice'], 52)
        self.assertEqual(document['Company']['DateOfClosingPrice'], '2026-10-02')

    def test_conversion_is_idempotent_and_does_not_modify_input(self):
        original = snapshot()
        before = deepcopy(original)
        document = normalize_study(original)
        self.assertEqual(normalize_study(document), document)
        self.assertEqual(original, before)
        self.assertNotIn('epsReported', json.dumps(document))
        json.dumps(document, allow_nan=False)

    def test_growth_matches_reference_as_decimal_rates(self):
        study = snapshot()
        sales = [90272, 110855, 136819, 161857, 182527, 257637, 282836, 307394, 350018, 402836]
        eps = [1.39, .90, 2.19, 2.46, 2.93, 5.61, 4.56, 5.80, 8.04, 10.81]
        ptp = [24150, 27193, 34913, 39625, 48082, 90734, 71328, 85717, 119815, 158826]
        study['annual'] = [{'periodEnd': f'{2016+i}-12-31', 'sales': sales[i] * 1e6, 'eps': eps[i], 'epsSplitFactor': 1, 'pretaxProfit': ptp[i] * 1e6} for i in range(10)]
        computed = normalize_study(study)['ComputedValues']
        for field, expected in [('SalesGrowthRate', '18.2'), ('EPSGrowthRate', '28.3'), ('PTPGrowthRate', '23.0')]:
            self.assertEqual(f"{computed[field] * 100:.1f}", expected)

    def test_unverified_eps_and_nonfinite_numbers_are_not_exposed(self):
        study = snapshot()
        study.pop('epsAdjustment')
        study['annual'][0]['sales'] = float('nan')
        document = normalize_study(study)
        self.assertIsNone(document['AnnualData'][0]['EPS'])
        self.assertIsNone(document['AnnualData'][0]['Sales'])
        json.dumps(document, allow_nan=False)

    def test_legacy_eps_is_still_verified_and_missing_periods_are_safe(self):
        study = snapshot()
        study['annual'].append({'eps': 3})
        document = normalize_study(normalized_only(study))
        self.assertEqual(len(document['AnnualData']), 1)

    def test_growth_retains_missing_year_gaps_and_rejects_losses(self):
        study = snapshot()
        study['annual'] = [
            {'periodEnd': '2020-12-31', 'sales': 100, 'pretaxProfit': 5},
            {'periodEnd': '2021-12-31', 'sales': None, 'pretaxProfit': -1},
            {'periodEnd': '2022-12-31', 'sales': 121, 'pretaxProfit': 8},
        ]
        rates = normalize_study(study)['ComputedValues']
        self.assertAlmostEqual(rates['SalesGrowthRate'], 0.1)
        self.assertIsNone(rates['PTPGrowthRate'])

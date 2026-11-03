from copy import deepcopy
import unittest

from server.fundamentals import adjust_statement
from server.share_counts import normalize_share_counts
from server.enrichment import statement_record
from server.study_schema import normalize_study


def period(shares=29376, end_shares=29.3e6, end='2022-12-31', income=66.496e6, eps=2.26):
    values = {'SharesOut': shares, 'BasicShares': shares * .995, 'EPS': eps, 'NetIncome': income,
              'OperatingCashFlow': 80e6, 'CapitalExpenditures': 4e6}
    if end_shares is not None:
        values['EndShares'] = end_shares
    sources = {key: {'Start': end[:4] + '-01-01', 'End': end, 'Filed': '2024-02-01',
                     'Concept': 'us-gaap:' + key, 'SplitFactor': 1}
               for key in values}
    sources['NetIncome']['Concept'] = 'us-gaap:NetIncomeLoss'
    return {'AsOfDataDate': end, 'FiscalYear': int(end[:4]), 'Values': values, 'Sources': sources}


def check(*rows):
    return normalize_share_counts({'annual': {row['AsOfDataDate']: row for row in rows}, 'quarterly': []})


class ShareCountTests(unittest.TestCase):
    def test_study_enrichment_checks_annual_and_quarterly_counts(self):
        annual = period()
        quarter = period(end='2023-03-31')
        quarter['QuarterNo'] = 1
        raw = {'id': 'test', 'company': {}, 'annual': [
            {'periodEnd': '2022-12-31', 'eps': 2.26, 'epsSplitFactor': 1}],
            'warnings': [], 'financialCurrency': 'USD', 'priceCurrency': 'USD',
            'epsAdjustment': {'status': 'normalized'},
            'statements': {'annual': {'2022-12-31': annual}, 'quarterly': [quarter]}}
        result = normalize_study(raw)
        for row in (result['AnnualData'][0], result['QuarterlyData'][0]):
            self.assertEqual(row['SharesOut'], 29.376)
            self.assertAlmostEqual(row['CashFlow'], 76e6 / 29376000)
            self.assertEqual(row['Sources']['SharesOut']['ShareCountCheck']['Status'], 'corrected')
        self.assertEqual(len(result['Metadata']['Warnings']), 2)

    def test_bmi_scaling_and_derived_fcf_preserve_original_and_provenance(self):
        raw = period()
        before = deepcopy(raw)
        result, notices = check(raw)
        row = result['annual']['2022-12-31']
        self.assertEqual(row['Values']['SharesOut'], 29376000)
        self.assertEqual(row['Values']['BasicShares'], 29376000 * .995)
        self.assertAlmostEqual(statement_record(row, [], 'USD', 'USD')['CashFlow'], 76e6 / 29376000)
        self.assertEqual(raw, before)
        self.assertEqual(row['Sources']['SharesOut']['ShareCountCheck']['OriginalValue'], 29376)
        self.assertTrue(notices)
        self.assertEqual(normalize_share_counts(result)[0], result)

    def test_correct_counts_and_real_issuance_are_unchanged(self):
        for row in (period(shares=29376000), period(shares=60e6, income=120e6, eps=2, end_shares=61e6)):
            result, notices = check(row)
            self.assertEqual(result['annual'][row['AsOfDataDate']], row)
            self.assertEqual(notices, [])

    def test_inverse_scaling_and_loss_period(self):
        result, _ = check(period(shares=29376000000, income=-66.496e6, eps=-2.26))
        self.assertEqual(result['annual']['2022-12-31']['Values']['SharesOut'], 29376000)

    def test_independently_validated_neighbor_corroborates_missing_end_shares(self):
        result, _ = check(period(end_shares=None), period(shares=29376000, end='2023-12-31'))
        self.assertEqual(result['annual']['2022-12-31']['Values']['SharesOut'], 29376000)

    def test_end_share_validated_neighbor_corroborates_without_chaining(self):
        result, _ = check(period(end='2019-12-31', end_shares=None),
                          period(end='2020-12-31', end_shares=None), period())
        self.assertIsNone(result['annual']['2019-12-31']['Values']['SharesOut'])
        self.assertEqual(result['annual']['2020-12-31']['Values']['SharesOut'], 29376000)

    def test_unsupported_suspect_is_withheld(self):
        result, _ = check(period(end_shares=None))
        row = result['annual']['2022-12-31']
        self.assertIsNone(row['Values']['SharesOut'])
        self.assertIsNone(statement_record(row, [], 'USD', 'USD')['CashFlow'])
        self.assertEqual(row['Sources']['SharesOut']['ShareCountCheck']['Status'], 'unverified')

    def test_misaligned_periods_near_zero_eps_and_unverified_basis_do_not_correct(self):
        for kind in ('period', 'eps', 'basis'):
            row = period()
            if kind == 'period':
                row['Sources']['NetIncome']['Start'] = '2022-10-01'
            elif kind == 'eps':
                row['Values']['EPS'] = .001
            else:
                del row['Sources']['EPS']['SplitFactor']
            result, notices = check(row)
            self.assertEqual(result['annual']['2022-12-31'], row)
            self.assertFalse(notices)

    def test_split_normalized_counts_do_not_trigger_scaling(self):
        raw = period(shares=29376000)
        for ratio in (2, .1, 1000):
            row = adjust_statement(raw, [{'date': '2025-01-01', 'ratio': ratio}], '2026-11-02', '2016-01-01')
            result, notices = check(row)
            self.assertEqual(result['annual']['2022-12-31'], row)
            self.assertFalse(notices)

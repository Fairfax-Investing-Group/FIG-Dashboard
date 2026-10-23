import unittest

from server.eps import normalize_eps


def row(value, filed):
    return {'periodEnd': '2016-09-24', 'eps': value, 'epsSource': {'filed': filed}, 'sales': 100, 'pretaxProfit': 20}


class EpsTests(unittest.TestCase):
    def test_forward_split_rebases_old_eps(self):
        result = normalize_eps([row(8.31, '2018-11-05')], [{'date': '2020-08-31', 'ratio': 4}], '2026-10-23')[0]
        self.assertAlmostEqual(result['eps'], 2.0775)
        self.assertEqual(result['epsReported'], 8.31)
        self.assertEqual(result['epsSplitFactor'], 4)
        self.assertEqual(result['sales'], 100)
        self.assertEqual(result['pretaxProfit'], 20)

    def test_already_restated_comparative_is_not_adjusted_again(self):
        result = normalize_eps([row(2.98, '2020-10-30')], [{'date': '2020-08-31', 'ratio': 4}], '2026-10-23')[0]
        self.assertEqual(result['eps'], 2.98)
        self.assertEqual(result['epsSplitFactor'], 1)

    def test_multiple_splits_and_reverse_splits(self):
        splits = [{'date': '2021-01-01', 'ratio': 4}, {'date': '2022-01-01', 'ratio': 0.1}]
        result = normalize_eps([row(-8, '2020-01-01')], splits, '2026-10-23')[0]
        self.assertAlmostEqual(result['eps'], -20)
        self.assertAlmostEqual(result['epsSplitFactor'], 0.4)

    def test_zero_null_and_no_splits(self):
        result = normalize_eps([row(0, '2020-01-01'), row(None, '2020-01-01'), row(2, '2020-01-01')], [], '2026-10-23')
        self.assertEqual(result[0]['eps'], 0)
        self.assertIsNone(result[1]['eps'])
        self.assertEqual(result[2]['eps'], 2)

    def test_splits_on_or_before_filing_and_future_splits_are_not_applied(self):
        events = [{'date': '2020-01-01', 'ratio': 4}, {'date': '2027-01-01', 'ratio': 10}]
        self.assertEqual(normalize_eps([row(5, '2020-01-01')], events, '2026-10-23')[0]['eps'], 5)

    def test_normalization_is_idempotent_and_does_not_mutate_source(self):
        source = row(8, '2020-01-01')
        splits = [{'date': '2021-01-01', 'ratio': 4}]
        first = normalize_eps([source], splits, '2026-10-23')
        self.assertEqual(normalize_eps(first, splits, '2026-10-23'), first)
        self.assertEqual(source['eps'], 8)
        self.assertNotIn('epsReported', source)

    def test_invalid_ratios_are_rejected(self):
        for ratio in [0, -1, float('nan'), float('inf')]:
            with self.assertRaises(ValueError):
                normalize_eps([row(2, '2020-01-01')], [{'date': '2021-01-01', 'ratio': ratio}], '2026-10-23')

    def test_missing_or_invalid_filing_basis_never_returns_reported_eps(self):
        for source in [None, {}, {'filed': 'invalid'}, {'filed': '2027-01-01'}]:
            with self.subTest(source=source):
                result = normalize_eps([{**row(8, '2020-01-01'), 'epsSource': source}], [], '2026-10-23')[0]
                self.assertIsNone(result['eps'])
                self.assertIsNone(result['epsSplitFactor'])
                self.assertEqual(result['epsReported'], 8)

    def test_split_history_must_cover_filing_basis(self):
        result = normalize_eps([row(8, '2015-01-01'), row(4, '2016-01-01')], [], '2026-10-23', '2016-01-01')
        self.assertIsNone(result[0]['eps'])
        self.assertEqual(result[1]['eps'], 4)

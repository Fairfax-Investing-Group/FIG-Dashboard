from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server.studies import company_for, connection, create_study, get_study, save_study
import json


class StudiesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'STUDY_DB': str(Path(self.directory.name) / 'studies.sqlite3')})
        self.env.start()
        self.company = company_for('AAPL', 320193)

    def tearDown(self):
        self.env.stop()
        self.directory.cleanup()

    def test_invalid_ticker_cik_combination_rejected(self):
        with self.assertRaises(ValueError):
            company_for('MSFT', 320193)

    @patch('server.studies.fetch_prices', side_effect=ValueError('No prices available'))
    @patch('server.studies.fetch_financials')
    def test_partial_failure_keeps_financials_and_persists_snapshot(self, financials, prices):
        financials.return_value = {'currency': 'USD', 'annual': [{'periodEnd': '2025-12-31', 'sales': 100}], 'warnings': [], 'retrievedAt': datetime.now(timezone.utc).isoformat()}
        study = create_study(self.company)
        self.assertEqual(study['Metadata']['Sources']['SEC']['Status'], 'ok')
        self.assertEqual(study['Metadata']['Sources']['YahooFinance']['Status'], 'error')
        self.assertEqual(study['AnnualData'][0]['Sales'], 0.0001)
        self.assertEqual(study['DailyPrices'], [])
        self.assertEqual(get_study(study['Study']['StudyID']), study)

    @patch('server.studies.fetch_prices', side_effect=ValueError('No prices'))
    @patch('server.studies.fetch_financials', side_effect=ValueError('No facts'))
    def test_every_creation_fetches_both_sources_and_get_does_not(self, financials, prices):
        first = create_study(self.company)
        second = create_study(self.company)
        self.assertNotEqual(first['Study']['StudyID'], second['Study']['StudyID'])
        self.assertEqual(financials.call_count, 2)
        self.assertEqual(prices.call_count, 2)
        get_study(first['Study']['StudyID'])
        self.assertEqual(financials.call_count, 2)
        self.assertEqual(prices.call_count, 2)

    @patch('server.studies.fetch_prices')
    @patch('server.studies.fetch_financials')
    def test_creation_saves_split_normalized_eps_and_factor(self, financials, prices):
        financials.return_value = {'currency': 'USD', 'annual': [{'periodEnd': '2016-09-24', 'eps': 8.31, 'epsSource': {'filed': '2018-11-05'}}], 'warnings': [], 'retrievedAt': '2026-10-23T00:00:00Z'}
        prices.return_value = {'prices': [{'date': '2016-10-24', 'close': 20}], 'currency': 'USD', 'start': '2016-10-23', 'end': '2026-10-23', 'retrievedAt': '2026-10-23T00:00:00Z', 'splitHistoryAvailable': True, 'splitHistoryStart': '2016-01-01', 'splits': [{'date': '2020-08-31', 'ratio': 4}]}
        study = create_study(self.company)
        self.assertAlmostEqual(study['AnnualData'][0]['EPS'], 2.0775)
        self.assertEqual(study['AnnualData'][0]['EPSSplitFactor'], 4)
        self.assertEqual(study['Metadata']['EPSAdjustment']['Status'], 'normalized')
        self.assertEqual(get_study(study['Study']['StudyID']), study)

    @patch('server.studies.fetch_prices', side_effect=ValueError('No prices'))
    @patch('server.studies.fetch_financials', side_effect=ValueError('No facts'))
    def test_new_snapshots_store_the_canonical_document(self, financials, prices):
        study = create_study(self.company)
        with connection() as db:
            payload = db.execute('SELECT payload FROM studies WHERE id = ?', (study['Study']['StudyID'],)).fetchone()[0]
        saved = json.loads(payload)
        self.assertEqual(saved['SchemaVersion'], 1)
        self.assertEqual(saved, study)
        self.assertNotIn('annual', saved)

    def test_unknown_saved_study(self):
        self.assertIsNone(get_study('missing'))

    @patch('server.studies.fetch_prices')
    @patch('server.studies.fetch_financials')
    def test_unavailable_or_invalid_splits_never_expose_reported_eps(self, financials, prices):
        for split_data in [None, {'splitHistoryAvailable': False}, {'splitHistoryAvailable': True, 'splits': [{'date': '2020-08-31', 'ratio': -4}]}]:
            with self.subTest(split_data=split_data):
                financials.return_value = {'currency': 'USD', 'annual': [{'periodEnd': '2016-09-24', 'eps': 8.31, 'sales': 100, 'pretaxProfit': 20, 'epsSource': {'filed': '2018-11-05'}}], 'warnings': [], 'retrievedAt': '2026-10-23T00:00:00Z'}
                prices.side_effect = ValueError('No prices') if split_data is None else None
                prices.return_value = {'prices': [{'date': '2016-10-24', 'close': 20}], 'currency': 'USD', 'start': '2016-10-23', 'end': '2026-10-23', 'retrievedAt': '2026-10-23T00:00:00Z', 'splitHistoryStart': '2016-01-01', **(split_data or {})}
                study = create_study(self.company)
                self.assertIsNone(study['AnnualData'][0]['EPS'])
                self.assertEqual(study['AnnualData'][0]['Sales'], 0.0001)
                self.assertEqual(study['AnnualData'][0]['PTP'], 0.00002)
                self.assertEqual(study['Metadata']['EPSAdjustment']['Status'], 'unavailable')
                self.assertEqual(get_study(study['Study']['StudyID']), study)

    def test_legacy_snapshot_hides_unverified_eps_without_fetching(self):
        for adjustment in [{}, {'epsAdjustment': {'status': 'unavailable'}}, {'epsAdjustment': {'status': 'normalized'}}]:
            with self.subTest(adjustment=adjustment):
                snapshot = {'id': str(adjustment), 'annual': [{'periodEnd': '2025-12-31', 'eps': 8, 'sales': 100}], 'warnings': [], **adjustment}
                with connection() as db:
                    db.execute('INSERT INTO studies (id, payload) VALUES (?, ?)', (snapshot['id'], json.dumps(snapshot)))
                with patch('server.studies.fetch_financials') as financials, patch('server.studies.fetch_prices') as prices:
                    loaded = get_study(snapshot['id'])
                self.assertIsNone(loaded['AnnualData'][0]['EPS'])
                self.assertEqual(loaded['AnnualData'][0]['Sales'], 0.0001)
                self.assertTrue(loaded['Metadata']['Warnings'])
                financials.assert_not_called()
                prices.assert_not_called()


if __name__ == '__main__':
    unittest.main()

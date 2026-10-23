from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server.studies import company_for, create_study, get_study, save_study


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
        self.assertEqual(study['sources']['sec']['status'], 'ok')
        self.assertEqual(study['sources']['yfinance']['status'], 'error')
        self.assertEqual(study['annual'][0]['sales'], 100)
        self.assertEqual(study['prices'], [])
        self.assertEqual(get_study(study['id']), study)

    @patch('server.studies.fetch_prices', side_effect=ValueError('No prices'))
    @patch('server.studies.fetch_financials', side_effect=ValueError('No facts'))
    def test_every_creation_fetches_both_sources_and_get_does_not(self, financials, prices):
        first = create_study(self.company)
        second = create_study(self.company)
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(financials.call_count, 2)
        self.assertEqual(prices.call_count, 2)
        get_study(first['id'])
        self.assertEqual(financials.call_count, 2)
        self.assertEqual(prices.call_count, 2)

    def test_unknown_saved_study(self):
        self.assertIsNone(get_study('missing'))


if __name__ == '__main__':
    unittest.main()

from datetime import date
import threading
import unittest
from unittest.mock import MagicMock, patch

import pandas as pd

from server.app import accepts_gzip
from server.studies import fetch_financials, fetch_prices, price_observations


class NewStudySpeedTests(unittest.TestCase):
    def test_sec_documents_are_requested_concurrently(self):
        facts_started, submissions_started = threading.Event(), threading.Event()
        def sec(url):
            if '/companyfacts/' in url:
                facts_started.set()
                self.assertTrue(submissions_started.wait(2), 'Submissions should start before facts finish')
                return {'facts': {}}
            submissions_started.set()
            self.assertTrue(facts_started.wait(2))
            return {'filings': {'recent': {}}}
        with patch('server.studies.sec_json', side_effect=sec) as fetch, patch('server.studies.normalize_financials', return_value={'currency': 'USD', 'annual': [], 'warnings': []}), patch('server.studies.extract_statements', return_value={'annual': {}, 'quarterly': []}):
            result = fetch_financials(123)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(result['submissions'], {'filings': {'recent': {}}})

    def test_optional_sec_metadata_failure_preserves_financials(self):
        def sec(url):
            if '/submissions/' in url:
                raise RuntimeError('Metadata unavailable')
            return {'facts': {}}
        with patch('server.studies.sec_json', side_effect=sec), patch('server.studies.normalize_financials', return_value={'currency': 'USD', 'annual': [{'periodEnd': '2025-12-31'}], 'warnings': []}), patch('server.studies.extract_statements', return_value={}):
            result = fetch_financials(123)
        self.assertEqual(len(result['annual']), 1)
        self.assertEqual(result['submissions'], {})
        self.assertTrue(result['warnings'])

    def test_yahoo_history_and_profile_requests_overlap_on_separate_instances(self):
        history_started, market_started = threading.Event(), threading.Event()
        stock, profile_stock = MagicMock(), MagicMock()
        stock.history_metadata = {'currency': 'USD'}
        frame = pd.DataFrame({'Close': [40.0], 'Stock Splits': [0.0]}, index=pd.to_datetime([date.today()]))
        def history(*args):
            history_started.set()
            self.assertTrue(market_started.wait(2), 'Profile should start before history finishes')
            return {**price_observations(frame, date.today(), date.today()), 'currency': 'USD'}
        def market(instance, **kwargs):
            self.assertIs(instance, profile_stock)
            self.assertTrue(kwargs['fundamentals_only'])
            market_started.set()
            self.assertTrue(history_started.wait(2))
            return {'profile': {'longName': 'Test Company'}}
        with patch('server.studies.yf.Ticker', side_effect=[stock, profile_stock]) as ticker, patch('server.studies.fetch_market', side_effect=market), patch('server.studies.fetch_weekly_prices', side_effect=history):
            result = fetch_prices('BRK.B', fundamentals_only=True)
        self.assertEqual([call.args[0] for call in ticker.call_args_list], ['BRK-B', 'BRK-B'])
        self.assertEqual(result['currency'], 'USD')
        self.assertEqual(result['prices'][0]['close'], 40)
        self.assertEqual(result['market']['profile']['longName'], 'Test Company')
        self.assertEqual(result['interval'], '1wk')
        stock.history.assert_not_called()

    def test_fast_history_conversion_preserves_windows_missing_values_and_splits(self):
        frame = pd.DataFrame({'Close': [10, 20, float('nan'), 40], 'High': [12, 22, 32, 42],
                              'Low': [8, float('nan'), 28, 38], 'Stock Splits': [0, 4, 0, -1]},
                             index=pd.to_datetime(['2015-12-31', '2020-06-30', '2021-01-01', '2025-12-31']))
        result = price_observations(frame, date(2016, 1, 1), date(2026, 1, 1))
        self.assertEqual(result['prices'], [{'date': '2020-06-30', 'close': 20}, {'date': '2025-12-31', 'close': 40}])
        self.assertEqual(len(result['priceHistory']), 3)
        self.assertEqual(result['priceHistory'][0]['date'], '2015-12-31')
        self.assertIsNone(result['priceHistory'][1]['low'])
        self.assertIsNone(result['priceHistory'][0]['open'])
        self.assertIsNone(result['priceHistory'][0]['volume'])
        self.assertEqual(result['splits'], [{'date': '2020-06-30', 'ratio': 4}])
        self.assertFalse(result['splitHistoryAvailable'])
        missing_splits = price_observations(frame.drop(columns='Stock Splits'), date(2016, 1, 1), date(2026, 1, 1))
        self.assertFalse(missing_splits['splitHistoryAvailable'])
        self.assertEqual(missing_splits['splits'], [])
        with self.assertRaises(ValueError):
            price_observations(frame.iloc[:0], date(2016, 1, 1), date(2026, 1, 1))

    def test_gzip_negotiation_respects_clients_that_disable_it(self):
        for header in ['gzip', 'gzip, deflate, br', 'br, gzip;q=0.5', 'GZIP']:
            self.assertTrue(accepts_gzip(header))
        for header in ['', 'identity', 'gzip;q=0', 'gzip; q=0.0', 'gzip; q=invalid']:
            self.assertFalse(accepts_gzip(header))

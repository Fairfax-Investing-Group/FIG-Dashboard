from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from http.server import ThreadingHTTPServer
import json
import threading
import unittest
from unittest.mock import MagicMock, patch

import requests

from server.fundamentals import DURATION, INSTANT, FUNDAMENTALS_FIELDS, extract_statements
from server.studies import create_study, complete_study, fetch_financials, get_study
from server.tests import test_weekly_fundamentals as weekly_fixtures
from server.yahoo_profile import get_profile, _PROFILES, _PENDING
from server.quotes import get_quote, _fetch_quote
from server.market import fetch_market


class ProgressiveStudyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = weekly_fixtures.WeeklyStudyTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        _PROFILES.clear()
        _PENDING.clear()
        _fetch_quote.cache_clear()

    def test_quote_and_study_share_a_concurrent_profile_request(self):
        started, release = threading.Event(), threading.Event()
        stock = MagicMock(ticker='SHARED')
        def profile():
            started.set()
            self.assertTrue(release.wait(3))
            return {'currency': 'USD', 'regularMarketPrice': 40, 'regularMarketPreviousClose': 39}
        stock.get_info.side_effect = profile
        with patch('server.yahoo_profile.yf.Ticker', return_value=stock), ThreadPoolExecutor(max_workers=2) as executor:
            quote = executor.submit(get_quote, 'SHARED')
            self.assertTrue(started.wait(3))
            study = executor.submit(fetch_market, stock, fundamentals_only=True)
            release.set()
            self.assertEqual(quote.result(timeout=3)['regular']['price'], 40)
            self.assertEqual(study.result(timeout=3)['profile']['regularMarketPrice'], 40)
        stock.get_info.assert_called_once()

    def test_failed_shared_request_can_retry(self):
        stock = MagicMock()
        stock.get_info.side_effect = [RuntimeError('temporary'), {'currency': 'USD'}]
        with patch('server.yahoo_profile.yf.Ticker', return_value=stock):
            with self.assertRaises(RuntimeError):
                get_profile('RETRY')
            self.assertEqual(get_profile('RETRY'), {'currency': 'USD'})
        self.assertEqual(stock.get_info.call_count, 2)

    def test_sec_and_prices_publish_before_slow_profile_and_eps_waits_for_splits(self):
        fixture = self.fixture
        got_sec, allow_history, got_prices, release_profile = (threading.Event() for _ in range(4))
        updates = []
        def history(ticker):
            self.assertTrue(allow_history.wait(3))
            return deepcopy(fixture.weekly)
        def profile(ticker):
            self.assertTrue(release_profile.wait(3))
            return fixture.profile
        def publish(doc):
            updates.append(doc)
            if doc['AnnualData'] and not doc['WeeklyPrices']:
                got_sec.set()
            if doc['WeeklyPrices']:
                got_prices.set()
        with patch('server.studies.fetch_financials', return_value=deepcopy(fixture.financials)), patch('server.studies.fetch_initial_history', side_effect=history), patch('server.studies.get_profile', side_effect=profile), ThreadPoolExecutor(max_workers=1) as executor:
            task = executor.submit(create_study, fixture.company, fundamentals_only=True, on_progress=publish)
            try:
                self.assertTrue(got_sec.wait(3), 'SEC table should publish without waiting for Yahoo')
                self.assertEqual(updates[-1]['AnnualData'][0]['Sales'], 100)
                self.assertIsNone(updates[-1]['AnnualData'][0]['EPS'])
                self.assertEqual(updates[-1]['Metadata']['Sources']['YahooFinance']['Status'], 'loading')
                allow_history.set()
                self.assertTrue(got_prices.wait(3), 'Prices and verified EPS should publish without the profile')
                self.assertEqual(updates[-1]['AnnualData'][0]['EPS'], 2)
                self.assertFalse(task.done())
            finally:
                allow_history.set()
                release_profile.set()
            final = task.result(timeout=3)
        self.assertEqual(final['AnnualData'][0]['EPS'], 2)
        self.assertEqual(final['Company']['Description'], fixture.profile['longBusinessSummary'])
        self.assertEqual(get_study(final['Study']['StudyID']), final)
        self.assertEqual(fixture.financials['annual'][0]['eps'], 8, 'Intermediate normalization must not mutate original data')

    def test_skinny_sec_pass_defers_metadata_and_full_extraction_until_completion(self):
        fixture = self.fixture
        payload = {'facts': {}}
        with patch('server.studies.sec_json', return_value=payload) as fetch, patch('server.studies.normalize_financials', return_value=deepcopy(fixture.financials)), patch('server.studies.extract_statements', return_value={'annual': {}, 'quarterly': []}) as extract:
            core = fetch_financials(123, fundamentals_only=True)
        fetch.assert_called_once()
        self.assertIn('companyfacts', fetch.call_args.args[0])
        self.assertTrue(extract.call_args.kwargs['fundamentals_only'])
        self.assertIs(core['_secPayload'], payload)
        with patch('server.studies.fetch_financials', return_value=core), patch('server.studies.fetch_prices', return_value=deepcopy(fixture.weekly)):
            initial = create_study(fixture.company, fundamentals_only=True)
        with patch('server.studies.sec_json', return_value={'sic': '1234'}) as metadata, patch('server.studies.extract_statements', return_value={'annual': {}, 'quarterly': []}) as full, patch('server.studies.fetch_prices', return_value=deepcopy(fixture.daily)), patch('server.peers.add_peers'):
            final = complete_study(initial['Study']['StudyID'])
        metadata.assert_called_once()
        self.assertIn('/submissions/', metadata.call_args.args[0])
        self.assertNotIn('fundamentals_only', full.call_args.kwargs)
        self.assertEqual(final['Metadata']['DataStage'], 'complete')
        self.assertEqual(final['AnnualData'][0]['EPS'], 2)
        self.assertNotIn('_secPayload', final)

    def test_core_extractor_visits_only_fundamentals_concepts(self):
        with patch('server.fundamentals.facts_for', return_value=[]) as facts:
            extract_statements({}, 'USD', [], fundamentals_only=True)
        self.assertEqual({call.args[1] for call in facts.call_args_list}, FUNDAMENTALS_FIELDS)
        self.assertLess(len(FUNDAMENTALS_FIELDS), len(DURATION) + len(INSTANT))

    def test_http_gzip_stream_delivers_a_section_before_creation_finishes(self):
        from server.app import Handler
        fixture = self.fixture
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        release = threading.Event()
        try:
            def create(company, **kwargs):
                with patch('server.studies.fetch_financials', return_value=deepcopy(fixture.financials)), patch('server.studies.fetch_prices', return_value=deepcopy(fixture.weekly)):
                    doc = create_study(company, fundamentals_only=True)
                kwargs['on_progress'](doc)
                self.assertTrue(release.wait(3))
                return doc
            with patch('server.app.company_for', return_value=fixture.company), patch('server.app.create_study', side_effect=create), patch.object(Handler, 'log_message'):
                with requests.post(f'http://127.0.0.1:{server.server_port}/api/studies?stage=fundamentals', json={'ticker': 'TEST', 'cik': 123}, headers={'Accept': 'application/x-ndjson'}, stream=True, timeout=3) as response:
                    self.assertEqual(response.headers['Content-Encoding'], 'gzip')
                    events = response.iter_lines(chunk_size=1)
                    self.assertEqual(json.loads(next(events))['type'], 'progress')
                    release.set()
                    self.assertEqual(json.loads(next(events))['type'], 'ready')
                    self.assertEqual(list(events), [])
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

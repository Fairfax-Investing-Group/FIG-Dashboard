import os
from pathlib import Path
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import MagicMock, patch
from http.server import ThreadingHTTPServer
import requests

from server.market import fetch_market
from server.studies import complete_study, connection, create_study, get_study


class StudyStagesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {'STUDY_DB': str(Path(self.directory.name) / 'studies.sqlite3')})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.directory.cleanup)
        self.company = {'ticker': 'TEST', 'cik': 123, 'name': 'Test Company', 'exchange': 'Nasdaq'}
        self.profile = {'financialCurrency': 'USD', 'longBusinessSummary': 'Company description'}
        self.financials = {'currency': 'USD', 'annual': [{'periodEnd': '2025-12-31', 'sales': 100e6, 'eps': 2, 'pretaxProfit': 20e6,
                            'epsSource': {'filed': '2026-02-01'}}], 'warnings': [], 'retrievedAt': '2026-10-24T00:00:00Z'}
        self.prices = {'prices': [{'date': '2026-10-23', 'close': 40}], 'currency': 'USD', 'start': '2016-01-01',
                       'end': '2026-10-24', 'retrievedAt': '2026-10-24T00:00:00Z', 'splitHistoryAvailable': True,
                       'splitHistoryStart': '2016-01-01', 'splits': [], 'market': {'profile': self.profile}}

    def create_core(self):
        with patch('server.studies.fetch_financials', return_value=self.financials) as financials, patch('server.studies.fetch_prices', return_value=self.prices) as prices, patch('server.peers.add_peers') as peers:
            study = create_study(self.company, fundamentals_only=True)
        self.assertTrue(prices.call_args.kwargs['fundamentals_only'])
        financials.assert_called_once()
        peers.assert_not_called()
        self.assertEqual(study['Metadata']['DataStage'], 'fundamentals')
        self.assertEqual(study['AnnualData'][0]['EPS'], 2)
        self.assertEqual(study['Company']['Description'], 'Company description')
        self.assertEqual(get_study(study['Study']['StudyID']), study)
        return study

    def test_fundamentals_market_only_fetches_the_profile(self):
        stock = MagicMock()
        stock.ticker = 'TEST'
        stock.get_info.return_value = self.profile
        with patch('server.market.statement_fallbacks') as fallbacks, patch('server.market.yf.Industry') as industry:
            data = fetch_market(stock, fundamentals_only=True)
        self.assertEqual(data['profile'], self.profile)
        stock.get_info.assert_called_once()
        stock.get_earnings_estimate.assert_not_called()
        stock.get_revenue_estimate.assert_not_called()
        fallbacks.assert_not_called()
        industry.assert_not_called()

    def test_completion_reuses_core_data_and_updates_the_same_saved_study(self):
        core = self.create_core()
        study_id = core['Study']['StudyID']
        market = {'profile': self.profile, 'analystEstimates': [{'FiscalYear': 2027, 'EpsEst': 3}], 'peerSymbols': ['PEER']}
        with patch('server.studies.fetch_financials') as financials, patch('server.studies.fetch_prices') as prices, patch('server.studies.fetch_market', return_value=market) as fetch, patch('server.peers.add_peers') as peers:
            completed = complete_study(study_id)
            again = complete_study(study_id)
        financials.assert_not_called()
        prices.assert_not_called()
        fetch.assert_called_once()
        self.assertEqual(fetch.call_args.kwargs['profile'], self.profile)
        peers.assert_called_once()
        self.assertEqual(completed, again)
        self.assertEqual(completed['Study']['StudyID'], study_id)
        self.assertEqual(completed['Study']['DateCreated'], core['Study']['DateCreated'])
        self.assertEqual(completed['Metadata']['DataStage'], 'complete')
        self.assertEqual(completed['AnnualData'], core['AnnualData'])
        self.assertEqual(completed['AnalystEstimates'][0]['EpsEst'], 3)
        self.assertEqual(get_study(study_id), completed)
        with connection() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM studies').fetchone()[0], 1)
            self.assertIsNone(db.execute('SELECT id FROM study_inputs WHERE id = ?', (study_id,)).fetchone())

    def test_failed_completion_keeps_fundamentals_and_can_resume_after_reopening(self):
        core = self.create_core()
        study_id = core['Study']['StudyID']
        with patch('server.studies.fetch_market', side_effect=RuntimeError('Temporary error')):
            with self.assertRaises(RuntimeError):
                complete_study(study_id)
        self.assertEqual(get_study(study_id), core)
        with patch('server.studies.fetch_market', return_value={'profile': self.profile}), patch('server.peers.add_peers'):
            self.assertEqual(complete_study(study_id)['Metadata']['DataStage'], 'complete')

    def test_concurrent_completion_does_not_repeat_optional_requests(self):
        study_id = self.create_core()['Study']['StudyID']
        started, release = threading.Event(), threading.Event()
        def market(*args, **kwargs):
            started.set()
            self.assertTrue(release.wait(3))
            return {'profile': self.profile}
        with patch('server.studies.fetch_market', side_effect=market) as fetch, patch('server.peers.add_peers'), ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(complete_study, study_id)
            self.assertTrue(started.wait(3))
            second = executor.submit(complete_study, study_id)
            release.set()
            self.assertEqual(first.result(timeout=3), second.result(timeout=3))
        fetch.assert_called_once()

    def test_unknown_study_is_not_recreated(self):
        with self.assertRaises(LookupError):
            complete_study('missing')

    def test_http_creation_and_completion_keep_one_study_id(self):
        from server.app import Handler
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}/api/studies'
        try:
            with patch('server.app.company_for', return_value=self.company), patch('server.studies.fetch_financials', return_value=self.financials), patch('server.studies.fetch_prices', return_value=self.prices), patch('server.studies.fetch_market', return_value={'profile': self.profile}), patch('server.peers.add_peers'), patch.object(Handler, 'log_message'):
                initial = requests.post(url + '?stage=fundamentals', json={'ticker': 'TEST', 'cik': 123}, timeout=3)
                self.assertEqual(initial.status_code, 201)
                core = initial.json()
                study_id = core['Study']['StudyID']
                self.assertEqual(core['Metadata']['DataStage'], 'fundamentals')
                final = requests.post(f'{url}/{study_id}/complete', json={}, timeout=3)
                self.assertEqual(final.status_code, 200)
                self.assertEqual(final.json()['Study']['StudyID'], study_id)
                self.assertEqual(final.json()['Metadata']['DataStage'], 'complete')
                self.assertEqual(requests.get(f'{url}/{study_id}', timeout=3).json(), final.json())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

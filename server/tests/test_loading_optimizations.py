from concurrent.futures import CancelledError, ThreadPoolExecutor
from copy import deepcopy
from datetime import date
import json
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

import pandas as pd

from server import study_preload
from server.fundamentals import extract_statements
from server.fundamentals_view import study_view
from server.studies import compact_sec_payload, complete_study, create_study, fetch_financials, fetch_prices, sec_json
from server.tests import test_weekly_fundamentals as fixtures
from server.tests.test_fundamentals import fact, payload, put


class LoadingOptimizationsTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.WeeklyStudyTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_compact_checkpoint_preserves_full_statement_extraction_and_provenance(self):
        data = payload()
        for tag, value, unit in [
            ('RevenueFromContractWithCustomerIncludingAssessedTax', 100e6, 'USD'),
            ('EarningsPerShareDiluted', 2, 'USD/shares'),
            ('NetIncomeLoss', 20e6, 'USD'),
            ('NetCashProvidedByUsedInOperatingActivities', 30e6, 'USD'),
            ('PaymentsToAcquirePropertyPlantAndEquipment', 8e6, 'USD'),
            ('WeightedAverageNumberOfDilutedSharesOutstanding', 10e6, 'shares'),
        ]:
            put(data, tag, [fact(value, end='2025-12-31', start='2025-01-01', filed='2026-02-01')], unit)
        put(data, 'StockholdersEquity', [fact(80e6, end='2024-12-31'), fact(100e6, end='2025-12-31', filed='2026-02-01')])
        put(data, 'UnneededConcept', [fact(42)] * 100)
        compact = compact_sec_payload(data, 'USD')
        annual = [{'periodEnd': '2025-12-31'}]
        self.assertEqual(extract_statements(data, 'USD', annual), extract_statements(compact, 'USD', annual))
        self.assertNotIn('UnneededConcept', compact['facts']['us-gaap'])
        self.assertLess(len(json.dumps(compact)), len(json.dumps(data)))

    def test_app_projection_keeps_all_valuation_and_ttm_inputs(self):
        fixture = self.fixture
        with patch('server.studies.fetch_financials', return_value=deepcopy(fixture.financials)), patch('server.studies.fetch_prices', return_value=deepcopy(fixture.weekly)):
            document = create_study(fixture.company, fundamentals_only=True)
        document['AnnualData'][0].update(HighPrice=40, LowPrice=10, HighPE=20, LowPE=5, Dividend=.5)
        document['Company']['Dividend'] = .5
        document['Peers'] = [{'unused': 'large peer document'}]
        view = study_view(document)
        for key in ('Sales', 'EPS', 'PTP', 'HighPrice', 'LowPrice', 'HighPE', 'LowPE', 'Dividend', 'BookValue', 'CashFlow', 'FreeCashFlow', 'SharesOut'):
            self.assertEqual(view['AnnualData'][0][key], document['AnnualData'][0][key])
        self.assertEqual(view['Company']['Dividend'], .5)
        self.assertNotIn('Peers', view)
        self.assertNotIn('FieldCoverage', view['Metadata'])
        self.assertIn('Peers', document, 'Projection must not alter the export document')

    def test_history_publishes_while_optional_market_data_is_still_running(self):
        market_started, published, release = (threading.Event() for _ in range(3))
        stock, market_stock = MagicMock(), MagicMock()
        stock.history_metadata = {'currency': 'USD'}
        stock.history.return_value = pd.DataFrame({'Close': [40.0], 'Stock Splits': [0]}, index=pd.to_datetime([date.today()]))
        def market(*args, **kwargs):
            market_started.set()
            self.assertTrue(release.wait(3))
            return {'profile': {'financialCurrency': 'USD'}}
        def history(data):
            self.assertEqual(data['prices'][0]['close'], 40)
            published.set()
        with patch('server.studies.yf.Ticker', side_effect=[stock, market_stock]), patch('server.studies.fetch_market', side_effect=market), ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(fetch_prices, 'TEST', on_history=history)
            try:
                self.assertTrue(market_started.wait(3))
                self.assertTrue(published.wait(3))
                self.assertFalse(future.done())
            finally:
                release.set()
            self.assertEqual(future.result(timeout=3)['market']['profile']['financialCurrency'], 'USD')

    def test_daily_progress_and_manual_valuation_inputs_are_available_before_peers_finish(self):
        fixture = self.fixture
        with patch('server.studies.fetch_financials', return_value=deepcopy(fixture.financials)), patch('server.studies.fetch_prices', return_value=deepcopy(fixture.weekly)):
            initial = create_study(fixture.company, fundamentals_only=True)
        waiting, release = threading.Event(), threading.Event()
        updates = []
        def peers(*args):
            waiting.set()
            self.assertTrue(release.wait(3))
        def prices(*args, **kwargs):
            kwargs['on_history'](deepcopy(fixture.daily))
            return deepcopy(fixture.daily)
        with patch('server.studies.fetch_prices', side_effect=prices), patch('server.peers.add_peers', side_effect=peers), ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(complete_study, initial['Study']['StudyID'], lambda doc: updates.append(deepcopy(doc)))
            try:
                self.assertTrue(waiting.wait(3))
                self.assertFalse(future.done())
                self.assertTrue(all(update['DailyPrices'] for update in updates))
                self.assertEqual(updates[0]['AnnualData'][0]['EPS'], 2)
                self.assertEqual(updates[-1]['Metadata']['DataStage'], 'fundamentals')
            finally:
                release.set()
            self.assertEqual(future.result(timeout=3)['Metadata']['DataStage'], 'complete')

    def test_idle_expiry_releases_preload_payloads_without_a_new_search(self):
        company = {'cik': 999, 'ticker': 'EXPIRE'}
        job = study_preload.Preload(company, 'expiry-test')
        job.done = True
        job.result = {'large': [1, 2, 3]}
        job.latest = {'document': 'unused'}
        key = study_preload.preload_key(company, 'expiry-test')
        study_preload._JOBS[key] = job
        study_preload.expire_preloads(job.started + study_preload.TTL_SECONDS + 1)
        self.assertNotIn(key, study_preload._JOBS)
        self.assertTrue(job.cancelled.is_set())
        self.assertIsNone(job.result)
        self.assertIsNone(job.latest)

    def test_cancelled_preload_does_not_start_a_sec_download(self):
        cancelled = threading.Event()
        cancelled.set()
        with patch('server.studies.sec_get_json') as transport:
            with self.assertRaises(CancelledError):
                sec_json('https://data.sec.gov/test', cancelled=cancelled)
            with self.assertRaises(CancelledError):
                fetch_financials(123, fundamentals_only=True, cancelled=cancelled)
        transport.assert_not_called()

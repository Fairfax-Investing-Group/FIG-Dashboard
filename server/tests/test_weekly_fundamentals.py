from copy import deepcopy
from datetime import date, datetime
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import requests

from server.eps import normalize_eps
from server.fundamentals_view import fundamentals_view
from server.studies import complete_study, create_study, get_study
from server.weekly_prices import fetch_weekly_prices, weekly_observations


def stamp(day):
    return int(datetime.fromisoformat(day + 'T09:30:00').replace(tzinfo=ZoneInfo('America/New_York')).timestamp())


def weekly_payload():
    return {'chart': {'error': None, 'result': [{
        'meta': {'currency': 'USD', 'exchangeTimezoneName': 'America/New_York'},
        'timestamp': [stamp('2020-08-31'), stamp('2020-09-04')],
        'indicators': {'quote': [{'close': [40, 41]}]},
        'events': {'splits': {'event': {'date': stamp('2020-09-01'), 'numerator': 4, 'denominator': 1}}},
    }]}}


class WeeklyParsingTests(unittest.TestCase):
    def test_one_weekly_request_preserves_exact_split_day_and_coalesces_live_point(self):
        stock = MagicMock(ticker='TEST')
        stock._data.get_raw_json.return_value = weekly_payload()
        result = fetch_weekly_prices(stock, date(2020, 1, 1), date(2016, 1, 1), date(2020, 9, 5))
        params = stock._data.get_raw_json.call_args.kwargs['params']
        self.assertEqual(params['interval'], '1wk')
        self.assertEqual(params['events'], 'splits')
        stock._data.get_raw_json.assert_called_once()
        stock.history.assert_not_called()
        self.assertEqual(result['prices'], [{'date': '2020-08-31', 'close': 41}])
        self.assertEqual(result['splits'], [{'date': '2020-09-01', 'ratio': 4}])
        self.assertTrue(result['splitHistoryAvailable'])
        self.assertEqual(result['priceHistory'], [])
        # Filing is after the weekly bucket date, before the actual split date.
        row = {'eps': 8, 'epsSource': {'filed': '2020-08-31'}}
        self.assertEqual(normalize_eps([row], result['splits'], '2020-09-05')[0]['eps'], 2)

    def test_malformed_split_or_unknown_timezone_cannot_verify_eps(self):
        for change in ['ratio', 'timezone', 'event-shape']:
            payload = weekly_payload()
            result = payload['chart']['result'][0]
            if change == 'ratio':
                result['events']['splits']['event']['denominator'] = 0
            elif change == 'timezone':
                result['meta'].pop('exchangeTimezoneName')
            else:
                result['events']['splits'] = []
            self.assertFalse(weekly_observations(payload, date(2020, 1, 1), date(2016, 1, 1), date(2020, 9, 5))['splitHistoryAvailable'])

    def test_bad_chart_data_is_rejected(self):
        for payload in [{'chart': {'error': {'code': 'Not Found'}, 'result': None}}, {'chart': {'result': []}}]:
            with self.assertRaises(ValueError):
                weekly_observations(payload, date(2020, 1, 1), date(2016, 1, 1), date(2020, 9, 5))
        payload = weekly_payload()
        payload['chart']['result'][0]['indicators']['quote'][0]['close'] = []
        with self.assertRaises(ValueError):
            weekly_observations(payload, date(2020, 1, 1), date(2016, 1, 1), date(2020, 9, 5))


class WeeklyStudyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {'STUDY_DB': str(Path(self.directory.name) / 'studies.sqlite3')})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.directory.cleanup)
        self.company = {'ticker': 'TEST', 'cik': 123, 'name': 'Test Company', 'exchange': 'Nasdaq'}
        self.profile = {'financialCurrency': 'USD', 'longBusinessSummary': 'Test description'}
        source = {'concept': 'us-gaap:EarningsPerShareDiluted', 'filed': '2020-08-31', 'accession': '0000000123-20-000001', 'unit': 'USD/shares', 'start': '2019-01-01', 'end': '2019-12-31'}
        self.financials = {'currency': 'USD', 'annual': [{'periodEnd': '2019-12-31', 'sales': 100e6, 'eps': 8, 'pretaxProfit': 20e6, 'epsSource': source}],
                           'warnings': [], 'retrievedAt': '2026-10-24T00:00:00Z'}
        self.weekly = {'prices': [{'date': '2026-10-12', 'close': 39}, {'date': '2026-10-19', 'close': 40}],
                       'interval': '1wk', 'priceHistory': [], 'currency': 'USD', 'start': '2016-01-01', 'end': '2026-10-24',
                       'retrievedAt': '2026-10-24T00:00:00Z', 'splitHistoryAvailable': True, 'splitHistoryStart': '2016-01-01',
                       'splits': [{'date': '2020-09-01', 'ratio': 4}], 'market': {'profile': self.profile}, 'url': 'https://finance.yahoo.com/quote/TEST/history/'}
        self.daily = {**self.weekly, 'interval': '1d', 'prices': [{'date': '2026-10-22', 'close': 40}, {'date': '2026-10-23', 'close': 41}],
                      'market': {'profile': self.profile, 'analystEstimates': [{'FiscalYear': 2027, 'EpsEst': 3}]}}

    def core(self):
        with patch('server.studies.fetch_financials', return_value=deepcopy(self.financials)), patch('server.studies.fetch_prices', return_value=deepcopy(self.weekly)):
            return create_study(self.company, fundamentals_only=True)

    def test_slim_projection_keeps_financial_values_and_full_document_server_side(self):
        full = self.core()
        view = fundamentals_view(full)
        self.assertNotIn('MonthlyPrices', view)
        self.assertNotIn('Peers', view)
        self.assertNotIn('FieldCoverage', view['Metadata'])
        self.assertIsNone(view['AnnualData'][0]['Sources']['EPS'])
        self.assertIsNotNone(full['AnnualData'][0]['Sources']['EPS'])
        self.assertEqual(view['AnnualData'][0]['EPS'], 2)
        self.assertEqual(view['AnnualData'][0]['EPSSplitFactor'], 4)
        self.assertEqual(view['Metadata']['EPSAdjustment']['Status'], 'normalized')
        self.assertEqual(view['DailyPrices'], [])
        self.assertEqual(view['WeeklyPrices'], full['WeeklyPrices'])
        self.assertEqual(view['Metadata']['PriceInterval'], '1wk')
        self.assertEqual(get_study(full['Study']['StudyID']), full)
        self.assertLess(len(json.dumps(view)), len(json.dumps(full)))

    def test_background_daily_history_replaces_weekly_and_does_not_double_adjust_eps(self):
        initial = self.core()
        study_id = initial['Study']['StudyID']
        with patch('server.studies.fetch_financials') as sec, patch('server.studies.fetch_prices', return_value=deepcopy(self.daily)) as fetch, patch('server.peers.add_peers'):
            completed = complete_study(study_id)
            self.assertEqual(complete_study(study_id), completed)
        sec.assert_not_called()
        fetch.assert_called_once_with('TEST', profile=self.profile)
        self.assertEqual(completed['Study']['StudyID'], study_id)
        self.assertEqual(completed['Metadata']['DataStage'], 'complete')
        self.assertEqual(completed['Metadata']['PriceInterval'], '1d')
        self.assertEqual(completed['WeeklyPrices'], [])
        self.assertEqual(len(completed['DailyPrices']), 2)
        self.assertEqual(completed['DailyPrices'][-1]['Close'], 41)
        self.assertEqual(completed['AnnualData'][0]['EPS'], initial['AnnualData'][0]['EPS'])
        self.assertEqual(completed['AnnualData'][0]['EPSSplitFactor'], 4)
        self.assertIsNotNone(completed['AnnualData'][0]['Sources']['EPS'])
        self.assertEqual(get_study(study_id), completed)

    def test_daily_failure_keeps_weekly_snapshot_and_can_retry(self):
        initial = self.core()
        study_id = initial['Study']['StudyID']
        with patch('server.studies.fetch_prices', side_effect=RuntimeError('Temporary failure')):
            with self.assertRaises(RuntimeError):
                complete_study(study_id)
        self.assertEqual(get_study(study_id), initial)
        with patch('server.studies.fetch_prices', return_value=deepcopy(self.daily)), patch('server.peers.add_peers'):
            self.assertEqual(complete_study(study_id)['Metadata']['PriceInterval'], '1d')

    def test_http_first_response_is_slim_but_export_retains_full_data(self):
        from server.app import Handler
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}/api/studies'
        def prices(*args, **kwargs):
            return deepcopy(self.weekly if kwargs.get('fundamentals_only') else self.daily)
        try:
            with patch('server.app.company_for', return_value=self.company), patch('server.studies.fetch_financials', return_value=deepcopy(self.financials)), patch('server.studies.fetch_prices', side_effect=prices), patch('server.peers.add_peers'), patch.object(Handler, 'log_message'):
                first = requests.post(url + '?stage=fundamentals', json={'ticker': 'TEST', 'cik': 123}, timeout=3).json()
                study_id = first['Study']['StudyID']
                self.assertEqual(first['Metadata']['ResponseView'], 'fundamentals')
                self.assertIsNone(first['AnnualData'][0]['Sources']['EPS'])
                exported = requests.get(f'{url}/{study_id}', timeout=3).json()
                self.assertIsNotNone(exported['AnnualData'][0]['Sources']['EPS'])
                reopened = requests.get(f'{url}/{study_id}?view=fundamentals', timeout=3).json()
                self.assertEqual(reopened, first)
                final = requests.post(f'{url}/{study_id}/complete', json={}, timeout=3).json()
                self.assertEqual(final['Metadata']['PriceInterval'], '1d')
                self.assertEqual(requests.get(f'{url}/{study_id}?view=fundamentals', timeout=3).json(), final)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

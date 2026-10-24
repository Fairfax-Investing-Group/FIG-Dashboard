from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server import portfolio as p


class PortfolioTests(unittest.TestCase):
    def setUp(self):
        p._ERROR = None
        p._RETRY_AT = None
        self.seed, self.fingerprint = p.load_seed()

    def histories(self):
        prices = {item['ticker']: item['price'] for item in self.seed['holdings']}
        for partner in self.seed['partners']:
            for pitch in partner['pitches']:
                prices.setdefault(pitch['ticker'], pitch['price'])
        prices.update({item['ticker']: 100 for item in self.seed['marketPulse']})
        prices.update({p.INDEX_SYMBOLS[item['name']]: item['price'] for item in self.seed['indexes']})
        data = {}
        for symbol, price in prices.items():
            factor = 2 if symbol == 'MSFT' else 1
            data[symbol] = [{'date': day, 'close': price * multiplier / factor, 'high': price * multiplier * 1.01 / factor,
                             'low': price * multiplier * .99 / factor, 'split': factor if day == '2026-10-26' and factor > 1 else 0}
                            for day, multiplier in [('2026-10-22', .99), ('2026-10-23', 1), ('2026-10-26', 1.1)]]
        return data

    def test_calendar_observes_close_delay_weekends_holidays_early_close_and_dst(self):
        for now, expected in [
            ('2026-10-23T20:14:00+00:00', '2026-10-22'),
            ('2026-10-23T20:15:00+00:00', '2026-10-23'),
            ('2026-10-24T22:00:00+00:00', '2026-10-23'),
            ('2026-11-26T22:00:00+00:00', '2026-11-25'),
            ('2026-11-27T18:14:00+00:00', '2026-11-25'),
            ('2026-11-27T18:15:00+00:00', '2026-11-27'),
            ('2027-01-20T21:15:00+00:00', '2027-01-20'),
        ]:
            with self.subTest(now=now):
                session, next_run = p.refresh_window(datetime.fromisoformat(now))
                self.assertEqual(session, expected)
                self.assertGreater(next_run, datetime.fromisoformat(now))
        self.assertEqual(p.refresh_window(datetime.fromisoformat('2026-10-24T22:00:00+00:00'))[1].isoformat(), '2026-10-26T20:15:00+00:00')

    def test_prices_returns_history_and_split_adjustments_preserve_original_transactions(self):
        original = deepcopy(self.seed)
        result = p.calculate_portfolio(self.seed, self.histories(), '2026-10-26')
        summary = result['summary']
        self.assertEqual(self.seed, original)
        self.assertAlmostEqual(summary['holdingsValue'], original['summary']['holdingsValue'] * 1.1)
        self.assertAlmostEqual(summary['portfolioValue'], summary['holdingsValue'] + original['summary']['cash'])
        self.assertAlmostEqual(summary['gain'], summary['holdingsValue'] - summary['totalCost'])
        self.assertAlmostEqual(summary['benchmarkReturn'], (1 + original['summary']['benchmarkReturn']) * 1.1 - 1)
        self.assertAlmostEqual(sum(item['weight'] for item in result['holdings']), 1)
        for old, new in zip(original['holdings'], result['holdings']):
            self.assertEqual(new['purchaseDate'], old['purchaseDate'])
            self.assertEqual(new['cost'], old['cost'])
            self.assertEqual(new['purchaseNote'], old['purchaseNote'])
        msft = next(item for item in result['holdings'] if item['ticker'] == 'MSFT')
        self.assertEqual(msft['shares'], 6)
        self.assertEqual(msft['averageCost'], 392.93 / 2)
        self.assertEqual(result['performance'][-1]['date'], '2026-10-26')
        self.assertAlmostEqual(result['performance'][-1]['club'], summary['portfolioReturn'])
        self.assertEqual(len({point['date'] for point in result['performance']}), len(result['performance']))
        self.assertEqual(result['partners'][0]['pitches'][0]['date'], original['partners'][0]['pitches'][0]['date'])
        self.assertTrue(all(index['history'] for index in result['indexes']))

    def test_failed_refresh_retains_persistent_snapshot_then_retries_without_duplicate_updates(self):
        now = datetime(2026, 10, 26, 20, 16, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'PORTFOLIO_CACHE': str(Path(directory) / 'portfolio.json')}):
            cached = {**self.seed, 'seedFingerprint': self.fingerprint, 'lastSuccessfulAt': '2026-10-23T20:16:00Z'}
            p.cache_path().write_text(json.dumps(cached))
            original = p.cache_path().read_bytes()
            with patch.object(p, 'fetch_history', side_effect=ValueError('MSFT close missing')):
                self.assertFalse(p.refresh_if_due(now))
            self.assertEqual(p.cache_path().read_bytes(), original)
            self.assertEqual(p.get_portfolio(now)['refresh']['status'], 'error')
            histories = self.histories()
            with patch.object(p, 'fetch_history', side_effect=lambda symbol, *args: histories[symbol]) as fetch:
                self.assertFalse(p.refresh_if_due(now + timedelta(minutes=1)))
                fetch.assert_not_called()
                self.assertTrue(p.refresh_if_due(now + timedelta(minutes=6)))
                count = fetch.call_count
                self.assertFalse(p.refresh_if_due(now + timedelta(minutes=7)))
                self.assertEqual(fetch.call_count, count)
            saved = p.get_portfolio(now + timedelta(minutes=7))
            self.assertEqual(saved['asOf'], '2026-10-26')
            self.assertEqual(saved['refresh']['status'], 'ready')
            self.assertFalse(p.cache_path().with_suffix('.tmp').exists())

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

    def test_beta_uses_adjusted_returns_and_cash_weighting(self):
        histories = self.histories()
        market, stock = 100, 100
        benchmark, security = [], []
        start = datetime(2026, 8, 1)
        for index in range(75):
            change = (.01, -.005, .002)[index % 3]
            market *= 1 + change
            stock *= 1 + 2 * change
            day = (start + timedelta(days=index)).date().isoformat()
            benchmark.append({'date': day, 'adjustedClose': market})
            security.append({'date': day, 'adjustedClose': stock})
        self.assertAlmostEqual(p.stock_beta(security, benchmark, '2026-10-26'), 2)
        self.assertIsNone(p.stock_beta(security[:60], benchmark, '2026-10-26'))
        self.assertIsNone(p.stock_beta(security, [{'date': x['date'], 'adjustedClose': 100} for x in benchmark], '2026-10-26'))
        # Raw closing prices may differ from adjusted prices after splits/dividends.
        for symbol, records in histories.items():
            adjusted = benchmark if symbol == '^GSPC' else security
            histories[symbol] = [{**records[0], **point} for point in adjusted] + records
        result = p.calculate_portfolio(self.seed, histories, '2026-10-26')
        self.assertTrue(all(abs(item['beta'] - 2) < 1e-10 for item in result['holdings']))
        summary = result['summary']
        self.assertAlmostEqual(summary['beta'], 2 * summary['holdingsValue'] / summary['portfolioValue'])
        histories[self.seed['holdings'][0]['ticker']] = self.histories()[self.seed['holdings'][0]['ticker']]
        result = p.calculate_portfolio(self.seed, histories, '2026-10-26')
        self.assertIsNone(result['summary']['beta'])

    def test_failed_refresh_retains_persistent_snapshot_then_retries_without_duplicate_updates(self):
        now = datetime(2026, 10, 26, 20, 16, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'PORTFOLIO_CACHE': str(Path(directory) / 'portfolio.json')}):
            cached = {**self.seed, 'seedFingerprint': self.fingerprint, 'lastSuccessfulAt': '2026-10-23T20:16:00Z'}
            p.cache_path().write_text(json.dumps(cached))
            original = p.cache_path().read_bytes()
            with patch.object(p, 'fetch_classification', return_value={}), patch.object(p, 'fetch_history', side_effect=ValueError('MSFT close missing')):
                self.assertFalse(p.refresh_if_due(now))
            self.assertEqual(p.cache_path().read_bytes(), original)
            self.assertEqual(p.get_portfolio(now)['refresh']['status'], 'error')
            histories = self.histories()
            with patch.object(p, 'fetch_classification', return_value={'sector': 'Technology', 'marketCap': 250e9}), patch.object(p, 'fetch_history', side_effect=lambda symbol, *args: histories[symbol]) as fetch:
                self.assertFalse(p.refresh_if_due(now + timedelta(minutes=1)))
                fetch.assert_not_called()
                self.assertTrue(p.refresh_if_due(now + timedelta(minutes=6)))
                count = fetch.call_count
                self.assertFalse(p.refresh_if_due(now + timedelta(minutes=7)))
                self.assertEqual(fetch.call_count, count)
            saved = p.get_portfolio(now + timedelta(minutes=7))
            self.assertEqual(saved['asOf'], '2026-10-26')
            self.assertEqual(saved['refresh']['status'], 'ready')
            self.assertEqual(saved['holdings'][0]['sector'], 'Technology')
            self.assertEqual(saved['holdings'][0]['marketCap'], 250e9)
            self.assertFalse(p.cache_path().with_suffix('.tmp').exists())

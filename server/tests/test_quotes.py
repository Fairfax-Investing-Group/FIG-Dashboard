from datetime import datetime, timezone
import unittest
from unittest.mock import patch

from server.quotes import normalize_quote, get_quote, _fetch_quote


class QuoteTests(unittest.TestCase):
    def profile(self):
        return {'currency': 'USD', 'regularMarketPrice': 100, 'regularMarketPreviousClose': 98,
                'regularMarketTime': 1792785600, 'postMarketPrice': 101.5, 'postMarketTime': 1792789200}

    def test_post_market_change_uses_the_same_sessions_regular_close(self):
        result = normalize_quote(self.profile())
        self.assertEqual(result['regular']['change'], 2)
        self.assertAlmostEqual(result['regular']['percent'], 2 / 98 * 100)
        self.assertEqual(result['postMarket']['change'], 1.5)
        self.assertEqual(result['postMarket']['percent'], 1.5)
        self.assertEqual(result['postMarket']['price'], 101.5)

    def test_previous_sessions_post_market_quote_is_omitted(self):
        profile = self.profile()
        profile['postMarketTime'] = profile['regularMarketTime'] - 1
        self.assertIsNone(normalize_quote(profile)['postMarket'])

    def test_trailing_pe_and_eps_are_extracted_without_inventing_negative_pe(self):
        result = normalize_quote({**self.profile(), 'trailingPE': 25, 'epsTrailingTwelveMonths': 4})
        self.assertEqual(result['trailingPE'], 25)
        self.assertEqual(result['trailingEPS'], 4)
        self.assertIsNone(normalize_quote({**self.profile(), 'trailingPE': -5})['trailingPE'])

    def test_missing_and_invalid_values_are_unavailable_not_zero(self):
        for fields in [{'postMarketPrice': None}, {'postMarketPrice': float('nan')}, {'postMarketPrice': 0},
                       {'postMarketTime': None}, {'regularMarketTime': None}, {'regularMarketPrice': None}]:
            with self.subTest(fields=fields):
                self.assertIsNone(normalize_quote({**self.profile(), **fields})['postMarket'])

    def test_unchanged_post_market_price_and_iso_timestamps(self):
        profile = self.profile()
        profile['postMarketPrice'] = 100
        profile['postMarketTime'] = datetime.fromtimestamp(profile['postMarketTime'], timezone.utc).isoformat()
        self.assertEqual(normalize_quote(profile)['postMarket']['change'], 0)
        self.assertEqual(normalize_quote(profile)['postMarket']['percent'], 0)

    @patch('server.yahoo_profile.time.monotonic', return_value=100)
    @patch('server.yahoo_profile.yf.Ticker')
    @patch('server.quotes.time.time', return_value=120)
    def test_quote_requests_are_cached_per_minute_and_share_class_symbols_are_mapped(self, clock, ticker, profile_clock):
        _fetch_quote.cache_clear()
        ticker.return_value.get_info.return_value = self.profile()
        get_quote('BRK.B')
        get_quote('BRK.B')
        ticker.assert_called_once_with('BRK-B')
        clock.return_value = 180
        profile_clock.return_value = 161
        get_quote('BRK.B')
        self.assertEqual(ticker.call_count, 2)
        _fetch_quote.cache_clear()

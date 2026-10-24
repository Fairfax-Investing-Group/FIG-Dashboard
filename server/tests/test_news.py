import unittest
from unittest.mock import patch

from server.news import normalize_news, get_news, _fetch_news


class NewsTests(unittest.TestCase):
    def article(self, title, date, url):
        return {'content': {'title': title, 'pubDate': date, 'canonicalUrl': {'url': url},
                            'provider': {'displayName': 'Publisher'}, 'summary': '<p>A &amp; B</p>'}}

    def test_news_is_normalized_deduplicated_and_sorted_newest_first(self):
        older = self.article('Older', '2026-10-22T22:00:00Z', 'https://example.com/older')
        newer = self.article('Newer', '2026-10-23T05:00:00+02:00', 'https://example.com/newer')
        newer['content']['thumbnail'] = {'resolutions': [{'url': 'https://example.com/large.jpg', 'width': 1200}, {'url': 'https://example.com/thumb.jpg', 'width': 320}]}
        articles = normalize_news([older, newer, older])
        self.assertEqual([article['title'] for article in articles], ['Newer', 'Older'])
        self.assertEqual(articles[0]['publishedAt'], '2026-10-23T03:00:00+00:00')
        self.assertEqual(articles[0]['summary'], 'A & B')
        self.assertEqual(articles[0]['publisher'], 'Publisher')
        self.assertEqual(articles[0]['thumbnail'], 'https://example.com/thumb.jpg')
        self.assertIsNone(articles[1]['thumbnail'])

    def test_missing_dates_unsafe_urls_and_ads_are_omitted_with_legacy_support(self):
        items = [None, {}, {'content': None}, self.article('Undated', None, 'https://example.com/a'),
                 self.article('Unsafe', '2026-10-23T00:00:00Z', 'javascript:alert(1)'),
                 {'ad': True, **self.article('Ad', '2026-10-23T00:00:00Z', 'https://example.com/ad')},
                 {'uuid': 'legacy', 'title': 'Legacy', 'providerPublishTime': 1792713600,
                  'publisher': 'Legacy publisher', 'link': 'https://example.com/legacy'}]
        articles = normalize_news(items)
        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]['id'], 'legacy')

    @patch('server.news.yf.Search')
    @patch('server.news.yf.Ticker')
    @patch('server.news.time.time', return_value=600)
    def test_requests_cache_for_five_minutes_and_map_share_class_symbols(self, clock, ticker, search):
        _fetch_news.cache_clear()
        self.addCleanup(_fetch_news.cache_clear)
        ticker.return_value.get_news.return_value = []
        search.return_value.news = []
        self.assertEqual(get_news('BRK.B')['articles'], [])
        get_news('BRK.B')
        ticker.assert_called_once_with('BRK-B')
        ticker.return_value.get_news.assert_called_once_with(count=25, tab='news')
        clock.return_value = 900
        get_news('BRK.B')
        self.assertEqual(ticker.call_count, 2)


    @patch('server.news.yf.Search')
    @patch('server.news.yf.Ticker')
    def test_empty_ticker_feed_uses_yfinance_search(self, ticker, search):
        _fetch_news.cache_clear()
        self.addCleanup(_fetch_news.cache_clear)
        ticker.return_value.get_news.return_value = []
        search.return_value.news = [{'title': 'Latest', 'providerPublishTime': 1792713600, 'link': 'https://example.com/latest'}]
        self.assertEqual(get_news('GOOGL')['articles'][0]['title'], 'Latest')
        search.assert_called_once_with('GOOGL', max_results=0, news_count=25)

    @patch('server.news.yf.Ticker')
    def test_load_more_requests_a_larger_feed_with_older_articles(self, ticker):
        _fetch_news.cache_clear()
        self.addCleanup(_fetch_news.cache_clear)
        items = [self.article(f'Article {i}', f'2026-10-{23 - i // 24:02d}T{23 - i % 24:02d}:00:00Z',
                              f'https://example.com/{i}') for i in range(60)]
        ticker.return_value.get_news.side_effect = lambda count, tab: items[:count]
        first = get_news('AAPL')
        second = get_news('AAPL', first['nextCount'])
        last = get_news('AAPL', second['nextCount'])
        self.assertEqual([len(page['articles']) for page in [first, second, last]], [25, 50, 60])
        self.assertLess(second['articles'][-1]['publishedAt'], first['articles'][-1]['publishedAt'])
        self.assertEqual(last['nextCount'], 100)
        self.assertEqual(ticker.return_value.get_news.call_args_list[-1].kwargs['count'], 75)

    @patch('server.news.yf.Ticker')
    def test_short_feed_does_not_prematurely_disable_load_more(self, ticker):
        _fetch_news.cache_clear()
        self.addCleanup(_fetch_news.cache_clear)
        ticker.return_value.get_news.return_value = [self.article('Article', '2026-10-23T00:00:00Z', 'https://example.com/1')]
        self.assertEqual(get_news('AAPL', 25)['nextCount'], 50)
        self.assertIsNone(get_news('AAPL', 250)['nextCount'])

    def test_invalid_counts_are_rejected(self):
        for count in [0, 26, 275]:
            with self.assertRaises(ValueError):
                get_news('AAPL', count)

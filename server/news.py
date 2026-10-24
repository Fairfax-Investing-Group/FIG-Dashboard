"""Recent company articles from Yahoo Finance through yfinance."""
from datetime import datetime, timezone
from functools import lru_cache
from html.parser import HTMLParser
from urllib.parse import urlparse
import time

import yfinance as yf

from server.quotes import quote_time


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def plain_text(value):
    if not isinstance(value, str):
        return ''
    parser = PlainText()
    parser.feed(value)
    return ' '.join(' '.join(parser.parts).split())


def article_url(value):
    if isinstance(value, dict):
        value = value.get('url')
    if not isinstance(value, str):
        return None
    try:
        parsed = urlparse(value)
        return value if parsed.scheme in ('https', 'http') and parsed.hostname and not parsed.username and not parsed.password else None
    except ValueError:
        return None


def thumbnail_url(content):
    thumbnail = content.get('thumbnail')
    if not isinstance(thumbnail, dict):
        return None
    resolutions = thumbnail.get('resolutions')
    candidates = [entry for entry in resolutions if isinstance(entry, dict) and article_url(entry) and isinstance(entry.get('width'), (int, float)) and entry['width'] > 0] if isinstance(resolutions, list) else []
    if candidates:
        return article_url(min(candidates, key=lambda entry: abs(entry['width'] - 320)))
    return article_url(thumbnail.get('originalUrl'))


def normalize_news(items):
    articles = []
    seen = set()
    for item in items:
        if not isinstance(item, dict) or item.get('ad'):
            continue
        content = item.get('content', item)
        if not isinstance(content, dict):
            continue
        title = plain_text(content.get('title'))
        published = quote_time(content.get('pubDate') or content.get('providerPublishTime'))
        url = next((url for url in (article_url(content.get(key)) for key in ('canonicalUrl', 'clickThroughUrl', 'link')) if url), None)
        if not title or not published or not url or url in seen:
            continue
        seen.add(url)
        provider = content.get('provider')
        publisher = provider.get('displayName') if isinstance(provider, dict) else content.get('publisher')
        articles.append({'id': str(content.get('id') or item.get('id') or item.get('uuid') or url),
                         'title': title, 'url': url, 'publisher': plain_text(publisher) or 'Yahoo Finance',
                         'thumbnail': thumbnail_url(content), 'publishedAt': published.isoformat(), 'summary': plain_text(content.get('summary') or content.get('description'))})
    return sorted(articles, key=lambda article: article['publishedAt'], reverse=True)


@lru_cache(maxsize=64)
def _fetch_news(symbol, interval, count=25):
    try:
        items = yf.Ticker(symbol).get_news(count=count, tab='news')
    except Exception:
        items = None
    if not items:
        items = yf.Search(symbol, max_results=0, news_count=count).news
    if not isinstance(items, list):
        raise ValueError('Unexpected news response.')
    return {'ticker': symbol, 'articles': normalize_news(items),
            # Yahoo can return fewer items than requested and still have older
            # coverage. The client stops when expanding adds no new articles.
            'nextCount': count + 25 if items and count < 250 else None,
            'retrievedAt': datetime.now(timezone.utc).isoformat()}


def get_news(ticker, count=25):
    if count not in range(25, 251, 25):
        raise ValueError('News count must be a multiple of 25 between 25 and 250.')
    return _fetch_news(ticker.replace('.', '-'), int(time.time() // 300), count)

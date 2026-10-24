"""Small, independently refreshed regular-session and after-hours quotes."""
from datetime import datetime, timezone
from functools import lru_cache
import time

from server.yahoo_profile import get_profile

from server.study_schema import finite


def quote_time(value):
    number = finite(value)
    try:
        if number is not None:
            return datetime.fromtimestamp(number, timezone.utc)
        if isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, OverflowError, OSError):
        pass
    return None


def normalize_quote(profile):
    regular_price = finite(profile.get('regularMarketPrice'))
    regular_time = quote_time(profile.get('regularMarketTime'))
    previous = finite(profile.get('regularMarketPreviousClose')) or finite(profile.get('previousClose'))
    change = regular_price - previous if regular_price is not None and previous and previous > 0 else finite(profile.get('regularMarketChange'))
    percent = change / previous * 100 if change is not None and previous and previous > 0 else finite(profile.get('regularMarketChangePercent'))
    regular = {'price': regular_price, 'change': change, 'percent': percent, 'time': regular_time.isoformat() if regular_time else None} if regular_price is not None and regular_price > 0 else None
    post_price = finite(profile.get('postMarketPrice'))
    post_time = quote_time(profile.get('postMarketTime'))
    post = None
    # A previous session's after-hours quote must not follow a newer regular quote.
    if regular and regular_time and post_price is not None and post_price > 0 and post_time and post_time >= regular_time:
        post_change = post_price - regular_price
        post = {'price': post_price, 'change': post_change, 'percent': post_change / regular_price * 100, 'time': post_time.isoformat()}
    trailing_pe = finite(profile.get('trailingPE'))
    return {'currency': profile.get('currency'), 'regular': regular, 'postMarket': post,
            'trailingPE': trailing_pe if trailing_pe is not None and trailing_pe > 0 else None,
            'trailingEPS': finite(profile.get('epsTrailingTwelveMonths')),
            'retrievedAt': datetime.now(timezone.utc).isoformat()}


@lru_cache(maxsize=64)
def _fetch_quote(symbol, minute):
    profile = get_profile(symbol)
    result = normalize_quote(profile)
    if not result['regular']:
        raise ValueError('No regular-session quote is available.')
    return result


def get_quote(ticker):
    return _fetch_quote(ticker.replace('.', '-'), int(time.time() // 60))

"""Weekly chart quotes and exact split events from one Yahoo chart response.

Using the raw chart response is deliberate: yfinance's weekly DataFrame groups
corporate actions into weekly buckets, losing the dates needed for EPS rebasing.
The existing yfinance transport handles Yahoo's session/cookie authentication.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from server.study_schema import finite


def weekly_observations(payload, start, history_start, today):
    chart = payload.get('chart') or {}
    results = chart.get('result')
    if chart.get('error') or not isinstance(results, list) or not results:
        raise ValueError('Yahoo Finance returned no weekly price history.')
    result = results[0]
    metadata = result.get('meta') or {}
    timezone_verified = True
    try:
        exchange_timezone = ZoneInfo(metadata['exchangeTimezoneName'])
    except (KeyError, TypeError, ValueError, ZoneInfoNotFoundError):
        exchange_timezone = timezone.utc
        timezone_verified = False
    def event_date(value):
        stamp = finite(value)
        if stamp is None:
            raise ValueError('Invalid price or split timestamp.')
        return datetime.fromtimestamp(stamp, exchange_timezone).date()
    timestamps = result.get('timestamp') or []
    quotes = (result.get('indicators') or {}).get('quote') or []
    closes = quotes[0].get('close', []) if quotes else []
    if len(timestamps) != len(closes):
        raise ValueError('Incomplete weekly price history.')
    prices = {}
    for stamp, close in zip(timestamps, closes):
        close = finite(close)
        if close is None or close <= 0:
            continue
        day = event_date(stamp)
        if not start <= day <= today:
            continue
        week = day - timedelta(days=day.weekday())
        # Yahoo may append the latest live quote for an already-present week.
        prices[week.isoformat()] = close
    if not prices:
        raise ValueError('Yahoo Finance returned no valid weekly closing prices.')
    splits = []
    events = result.get('events', {})
    split_events = events.get('splits', {}) if isinstance(events, dict) else None
    verified = timezone_verified and isinstance(split_events, dict)
    if isinstance(split_events, dict):
        for event in split_events.values():
            try:
                day = event_date(event['date'])
                numerator, denominator = finite(event.get('numerator')), finite(event.get('denominator'))
                if numerator is None or denominator is None or numerator <= 0 or denominator <= 0:
                    raise ValueError('Invalid split ratio.')
                ratio = numerator / denominator
                if finite(ratio) is None or ratio <= 0:
                    raise ValueError('Invalid split ratio.')
                if history_start <= day <= today:
                    splits.append({'date': day.isoformat(), 'ratio': ratio})
            except (KeyError, TypeError, ValueError, OverflowError, OSError):
                verified = False
    return {'prices': [{'date': day, 'close': close} for day, close in sorted(prices.items())],
            'priceHistory': [], 'splits': sorted(splits, key=lambda event: event['date']),
            'splitHistoryAvailable': verified, 'currency': metadata.get('currency')}


def fetch_weekly_prices(stock, start, history_start, today):
    params = {
        'period1': int(datetime.combine(history_start, datetime.min.time(), tzinfo=timezone.utc).timestamp()),
        'period2': int(datetime.combine(today + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp()),
        'interval': '1wk', 'events': 'splits', 'includeAdjustedClose': 'false',
    }
    payload = stock._data.get_raw_json(f'https://query2.finance.yahoo.com/v8/finance/chart/{stock.ticker}', params=params, timeout=20)
    return weekly_observations(payload, start, history_start, today)

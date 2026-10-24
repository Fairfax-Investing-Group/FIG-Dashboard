"""Persistent end-of-day portfolio updates; workbook transactions remain the source of truth."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from hashlib import sha256
import json
import logging
import math
import os
from pathlib import Path
import threading
from zoneinfo import ZoneInfo

import pandas_market_calendars as mcal
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / 'src/data/portfolio.json'
EASTERN = ZoneInfo('America/New_York')
UPDATE_DELAY = timedelta(minutes=15)
RETRY_DELAY = timedelta(minutes=5)
_LOCK = threading.Lock()
_REFRESH_LOCK = threading.Lock()
_ERROR = None
_RETRY_AT = None
_RUNNING = False
INDEX_SYMBOLS = {'NASDAQ': '^IXIC', 'S&P 500': '^GSPC', 'DOW JONES': '^DJI', 'RUSSEL 2000': '^RUT'}
BETA_METHOD = '1y-daily-adjusted-sp500-v1'


def cache_path():
    return Path(os.environ.get('PORTFOLIO_CACHE', str(ROOT / '.data/portfolio.json')))


@lru_cache(maxsize=4)
def session_schedule(year):
    return mcal.get_calendar('NYSE').schedule(start_date=f'{year - 1}-12-15', end_date=f'{year + 1}-01-15')


def refresh_window(now):
    """Most recent eligible trading session and the next scheduled update, in UTC."""
    local = now.astimezone(EASTERN)
    schedule = session_schedule(local.year)
    ready = [(index.date().isoformat(), row['market_close'].to_pydatetime() + UPDATE_DELAY) for index, row in schedule.iterrows()]
    previous = [session for session, due in ready if due <= now]
    upcoming = [due for _, due in ready if due > now]
    return previous[-1] if previous else None, upcoming[0] if upcoming else None


def load_seed():
    raw = SEED.read_bytes()
    return json.loads(raw), sha256(raw).hexdigest()


def read_cache(fingerprint):
    try:
        document = json.loads(cache_path().read_text())
        if document.get('seedFingerprint') == fingerprint:
            return document
    except (OSError, ValueError):
        pass
    return None


def fetch_history(symbol, start, session):
    ticker = yf.Ticker(symbol.replace('.', '-') if not symbol.startswith('^') else symbol)
    end = (datetime.fromisoformat(session) + timedelta(days=1)).date().isoformat()
    frame = ticker.history(start=start, end=end, interval='1d', auto_adjust=False, actions=True, timeout=20, raise_errors=True)
    if frame.empty:
        raise ValueError(f'{symbol}: no closing prices returned')
    metadata = ticker.history_metadata or {}
    if metadata.get('currency') != 'USD':
        raise ValueError(f'{symbol}: USD price currency could not be verified')
    records = []
    for index, row in frame.iterrows():
        day = index.date().isoformat()
        if day > session:
            continue
        close = float(row['Close'])
        if not math.isfinite(close) or close <= 0:
            continue
        def valid(column):
            value = float(row.get(column, float('nan')))
            return value if math.isfinite(value) else None
        records.append({'date': day, 'close': close, 'adjustedClose': valid('Adj Close'), 'high': valid('High'), 'low': valid('Low'), 'split': valid('Stock Splits') or 0})
    if len(records) < 2 or records[-1]['date'] != session:
        raise ValueError(f'{symbol}: closing price for {session} is not available yet')
    return records


def stock_beta(history, benchmark, session):
    """Trailing-year beta from matched adjusted closing returns; require 60 observations."""
    cutoff = (datetime.fromisoformat(session) - timedelta(days=365)).date().isoformat()
    def prices(records):
        return {point['date']: point['adjustedClose'] for point in records
                if cutoff <= point['date'] <= session and point.get('adjustedClose') is not None
                and math.isfinite(point['adjustedClose']) and point['adjustedClose'] > 0}
    stock, market = prices(history), prices(benchmark)
    dates = sorted(stock.keys() & market.keys())
    if len(dates) < 61:
        return None
    stock_returns = [stock[day] / stock[previous] - 1 for previous, day in zip(dates, dates[1:])]
    market_returns = [market[day] / market[previous] - 1 for previous, day in zip(dates, dates[1:])]
    stock_mean = sum(stock_returns) / len(stock_returns)
    market_mean = sum(market_returns) / len(market_returns)
    variance = sum((value - market_mean) ** 2 for value in market_returns)
    if variance <= 1e-20:
        return None
    beta = sum((stock - stock_mean) * (market - market_mean) for stock, market in zip(stock_returns, market_returns)) / variance
    return beta if math.isfinite(beta) else None


def fetch_classification(symbol):
    """Classification failure should not prevent the daily price update."""
    try:
        profile = yf.Ticker(symbol.replace('.', '-')).get_info() or {}
        cap = profile.get('marketCap')
        return {'sector': profile.get('sector') or None,
                'marketCap': cap if isinstance(cap, (int, float)) and math.isfinite(cap) and cap > 0 else None}
    except Exception:
        logging.warning('Portfolio classification unavailable for %s', symbol)
        return {}


def calculate_portfolio(seed, histories, session):
    """Revalue fixed transactions using completed sessions, never intraday/after-hours quotes."""
    result = deepcopy(seed)
    cutoff = (datetime.fromisoformat(session) - timedelta(days=90)).date().isoformat()
    annual_cutoff = (datetime.fromisoformat(session) - timedelta(days=365)).date().isoformat()
    def split_factor(symbol):
        return math.prod(point['split'] for point in histories[symbol] if seed['asOf'] < point['date'] <= session and point['split'] > 0)
    def spark(symbol):
        return [{'date': point['date'], 'value': point['close']} for point in histories[symbol] if point['date'] >= cutoff]
    def day_change(symbol):
        records = histories[symbol]
        return records[-1]['close'] / records[-2]['close'] - 1
    for holding in result['holdings']:
        symbol = holding['ticker']
        history = histories[symbol]
        factor = split_factor(symbol)
        holding['shares'] *= factor
        holding['averageCost'] /= factor
        holding['price'] = history[-1]['close']
        holding['marketValue'] = holding['price'] * holding['shares']
        holding['gain'] = holding['marketValue'] - holding['cost']
        holding['return'] = holding['gain'] / holding['cost'] if holding['cost'] else None
        holding['dayChange'] = day_change(symbol)
        annual = [point for point in history if point['date'] >= annual_cutoff]
        holding['high52'] = max(point['high'] for point in annual if point['high'] is not None)
        holding['low52'] = min(point['low'] for point in annual if point['low'] is not None)
        holding['history'] = spark(symbol)
        holding['beta'] = stock_beta(history, histories['^GSPC'], session)
    summary = result['summary']
    summary['totalCost'] = sum(item['cost'] for item in result['holdings'])
    summary['holdingsValue'] = sum(item['marketValue'] for item in result['holdings'])
    summary['portfolioValue'] = summary['holdingsValue'] + summary['cash']
    summary['beta'] = (sum(item['marketValue'] * item['beta'] for item in result['holdings']) / summary['portfolioValue']
                       if summary['portfolioValue'] > 0 and all(item['beta'] is not None for item in result['holdings']) else None)
    result['betaMethod'] = BETA_METHOD
    summary['gain'] = summary['holdingsValue'] - summary['totalCost']
    summary['portfolioReturn'] = summary['gain'] / summary['totalCost']
    base_index = next(item['price'] for item in seed['indexes'] if item['name'] == 'S&P 500')
    def benchmark_return(close):
        return (1 + seed['summary']['benchmarkReturn']) * close / base_index - 1
    summary['benchmarkReturn'] = benchmark_return(histories['^GSPC'][-1]['close'])
    summary['relativeReturn'] = summary['portfolioReturn'] - summary['benchmarkReturn']
    for holding in result['holdings']:
        holding['weight'] = holding['marketValue'] / summary['holdingsValue']
    for partner in result['partners']:
        for pitch in partner['pitches']:
            factor = split_factor(pitch['ticker'])
            pitch['shares'] *= factor
            pitch['pitchPrice'] /= factor
            pitch['price'] = histories[pitch['ticker']][-1]['close']
            pitch['marketValue'] = pitch['price'] * pitch['shares']
            pitch['gain'] = pitch['marketValue'] - pitch['cost']
            pitch['return'] = pitch['gain'] / pitch['cost']
        partner['return'] = sum(pitch['gain'] for pitch in partner['pitches']) / sum(pitch['cost'] for pitch in partner['pitches'])
    for pulse in result['marketPulse']:
        pulse['dayChange'] = day_change(pulse['ticker'])
        pulse['history'] = spark(pulse['ticker'])
    for index in result['indexes']:
        symbol = INDEX_SYMBOLS[index['name']]
        index['price'] = histories[symbol][-1]['close']
        index['history'] = spark(symbol)
    # Preserve the supplied historical record, and backfill every missed session
    # after the imported snapshot using the same fixed holdings and cost basis.
    result['performance'] = [point for point in seed['performance'] if point['date'] < seed['asOf']]
    closes = {symbol: {point['date']: point['close'] for point in history} for symbol, history in histories.items()}
    for point in histories['^GSPC']:
        day = point['date']
        if not seed['asOf'] <= day <= session:
            continue
        if not all(day in closes[item['ticker']] for item in result['holdings']):
            raise ValueError(f'Incomplete portfolio closing prices for {day}')
        value = sum(closes[item['ticker']][day] * item['shares'] for item in result['holdings'])
        result['performance'].append({'date': day, 'club': (value - summary['totalCost']) / summary['totalCost'], 'benchmark': benchmark_return(point['close'])})
    result['asOf'] = session
    result['updatedLabel'] = f'{datetime.fromisoformat(session).strftime("%b %d, %Y")} close'
    result['priceSource'] = 'Yahoo Finance closing prices'
    return result


def refresh_if_due(now=None):
    global _ERROR, _RETRY_AT, _RUNNING
    now = now or datetime.now(timezone.utc)
    session, _ = refresh_window(now)
    seed, fingerprint = load_seed()
    if not session or session < seed['asOf']:
        return False
    cached = read_cache(fingerprint)
    if cached and cached['asOf'] >= session and cached.get('betaMethod') == BETA_METHOD and cached.get('classificationVersion') == 1:
        return False
    if _RETRY_AT and now < _RETRY_AT:
        return False
    if not _REFRESH_LOCK.acquire(blocking=False):
        return False
    with _LOCK:
        _RUNNING = True
    try:
        symbols = {item['ticker'] for item in seed['holdings']} | {pitch['ticker'] for partner in seed['partners'] for pitch in partner['pitches']} | {item['ticker'] for item in seed['marketPulse']} | set(INDEX_SYMBOLS.values())
        start = min(seed['asOf'], (datetime.fromisoformat(session) - timedelta(days=375)).date().isoformat())
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {symbol: pool.submit(fetch_history, symbol, start, session) for symbol in sorted(symbols)}
            profiles = {item['ticker']: pool.submit(fetch_classification, item['ticker']) for item in seed['holdings']}
            histories = {symbol: future.result() for symbol, future in futures.items()}
            classifications = {symbol: future.result() for symbol, future in profiles.items()}
        document = calculate_portfolio(seed, histories, session)
        previous = {item['ticker']: item for item in (cached or seed)['holdings']}
        for holding in document['holdings']:
            profile = classifications[holding['ticker']]
            for key in ('sector', 'marketCap'):
                holding[key] = profile.get(key) or previous.get(holding['ticker'], {}).get(key)
        document['classificationVersion'] = 1
        document['seedFingerprint'] = fingerprint
        document['lastSuccessfulAt'] = datetime.now(timezone.utc).isoformat()
        path = cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(document, allow_nan=False))
        temporary.replace(path)
        with _LOCK:
            _ERROR, _RETRY_AT = None, None
        logging.info('Portfolio updated through %s', session)
        return True
    except Exception as error:
        with _LOCK:
            _ERROR = str(error)
            _RETRY_AT = now + RETRY_DELAY
        logging.warning('Portfolio close update deferred: %s', error)
        return False
    finally:
        with _LOCK:
            _RUNNING = False
        _REFRESH_LOCK.release()


def get_portfolio(now=None):
    now = now or datetime.now(timezone.utc)
    seed, fingerprint = load_seed()
    document = read_cache(fingerprint) or seed
    _, next_refresh = refresh_window(now)
    with _LOCK:
        document['refresh'] = {'status': 'updating' if _RUNNING else 'error' if _ERROR else 'ready' if 'lastSuccessfulAt' in document else 'pending',
                               'error': _ERROR, 'retryAt': _RETRY_AT.isoformat() if _RETRY_AT else None,
                               'nextRefreshAt': next_refresh.isoformat() if next_refresh else None}
    return document


def start_portfolio_scheduler():
    stop = threading.Event()
    def run():
        while not stop.is_set():
            try:
                refresh_if_due()
            except Exception:
                logging.exception('Portfolio scheduler failed; will retry')
            stop.wait(60)
    threading.Thread(target=run, name='portfolio-close-updater', daemon=True).start()
    return stop

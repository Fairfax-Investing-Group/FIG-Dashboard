from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import json
import math
import os
import sqlite3
import threading
import time
import uuid

import requests
import yfinance as yf

from server.financials import normalize_financials
from server.eps import normalize_eps
from server.study_schema import normalize_study

ROOT = Path(__file__).resolve().parents[1]
SEC_LOCK = threading.Lock()
LAST_SEC_REQUEST = 0.0
DB_LOCK = threading.Lock()


def database_path():
    path = Path(os.environ.get('STUDY_DB', str(ROOT / '.data' / 'studies.sqlite3')))
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def connection():
    db = sqlite3.connect(database_path(), timeout=10)
    try:
        db.execute('CREATE TABLE IF NOT EXISTS studies (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
        with db:
            yield db
    finally:
        db.close()


def save_study(study):
    study = normalize_study(study)
    with DB_LOCK, connection() as db:
        db.execute('INSERT INTO studies (id, payload) VALUES (?, ?)', (study['Study']['StudyID'], json.dumps(study, allow_nan=False)))


def get_study(study_id):
    with DB_LOCK, connection() as db:
        row = db.execute('SELECT payload FROM studies WHERE id = ?', (study_id,)).fetchone()
    if not row:
        return None
    study = json.loads(row[0])
    return normalize_study(study if study.get('SchemaVersion') == 1 else normalized_only(study))


def normalized_only(study):
    """Enforce the same EPS policy for new and legacy snapshots."""
    normalized = (study.get('epsAdjustment') or {}).get('status') == 'normalized'
    hidden = False
    annual = []
    for row in study['annual']:
        factor = row.get('epsSplitFactor')
        verified = normalized and isinstance(factor, (int, float)) and math.isfinite(factor) and factor > 0
        if not verified:
            hidden = hidden or row.get('eps') is not None or row.get('epsReported') is not None
            row = {**row, 'eps': None, 'epsSplitFactor': None}
        annual.append(row)
    study['annual'] = annual
    study['warnings'] = [warning for warning in study['warnings'] if 'EPS remains as reported' not in warning]
    if hidden:
        warning = 'Split-normalized EPS is unavailable for some periods. Refresh to retry; unverified EPS is hidden.'
        if warning not in study['warnings']:
            study['warnings'].append(warning)
    return study


def company_for(ticker, cik):
    directory = json.loads((ROOT / 'public' / 'companies.json').read_text())
    for company_cik, name, symbol, exchange in directory['data']:
        if symbol == ticker and company_cik == cik:
            return {'cik': cik, 'name': name, 'ticker': ticker, 'exchange': exchange}
    raise ValueError('Select a company from the search results.')


def fetch_financials(cik):
    global LAST_SEC_REQUEST
    # Limit SEC traffic across concurrent creations. No cache: every new study requests SEC.
    with SEC_LOCK:
        delay = 0.25 - (time.monotonic() - LAST_SEC_REQUEST)
        if delay > 0:
            time.sleep(delay)
        LAST_SEC_REQUEST = time.monotonic()
    url = f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json'
    response = requests.get(url, headers={
        'User-Agent': os.environ.get('SEC_USER_AGENT', 'StockStudy/1.0 (local company research application)'),
        'Accept-Encoding': 'gzip, deflate',
        'Accept': 'application/json',
    }, timeout=(8, 25))
    response.raise_for_status()
    normalized = normalize_financials(response.json())
    return {**normalized, 'url': url, 'retrievedAt': datetime.now(timezone.utc).isoformat()}


def fetch_prices(ticker):
    # Yahoo uses a hyphen for share classes, e.g. BRK.B -> BRK-B.
    symbol = ticker.replace('.', '-')
    end = date.today() + timedelta(days=1)
    today = date.today()
    try:
        start = today.replace(year=today.year - 10)
    except ValueError:  # Leap day.
        start = today.replace(year=today.year - 10, day=28)
    stock = yf.Ticker(symbol)
    # Include the start of the oldest financial year, even when before the price chart window.
    history_start = min(start, date(today.year - 10, 1, 1))
    history = stock.history(start=history_start.isoformat(), end=end.isoformat(), interval='1d', auto_adjust=False, actions=True, timeout=20, raise_errors=True)
    if history.empty:
        raise ValueError('No stock price history is available for this Yahoo Finance symbol.')
    metadata = stock.history_metadata or {}
    prices, splits = [], []
    split_history_available = 'Stock Splits' in history.columns
    for index, row in history.iterrows():
        close = float(row['Close'])
        if math.isfinite(close) and start <= index.date() <= today:
            prices.append({'date': index.date().isoformat(), 'close': close})
        ratio = float(row.get('Stock Splits', 0))
        if ratio != 0:
            if not math.isfinite(ratio) or ratio <= 0:
                split_history_available = False
            else:
                splits.append({'date': index.date().isoformat(), 'ratio': ratio})
    if not prices:
        raise ValueError('Yahoo Finance returned no valid closing prices.')
    return {
        'prices': prices, 'currency': metadata.get('currency'), 'symbol': symbol,
        'start': start.isoformat(), 'end': today.isoformat(),
        'splits': splits, 'splitHistoryAvailable': split_history_available,
        'splitHistoryStart': history_start.isoformat(),
        'url': f'https://finance.yahoo.com/quote/{symbol}/history/',
        'retrievedAt': datetime.now(timezone.utc).isoformat(),
    }


def source_error(source, error):
    if isinstance(error, requests.HTTPError):
        status = error.response.status_code
        if status == 404:
            return f'{source} has no company facts for this issuer.'
        if status in (403, 429):
            return f'{source} temporarily blocked or rate-limited the request (HTTP {status}). Try refreshing later.'
        return f'{source} returned HTTP {status}. Try refreshing later.'
    if isinstance(error, requests.Timeout):
        return f'{source} timed out. Try refreshing later.'
    if isinstance(error, ValueError):
        return str(error)
    return f'{source} could not be reached or returned an invalid response. Try refreshing later.'


def create_study(company):
    # Start both upstream requests as soon as the study is created.
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {
            'sec': executor.submit(fetch_financials, company['cik']),
            'yfinance': executor.submit(fetch_prices, company['ticker']),
        }
        results, errors = {}, {}
        for source, future in futures.items():
            try:
                results[source] = future.result()
            except Exception as error:
                errors[source] = source_error('SEC' if source == 'sec' else 'Yahoo Finance', error)
    sec, prices = results.get('sec'), results.get('yfinance')
    study = {
        'id': str(uuid.uuid4()), 'company': company,
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'financialCurrency': sec['currency'] if sec else None,
        'annual': sec['annual'] if sec else [],
        'prices': prices['prices'] if prices else [],
        'priceCurrency': prices['currency'] if prices else None,
        'warnings': sec['warnings'] if sec else [],
        'sources': {
            'sec': {'status': 'ok' if sec else 'error', 'url': f"https://data.sec.gov/api/xbrl/companyfacts/CIK{company['cik']:010d}.json", 'retrievedAt': sec['retrievedAt'] if sec else None, 'error': errors.get('sec')},
            'yfinance': {'status': 'ok' if prices else 'error', 'url': f"https://finance.yahoo.com/quote/{company['ticker'].replace('.', '-')}/history/", 'retrievedAt': prices['retrievedAt'] if prices else None, 'error': errors.get('yfinance')},
        },
    }
    if sec and prices and prices.get('splitHistoryAvailable'):
        try:
            study['annual'] = normalize_eps(study['annual'], prices['splits'], prices['end'], prices['splitHistoryStart'])
            study['epsAdjustment'] = {
                'status': 'normalized', 'asOf': prices['end'],
                'method': 'splits-after-source-filing', 'events': prices['splits'],
                'historyStart': prices['splitHistoryStart'],
            }
        except (ValueError, TypeError, KeyError, OverflowError, ZeroDivisionError):
            study['epsAdjustment'] = {'status': 'unavailable'}
            study['warnings'].append('Split normalization failed. EPS is unavailable; refresh to retry.')
    else:
        study['epsAdjustment'] = {'status': 'unavailable'}
        if sec and any(row.get('eps') is not None for row in study['annual']):
            study['warnings'].append('Split history is unavailable. EPS is unavailable; refresh to retry normalization.')
    if prices and (date.fromisoformat(prices['prices'][0]['date']) - date.fromisoformat(prices['start'])).days > 45:
        study['warnings'].append('Yahoo Finance has less than ten years of price history for this symbol.')
    normalized_only(study)
    study = normalize_study(study)
    save_study(study)
    return study

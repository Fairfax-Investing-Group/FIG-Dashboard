from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
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
from server.fundamentals import extract_statements, adjust_statement
from server.market import fetch_market, fallback_financials
from server.weekly_prices import fetch_weekly_prices

ROOT = Path(__file__).resolve().parents[1]
SEC_LOCK = threading.Lock()
LAST_SEC_REQUEST = 0.0
DB_LOCK = threading.Lock()
ENRICHMENT_LOCKS = {}


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


def save_study(study, inputs=None):
    study = normalize_study(study)
    with DB_LOCK, connection() as db:
        db.execute('INSERT INTO studies (id, payload) VALUES (?, ?)', (study['Study']['StudyID'], json.dumps(study, allow_nan=False)))
        if inputs is not None:
            db.execute('CREATE TABLE IF NOT EXISTS study_inputs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            db.execute('INSERT INTO study_inputs (id, payload) VALUES (?, ?)', (study['Study']['StudyID'], json.dumps(inputs, allow_nan=False)))


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


def sec_json(url):
    global LAST_SEC_REQUEST
    # Limit SEC traffic across concurrent creations. No cache: every new study requests SEC.
    with SEC_LOCK:
        delay = 0.25 - (time.monotonic() - LAST_SEC_REQUEST)
        if delay > 0:
            time.sleep(delay)
        LAST_SEC_REQUEST = time.monotonic()
    response = requests.get(url, headers={
        'User-Agent': os.environ.get('SEC_USER_AGENT', 'StockStudy/1.0 (local company research application)'),
        'Accept-Encoding': 'gzip, deflate',
        'Accept': 'application/json',
    }, timeout=(8, 25))
    response.raise_for_status()
    return response.json()


def fetch_financials(cik):
    url = f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json'
    # These documents are independent; sec_json still applies the shared SEC
    # request-rate limit while downloads overlap.
    with ThreadPoolExecutor(max_workers=2) as executor:
        facts = executor.submit(sec_json, url)
        submissions = executor.submit(sec_json, f'https://data.sec.gov/submissions/CIK{cik:010d}.json')
        payload = facts.result()
        normalized = normalize_financials(payload)
        try:
            normalized['submissions'] = submissions.result()
        except Exception:
            normalized['submissions'] = {}
            normalized['warnings'].append('SEC company metadata could not be loaded; financial statements are preserved.')
    normalized['statements'] = extract_statements(payload, normalized['currency'], normalized['annual'], submissions=normalized['submissions'])
    return {**normalized, 'url': url, 'retrievedAt': datetime.now(timezone.utc).isoformat()}


def price_observations(history, start, today):
    """Read column arrays directly; avoid building a pandas Series per day."""
    if history.empty:
        raise ValueError('No stock price history is available for this Yahoo Finance symbol.')
    prices, splits, price_history = [], [], []
    split_history_available = 'Stock Splits' in history.columns
    columns = [history[column].to_numpy() if column in history.columns else [default] * len(history)
               for column, default in [('Close', float('nan')), ('Open', float('nan')), ('High', float('nan')),
                                       ('Low', float('nan')), ('Volume', float('nan')), ('Stock Splits', 0)]]
    for index, close, opening, high, low, volume, ratio in zip(history.index, *columns):
        day = index.date()
        close = float(close)
        if math.isfinite(close) and start <= day <= today:
            prices.append({'date': day.isoformat(), 'close': close})
        if math.isfinite(close):
            point = {'date': day.isoformat(), 'close': close}
            for field, value in [('open', opening), ('high', high), ('low', low), ('volume', volume)]:
                value = float(value)
                point[field] = value if math.isfinite(value) else None
            price_history.append(point)
        ratio = float(ratio)
        if ratio != 0:
            if not math.isfinite(ratio) or ratio <= 0:
                split_history_available = False
            else:
                splits.append({'date': day.isoformat(), 'ratio': ratio})
    if not prices:
        raise ValueError('Yahoo Finance returned no valid closing prices.')
    return {'prices': prices, 'priceHistory': price_history, 'splits': splits, 'splitHistoryAvailable': split_history_available}


def fetch_prices(ticker, include_peers=True, fundamentals_only=False, profile=None):
    symbol = ticker.replace('.', '-')
    today = date.today()
    end = today + timedelta(days=1)
    try:
        start = today.replace(year=today.year - 10)
    except ValueError:
        start = today.replace(year=today.year - 10, day=28)
    history_start = min(start, date(today.year - 10, 1, 1))
    stock = yf.Ticker(symbol)
    # Separate instances keep yfinance's mutable per-ticker caches independent.
    with ThreadPoolExecutor(max_workers=2) as executor:
        history = (executor.submit(fetch_weekly_prices, stock, start, history_start, today) if fundamentals_only else
                   executor.submit(stock.history, start=history_start.isoformat(), end=end.isoformat(), interval='1d', auto_adjust=False, actions=True, timeout=20, raise_errors=True))
        market = executor.submit(fetch_market, yf.Ticker(symbol), include_peers=include_peers, fundamentals_only=fundamentals_only, profile=profile)
        if fundamentals_only:
            observations = history.result()
            metadata = {'currency': observations['currency']}
        else:
            observations = price_observations(history.result(), start, today)
            metadata = stock.history_metadata or {}
        market = market.result()
    return {
        **observations, 'currency': metadata.get('currency'), 'symbol': symbol, 'market': market,
        'interval': '1wk' if fundamentals_only else '1d',
        'start': start.isoformat(), 'end': today.isoformat(),
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


def prepare_financials(study, prices):
    """Apply verified split normalization to original, unadjusted statements."""
    if study['sources']['sec']['status'] == 'ok' and prices and prices.get('splitHistoryAvailable'):
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
        if study['sources']['sec']['status'] == 'ok' and any(row.get('eps') is not None for row in study['annual']):
            study['warnings'].append('Split history is unavailable. EPS is unavailable; refresh to retry normalization.')
    if prices and (date.fromisoformat(prices['prices'][0]['date']) - date.fromisoformat(prices['start'])).days > 45:
        study['warnings'].append('Yahoo Finance has less than ten years of price history for this symbol.')
    verified_splits = prices['splits'] if prices and prices.get('splitHistoryAvailable') else None
    for key in ('annual', 'quarterly'):
        statements = study['statements'].get(key, {} if key == 'annual' else [])
        if isinstance(statements, dict):
            study['statements'][key] = {end: adjust_statement(row, verified_splits, prices['end'] if prices else None, prices.get('splitHistoryStart') if prices else None) for end, row in statements.items()}
        else:
            study['statements'][key] = [adjust_statement(row, verified_splits, prices['end'] if prices else None, prices.get('splitHistoryStart') if prices else None) for row in statements]
    normalized_only(study)


def create_study(company, include_peers=True, persist=True, fundamentals_only=False, study_id=None):
    if study_id is None or not persist:
        return build_study(company, include_peers, persist, fundamentals_only, study_id)
    # A client-generated ID keeps the initial page and its editable forecasts
    # attached to the same study. Retrying that creation must not duplicate it.
    with DB_LOCK:
        lock = ENRICHMENT_LOCKS.setdefault(study_id, threading.Lock())
    with lock:
        saved = get_study(study_id)
        if saved:
            if int(saved['Company']['CentralIndexKey']) != company['cik'] or saved['Company']['Ticker'] != company['ticker']:
                raise ValueError('Study ID belongs to a different company.')
            return saved
        return build_study(company, include_peers, persist, fundamentals_only, study_id)


def build_study(company, include_peers, persist, fundamentals_only, study_id=None):
    # Start both upstream requests as soon as the study is created.
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {
            'sec': executor.submit(fetch_financials, company['cik']),
            'yfinance': executor.submit(fetch_prices, company['ticker'], include_peers=include_peers, fundamentals_only=fundamentals_only),
        }
        results, errors = {}, {}
        for source, future in futures.items():
            try:
                results[source] = future.result()
            except Exception as error:
                errors[source] = source_error('SEC' if source == 'sec' else 'Yahoo Finance', error)
    sec, prices = results.get('sec'), results.get('yfinance')
    financials = sec if sec and sec.get('annual') else fallback_financials(prices.get('market', {})) if prices else sec
    financials = financials or sec
    study = {
        'id': study_id or str(uuid.uuid4()), 'company': company,
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'financialCurrency': financials['currency'] if financials else None,
        'annual': financials['annual'] if financials else [],
        'prices': prices['prices'] if prices else [],
        'priceInterval': prices.get('interval', '1d') if prices else '1wk' if fundamentals_only else '1d',
        'priceCurrency': prices['currency'] if prices else None,
        'warnings': list(financials['warnings']) if financials else [],
        'statements': financials.get('statements', {}) if financials else {},
        'submissions': sec.get('submissions', {}) if sec else {},
        'priceHistory': prices.get('priceHistory', []) if prices else [],
        'market': prices.get('market', {}) if prices else {},
        'sources': {
            'sec': {'status': 'ok' if sec else 'error', 'url': f"https://data.sec.gov/api/xbrl/companyfacts/CIK{company['cik']:010d}.json", 'retrievedAt': sec['retrievedAt'] if sec else None, 'error': errors.get('sec')},
            'yfinance': {'status': 'ok' if prices else 'error', 'url': f"https://finance.yahoo.com/quote/{company['ticker'].replace('.', '-')}/history/", 'retrievedAt': prices['retrievedAt'] if prices else None, 'error': errors.get('yfinance')},
        },
    }
    if fundamentals_only:
        study['_originalFinancials'] = deepcopy({key: study[key] for key in ('annual', 'statements', 'warnings')})
    prepare_financials(study, prices)
    inputs = study
    study = normalize_study(inputs)
    study['Metadata']['DataStage'] = 'fundamentals' if fundamentals_only else 'complete'
    if include_peers and not fundamentals_only:
        from server.peers import add_peers
        add_peers(study, prices.get('market', {}).get('peerSymbols', []) if prices else [])
    if persist:
        save_study(study, inputs=inputs if fundamentals_only else None)
    return study


def complete_study(study_id):
    """Resume the saved SEC inputs; replace the weekly chart with daily prices.

    Per-study locking makes concurrent retries share the persisted completion.
    Failed completions leave both the usable snapshot and its inputs intact.
    """
    with DB_LOCK:
        lock = ENRICHMENT_LOCKS.setdefault(study_id, threading.Lock())
    with lock:
        saved = get_study(study_id)
        if saved is None:
            raise LookupError('Study not found.')
        if saved['Metadata'].get('DataStage') != 'fundamentals':
            return saved
        with DB_LOCK, connection() as db:
            row = db.execute('SELECT payload FROM study_inputs WHERE id = ?', (study_id,)).fetchone()
        if not row:
            raise ValueError('Study inputs are unavailable. Refresh the study to retry.')
        inputs = json.loads(row[0])
        symbol = inputs['company']['ticker'].replace('.', '-')
        profile = inputs.get('market', {}).get('profile') or None
        daily = None
        if inputs.get('priceInterval') == '1wk':
            if '_originalFinancials' not in inputs:
                raise ValueError('Original statements are unavailable. Refresh the study to retry.')
            daily = fetch_prices(inputs['company']['ticker'], profile=profile)
            market = daily['market']
            inputs.update(deepcopy(inputs['_originalFinancials']))
            inputs.update({'prices': daily['prices'], 'priceHistory': daily['priceHistory'],
                           'priceCurrency': daily['currency'], 'priceInterval': '1d'})
            inputs['sources']['yfinance'] = {'status': 'ok', 'url': daily['url'], 'retrievedAt': daily['retrievedAt'], 'error': None}
        else:
            # Compatibility with partial studies saved before weekly loading.
            market = fetch_market(yf.Ticker(symbol), profile=profile)
        inputs['market'] = market
        inputs['warnings'].extend(market.get('warnings', []))
        # If SEC had no usable annuals, the deferred Yahoo statements can supply
        # them now. Per-share data still passes the existing split verification.
        if not inputs['annual']:
            fallback = fallback_financials(market)
            if fallback:
                inputs.update({'annual': fallback['annual'], 'financialCurrency': fallback['currency'], 'statements': fallback['statements']})
                inputs['warnings'].extend(fallback['warnings'])
        if daily is not None:
            prepare_financials(inputs, daily)
        completed = normalize_study(inputs)
        from server.peers import add_peers
        add_peers(completed, market.get('peerSymbols', []))
        completed['Metadata']['DataStage'] = 'complete'
        completed['Study']['DateModified'] = datetime.now(timezone.utc).isoformat()
        with DB_LOCK, connection() as db:
            db.execute('UPDATE studies SET payload = ? WHERE id = ?', (json.dumps(completed, allow_nan=False), study_id))
            db.execute('DELETE FROM study_inputs WHERE id = ?', (study_id,))
        return completed

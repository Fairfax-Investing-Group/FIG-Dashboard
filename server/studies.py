from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed, CancelledError
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
import weakref

import requests
import yfinance as yf

from server.financials import normalize_financials
from server.eps import normalize_eps
from server.study_schema import normalize_study
from server.fundamentals import extract_statements, adjust_statement, DURATION, INSTANT
from server.market import fetch_market, fallback_financials
from server.weekly_prices import fetch_weekly_prices
from server.yahoo_profile import get_profile
from server.company_directory import company_for
from server.sec_transport import get_json as sec_get_json

ROOT = Path(__file__).resolve().parents[1]
SEC_LOCK = threading.Lock()
LAST_SEC_REQUEST = 0.0
DB_LOCK = threading.Lock()
ENRICHMENT_LOCKS = weakref.WeakValueDictionary()


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
    if study.get('SchemaVersion') != 1:
        study = normalize_study(study)
    payload = json.dumps(study, allow_nan=False, separators=(',', ':'))
    checkpoint = json.dumps(inputs, allow_nan=False, separators=(',', ':')) if inputs is not None else None
    with DB_LOCK, connection() as db:
        db.execute('INSERT INTO studies (id, payload) VALUES (?, ?)', (study['Study']['StudyID'], payload))
        if inputs is not None:
            db.execute('CREATE TABLE IF NOT EXISTS study_inputs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            db.execute('INSERT INTO study_inputs (id, payload) VALUES (?, ?)', (study['Study']['StudyID'], checkpoint))


def get_study(study_id):
    with DB_LOCK, connection() as db:
        row = db.execute('SELECT payload FROM studies WHERE id = ?', (study_id,)).fetchone()
    if not row:
        return None
    study = json.loads(row[0])
    return study if study.get('SchemaVersion') == 1 else normalize_study(normalized_only(study))


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


def check_cancelled(cancelled):
    if cancelled is not None and cancelled.is_set():
        raise CancelledError('Preload discarded.')


def sec_json(url, cancelled=None):
    global LAST_SEC_REQUEST
    # Limit SEC traffic across concurrent creations. No cache: every new study requests SEC.
    with SEC_LOCK:
        check_cancelled(cancelled)
        delay = 0.25 - (time.monotonic() - LAST_SEC_REQUEST)
        if delay > 0:
            time.sleep(delay)
        check_cancelled(cancelled)
        LAST_SEC_REQUEST = time.monotonic()
    return sec_get_json(url, headers={
        'User-Agent': os.environ.get('SEC_USER_AGENT', 'StockStudy/1.0 (local company research application)'),
        'Accept-Encoding': 'gzip, deflate',
        'Accept': 'application/json',
    }, timeout=(8, 25), **({'cancelled': cancelled} if cancelled is not None else {}))


def compact_sec_payload(payload, currency):
    """Keep all concepts needed for full extraction, without unrelated SEC facts.

    One additional year preserves beginning balances and comparative/YTD inputs.
    Provenance and full fact records remain intact for retained observations.
    """
    if not payload.get('facts') or not currency:
        return payload
    cutoff = str(date(date.today().year - 10, 1, 1) - timedelta(days=380))
    units = {currency, f'{currency}/shares', 'shares'}
    needed = {pair for concepts in (*DURATION.values(), *INSTANT.values()) for pair in concepts}
    facts = {}
    for taxonomy, concept in needed:
        entry = payload.get('facts', {}).get(taxonomy, {}).get(concept)
        if not entry:
            continue
        retained = {unit: [fact for fact in values if str(fact.get('end', '')) >= cutoff]
                    for unit, values in entry.get('units', {}).items() if unit in units}
        facts.setdefault(taxonomy, {})[concept] = {'units': retained}
    return {'facts': facts}


def fetch_financials(cik, fundamentals_only=False, cancelled=None):
    url = f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json'
    if fundamentals_only:
        check_cancelled(cancelled)
        payload = sec_json(url, **({'cancelled': cancelled} if cancelled is not None else {}))
        check_cancelled(cancelled)
        normalized = normalize_financials(payload)
        normalized['statements'] = extract_statements(payload, normalized['currency'], normalized['annual'], fundamentals_only=True)
        return {**normalized, '_secPayload': compact_sec_payload(payload, normalized['currency']), 'url': url, 'retrievedAt': datetime.now(timezone.utc).isoformat()}
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


def fetch_prices(ticker, include_peers=True, fundamentals_only=False, profile=None, on_history=None):
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
        if on_history:
            on_history({**observations, 'currency': metadata.get('currency'), 'symbol': symbol, 'interval': '1wk' if fundamentals_only else '1d',
                        'start': start.isoformat(), 'end': today.isoformat(), 'splitHistoryStart': history_start.isoformat(),
                        'url': f'https://finance.yahoo.com/quote/{symbol}/history/', 'retrievedAt': datetime.now(timezone.utc).isoformat()})
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


def create_study(company, include_peers=True, persist=True, fundamentals_only=False, study_id=None, on_progress=None, preload_group=None):
    if study_id is None or not persist:
        return build_study(company, include_peers, persist, fundamentals_only, study_id, on_progress, preload_group)
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
        return build_study(company, include_peers, persist, fundamentals_only, study_id, on_progress, preload_group)


def build_study(company, include_peers, persist, fundamentals_only, study_id=None, on_progress=None, preload_group=None):
    study_id = study_id or str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    if on_progress and fundamentals_only:
        from server.study_preload import take_preload
        preload = take_preload(company, preload_group)
        if preload is not None:
            results, errors = preload.consume(study_id, created_at, on_progress)
        else:
            results, errors = progressive_inputs(company, study_id, created_at, on_progress)
    else:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {
                'sec': executor.submit(fetch_financials, company['cik'], **({'fundamentals_only': True} if fundamentals_only else {})),
                'yfinance': executor.submit(fetch_prices, company['ticker'], include_peers=include_peers, fundamentals_only=fundamentals_only),
            }
            results, errors = {}, {}
            for source, future in futures.items():
                try:
                    results[source] = future.result()
                except Exception as error:
                    errors[source] = source_error('SEC' if source == 'sec' else 'Yahoo Finance', error)
    inputs = results.pop('_preparedInputs', None)
    study = results.pop('_preparedDocument', None)
    if inputs is None or study is None:
        inputs = assemble_inputs(company, results, errors, study_id, created_at, fundamentals_only)
        study = normalize_study(inputs)
    else:
        inputs = {**inputs, 'id': study_id, 'createdAt': created_at}
        study = {**study, 'Study': {**study['Study'], 'StudyID': study_id, 'DateCreated': created_at, 'DateModified': created_at}}
    study['Metadata']['DataStage'] = 'fundamentals' if fundamentals_only else 'complete'
    if include_peers and not fundamentals_only:
        from server.peers import add_peers
        add_peers(study, results.get('yfinance', {}).get('market', {}).get('peerSymbols', []))
    if persist:
        save_study(study, inputs=inputs if fundamentals_only else None)
    return study


def assemble_inputs(company, results, errors, study_id, created_at, fundamentals_only):
    sec, prices = results.get('sec'), results.get('yfinance')
    financials = sec if sec and sec.get('annual') else fallback_financials(prices.get('market', {})) if prices else sec
    financials = financials or sec
    study = {
        'id': study_id, 'company': company,
        'createdAt': created_at,
        'financialCurrency': financials['currency'] if financials else None,
        'annual': list(financials['annual']) if financials else [],
        'prices': prices['prices'] if prices else [],
        'priceInterval': prices.get('interval', '1d') if prices else '1wk' if fundamentals_only else '1d',
        'priceCurrency': prices['currency'] if prices else None,
        'warnings': list(financials['warnings']) if financials else [],
        'statements': dict(financials.get('statements', {})) if financials else {},
        'submissions': sec.get('submissions', {}) if sec else {},
        'priceHistory': prices.get('priceHistory', []) if prices else [],
        'market': {**(prices.get('market', {}) if prices else {}), **({'profile': results['profile']} if 'profile' in results else {})},
        'sources': {
            'sec': {'status': 'ok' if sec else 'error', 'url': f"https://data.sec.gov/api/xbrl/companyfacts/CIK{company['cik']:010d}.json", 'retrievedAt': sec['retrievedAt'] if sec else None, 'error': errors.get('sec')},
            'yfinance': {'status': 'ok' if prices else 'error', 'url': f"https://finance.yahoo.com/quote/{company['ticker'].replace('.', '-')}/history/", 'retrievedAt': prices['retrievedAt'] if prices else None, 'error': errors.get('yfinance')},
        },
    }
    if not study['financialCurrency']:
        study['financialCurrency'] = study['market'].get('profile', {}).get('financialCurrency')
    if fundamentals_only:
        study['_originalFinancials'] = {'annual': study['annual'], 'statements': dict(study['statements']), 'warnings': list(study['warnings'])}
    prepare_financials(study, prices)
    if sec and '_secPayload' in sec:
        study['_secPayload'] = sec['_secPayload']
    return study


def fetch_initial_history(ticker, cancelled=None):
    check_cancelled(cancelled)
    today = date.today()
    try:
        start = today.replace(year=today.year - 10)
    except ValueError:
        start = today.replace(year=today.year - 10, day=28)
    history_start = min(start, date(today.year - 10, 1, 1))
    result = fetch_weekly_prices(yf.Ticker(ticker.replace('.', '-')), start, history_start, today)
    check_cancelled(cancelled)
    return {**result, 'interval': '1wk', 'start': str(start), 'end': str(today),
            'splitHistoryStart': str(history_start), 'retrievedAt': datetime.now(timezone.utc).isoformat(),
            'url': f'https://finance.yahoo.com/quote/{ticker}/history/'}


def progressive_inputs(company, study_id, created_at, on_progress, cancelled=None):
    # Three independent upstream tasks: a slow profile never holds back SEC or prices.
    check_cancelled(cancelled)
    results, errors = {}, {}
    cancellation = {'cancelled': cancelled} if cancelled is not None else {}
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(fetch_financials, company['cik'], fundamentals_only=True, **cancellation): 'sec',
            executor.submit(fetch_initial_history, company['ticker'], **cancellation): 'yfinance',
            executor.submit(get_profile, company['ticker']): 'profile',
        }
        pending = set(futures.values())
        for future in as_completed(futures):
            check_cancelled(cancelled)
            source = futures[future]
            pending.remove(source)
            try:
                results[source] = future.result()
            except Exception as error:
                errors[source] = source_error('SEC' if source == 'sec' else 'Yahoo Finance', error)
            profile = results.get('profile') or {}
            market = {'profile': profile, 'warnings': [errors['profile']] if errors.get('profile') else []}
            if 'yfinance' in results:
                results['yfinance']['market'] = market
            # The profile can arrive before weekly history, so publish it on its own.
            snapshot = assemble_inputs(company, results, errors, study_id, created_at, True)
            snapshot['market'] = market
            if not snapshot['financialCurrency']:
                snapshot['financialCurrency'] = profile.get('financialCurrency')
            for source in ('sec', 'yfinance'):
                if source in pending:
                    snapshot['sources'][source].update(status='loading', error=None)
            if 'yfinance' in pending:
                snapshot['warnings'] = [warning for warning in snapshot['warnings'] if 'Split' not in warning and 'EPS' not in warning]
            document = normalize_study(snapshot)
            document['Metadata']['DataStage'] = 'fundamentals'
            on_progress(document)
    results['_preparedInputs'] = snapshot
    results['_preparedDocument'] = document
    return results, errors


def complete_sec_inputs(inputs):
    payload = inputs.get('_secPayload')
    if payload is None:
        return None
    original = inputs['_originalFinancials']
    warnings = list(original['warnings'])
    try:
        submissions = sec_json(f"https://data.sec.gov/submissions/CIK{inputs['company']['cik']:010d}.json")
    except Exception:
        submissions = {}
        warnings.append('SEC company metadata could not be loaded; financial statements are preserved.')
    statements = extract_statements(payload, inputs['financialCurrency'], original['annual'], submissions=submissions)
    return {'statements': statements, 'submissions': submissions, 'warnings': warnings}


def complete_study(study_id, on_progress=None):
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
        del row
        symbol = inputs['company']['ticker'].replace('.', '-')
        profile = inputs.get('market', {}).get('profile') or None
        daily = None
        if inputs.get('priceInterval') == '1wk':
            if '_originalFinancials' not in inputs:
                raise ValueError('Original statements are unavailable. Refresh the study to retry.')
            def publish_daily(history):
                interim = {**inputs, **inputs['_originalFinancials'],
                           'statements': dict(inputs['_originalFinancials']['statements']),
                           'warnings': list(inputs['_originalFinancials']['warnings']),
                           'prices': history['prices'], 'priceHistory': history['priceHistory'],
                           'priceCurrency': history['currency'], 'priceInterval': '1d'}
                interim['sources'] = {**inputs['sources'], 'yfinance': {'status': 'ok', 'url': history['url'], 'retrievedAt': history['retrievedAt'], 'error': None}}
                prepare_financials(interim, history)
                preview = normalize_study(interim)
                preview['Metadata']['DataStage'] = 'fundamentals'
                on_progress(preview)

            with ThreadPoolExecutor(max_workers=2) as executor:
                full_sec = executor.submit(complete_sec_inputs, inputs)
                daily = fetch_prices(inputs['company']['ticker'], profile=profile, **({'on_history': publish_daily} if on_progress else {}))
                sec_completed = full_sec.result()
            market = daily['market']
            inputs.update(inputs['_originalFinancials'])
            if sec_completed is not None:
                inputs.update(sec_completed)
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
        inputs.pop('_secPayload', None)
        inputs.pop('_originalFinancials', None)
        completed = normalize_study(inputs)
        if on_progress:
            completed['Metadata']['DataStage'] = 'fundamentals'
            on_progress(completed)
        from server.peers import add_peers
        add_peers(completed, market.get('peerSymbols', []))
        completed['Metadata']['DataStage'] = 'complete'
        completed['Study']['DateModified'] = datetime.now(timezone.utc).isoformat()
        payload = json.dumps(completed, allow_nan=False, separators=(',', ':'))
        with DB_LOCK, connection() as db:
            db.execute('UPDATE studies SET payload = ? WHERE id = ?', (payload, study_id))
            db.execute('DELETE FROM study_inputs WHERE id = ?', (study_id,))
        return completed

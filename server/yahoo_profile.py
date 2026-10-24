"""Short-lived Yahoo profiles shared by quotes and studies, including in-flight work."""
from concurrent.futures import Future
import threading
import time

import yfinance as yf

PROFILE_TTL = 60
_LOCK = threading.Lock()
_PROFILES = {}
_PENDING = {}


def get_profile(symbol, stock=None):
    symbol = symbol.replace('.', '-')
    with _LOCK:
        cached = _PROFILES.get(symbol)
        if cached and time.monotonic() - cached[0] < PROFILE_TTL:
            return cached[1]
        pending = _PENDING.get(symbol)
        owner = pending is None
        if owner:
            pending = _PENDING[symbol] = Future()
    if not owner:
        return pending.result()
    try:
        profile = (stock if stock is not None else yf.Ticker(symbol)).get_info() or {}
        if profile:
            with _LOCK:
                # A discarded preload must not refill the profile cache later.
                if _PENDING.get(symbol) is pending:
                    if len(_PROFILES) >= 128:
                        del _PROFILES[min(_PROFILES, key=lambda key: _PROFILES[key][0])]
                    _PROFILES[symbol] = (time.monotonic(), profile)
        pending.set_result(profile)
        return profile
    except BaseException as error:
        pending.set_exception(error)
        raise
    finally:
        with _LOCK:
            if _PENDING.get(symbol) is pending:
                _PENDING.pop(symbol, None)


def discard_profile(symbol):
    with _LOCK:
        symbol = symbol.replace('.', '-')
        _PROFILES.pop(symbol, None)
        # Existing callers can finish, but their result is no longer cacheable.
        _PENDING.pop(symbol, None)


def expire_profiles():
    now = time.monotonic()
    with _LOCK:
        for symbol, (retrieved, _) in list(_PROFILES.items()):
            if now - retrieved >= PROFILE_TTL:
                del _PROFILES[symbol]

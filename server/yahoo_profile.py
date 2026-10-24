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
                # Bound memory even when many different companies are requested.
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
            _PENDING.pop(symbol, None)

"""Fresh SEC responses over a bounded pool of reusable HTTPS connections."""
import atexit
from concurrent.futures import CancelledError

import requests

# Sessions are request-local (no shared mutable cookies/headers). The thread-safe
# adapter retains only connections, never financial responses.
_ADAPTER = requests.adapters.HTTPAdapter(pool_connections=1, pool_maxsize=8, pool_block=True, max_retries=0)
atexit.register(_ADAPTER.close)


def get_json(url, headers, timeout, cancelled=None):
    with requests.Session() as session:
        session.mount('https://data.sec.gov/', _ADAPTER)
        try:
            with session.get(url, headers=headers, timeout=timeout) as response:
                response.raise_for_status()
                if cancelled is not None and cancelled.is_set():
                    raise CancelledError('Preload discarded.')
                return response.json()
        finally:
            # Closing this request's session must not close the shared pool.
            session.adapters.pop('https://data.sec.gov/', None)

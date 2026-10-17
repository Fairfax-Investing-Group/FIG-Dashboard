from __future__ import annotations

import re
import time
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

import httpx

from .core import Blocked


class Fetcher:
    """Single sequential client, <= 5 req/s, including retries and redirects."""

    def __init__(self, user_agent, transport=None):
        self.user_agent = user_agent
        self.client = httpx.Client(timeout=120, follow_redirects=False, transport=transport)
        self.last = 0.0
        self.cooldown_until = 0.0

    def fetch(self, url, *, method="GET", payload=None):
        if time.monotonic() < self.cooldown_until:
            raise Blocked("Source Retry-After cooldown is still active; no request sent")
        original = url
        for redirect in range(6):
            if urlparse(url).scheme != "https":
                raise ValueError("Only HTTPS source requests are permitted")
            if urlparse(url).hostname in {"www.sec.gov", "data.sec.gov"}:
                if not re.search(r"\S+@\S+\.\S+", self.user_agent):
                    raise Blocked("Set SEC_USER_AGENT to truthful organization/name and contact email")
            for attempt in range(5):
                time.sleep(max(0, 0.22 - (time.monotonic() - self.last)))
                self.last = time.monotonic()
                response = self.client.request(
                    method,
                    url,
                    json=payload,
                    headers={"User-Agent": self.user_agent or "Fairfax financial research"},
                )
                if response.status_code == 403:
                    raise Blocked(f"Source refused access (403): {url}; no bypass attempted")
                if response.status_code in {429, 500, 502, 503, 504}:
                    wait = response.headers.get("Retry-After", "")
                    delay = 2**attempt
                    if wait:
                        try:
                            delay = (
                                float(wait)
                                if wait.isdigit()
                                else max(0, parsedate_to_datetime(wait).timestamp() - time.time())
                            )
                        except (ValueError, TypeError, OverflowError):
                            pass
                    if delay > 60:
                        self.cooldown_until = time.monotonic() + delay
                        raise Blocked(
                            f"Source requires Retry-After {wait}; batch deferred without early retry"
                        )
                    time.sleep(delay)
                    continue
                response.raise_for_status()
                break
            else:
                raise Blocked(f"Retries exhausted: {url}")
            if response.is_redirect:
                url = str(response.url.join(response.headers["location"]))
                continue
            return response.content
        raise Blocked(f"Too many redirects: {original}")

    def close(self):
        self.client.close()

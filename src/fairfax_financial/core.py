from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def key(*values) -> str:
    return digest(canonical(values).encode())


def now() -> str:
    return datetime.now(UTC).isoformat()


def company_id(cik: str | int) -> str:
    return str(uuid5(NAMESPACE_URL, f"https://www.sec.gov/CIK/{int(cik):010d}"))


def security_id(authority: str, native_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"security:{authority}:{native_id}"))


@dataclass
class Settings:
    root: Path
    storage: str = "local"
    user_agent: str = ""
    limit_bytes: int = 9_000_000_000

    @classmethod
    def env(cls):
        return cls(
            Path(os.getenv("FINANCIAL_DATA_DIR", "data")).resolve(),
            os.getenv("FINANCIAL_STORAGE", "local"),
            os.getenv("SEC_USER_AGENT", ""),
            int(os.getenv("FINANCIAL_STORAGE_LIMIT_BYTES", "9000000000")),
        )

    def __post_init__(self):
        if self.storage not in {"local", "r2"}:
            raise ValueError("FINANCIAL_STORAGE must be local or r2")
        self.root.mkdir(parents=True, exist_ok=True)


class Blocked(RuntimeError):
    """An external prerequisite is unavailable; never invent a replacement."""

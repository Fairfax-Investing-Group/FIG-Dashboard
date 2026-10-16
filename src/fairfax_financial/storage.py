from __future__ import annotations

import gzip
import json
import os

import boto3
from botocore.exceptions import ClientError

from .core import Blocked, Settings, canonical, digest, key, now


class Objects:
    """Immutable, content-addressed Bronze objects. R2 uses the supported S3 API."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = settings.root / "raw"
        self.root.mkdir(exist_ok=True)
        self.client = None
        if settings.storage == "r2":
            required = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
            if any(not os.getenv(n) for n in required):
                raise Blocked("R2 requires " + ", ".join(required))
            self.client = boto3.client(
                "s3", endpoint_url=os.environ["R2_ENDPOINT"], region_name="auto",
                aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            )
        self.bucket = os.getenv("R2_RAW_BUCKET", "financial-raw")

    def keys(self, prefix=""):
        if self.client:
            for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
                yield from (o["Key"] for o in page.get("Contents", []))
        else:
            yield from sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*")
                              if p.is_file() and p.relative_to(self.root).as_posix().startswith(prefix))

    def get(self, path):
        if self.client:
            return self.client.get_object(Bucket=self.bucket, Key=path)["Body"].read()
        return (self.root / path).read_bytes()

    def exists(self, path):
        if not self.client:
            return (self.root / path).exists()
        try:
            self.client.head_object(Bucket=self.bucket, Key=path)
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise

    def usage(self):
        if not self.client:
            return sum(p.stat().st_size for p in self.settings.root.rglob("*") if p.is_file())
        total = 0
        for bucket in [self.bucket, os.getenv("R2_LAKE_BUCKET", "financial-lake")]:
            for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=bucket):
                total += sum(o["Size"] for o in page.get("Contents", []))
        return total

    def put(self, path, data):
        if self.exists(path):
            if self.get(path) != data:
                raise ValueError("Immutable object collision: " + path)
            return
        if self.usage() + len(data) > self.settings.limit_bytes:
            raise Blocked(f"Storage guard: projected at least {self.usage() + len(data)} bytes; "
                          "inspect storage report before explicitly raising FINANCIAL_STORAGE_LIMIT_BYTES")
        if self.client:
            self.client.put_object(Bucket=self.bucket, Key=path, Body=data, IfNoneMatch="*")
        else:
            dest = self.root / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            # One writer enforced by CLI lock; exclusive create also protects immutability.
            with dest.open("xb") as f:
                f.write(data)

    def save(self, data: bytes, url: str, kind: str, metadata=None, collected_at=None):
        sha = digest(data)
        path = f"objects/{sha[:2]}/{sha}.gz"
        self.put(path, gzip.compress(data, mtime=0))
        meta = metadata or {}
        rid = key(url, sha, kind, meta)
        receipt_path = f"receipts/{kind}/{rid}.json"
        if self.exists(receipt_path):
            return json.loads(self.get(receipt_path))
        receipt = dict(id=rid, source_url=url, source_hash=sha, storage_path=path,
                       size=len(data), stored_size=len(self.get(path)), collected_at=collected_at or now(),
                       kind=kind, metadata=meta)
        self.put(receipt_path, canonical(receipt).encode())
        return receipt

    def read(self, receipt):
        data = gzip.decompress(self.get(receipt["storage_path"]))
        if digest(data) != receipt["source_hash"]:
            raise ValueError("Bronze hash mismatch: " + receipt["id"])
        return data

    def receipts(self, kind=""):
        prefix = f"receipts/{kind}/" if kind else "receipts/"
        return [json.loads(self.get(p)) for p in self.keys(prefix)]

    def record(self, kind, payload, identity=None):
        return self.save(canonical(payload).encode(), "internal:acquisition-record", kind,
                         {"identity": identity or key(payload)})

    def payloads(self, kind):
        return [(r, json.loads(self.read(r))) for r in self.receipts(kind)]

    def cached(self, url, kind):
        matches = [r for r in self.receipts(kind) if r["source_url"] == url]
        return max(matches, key=lambda r: r["collected_at"]) if matches else None

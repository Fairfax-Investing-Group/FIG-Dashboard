from __future__ import annotations

import os

import polars as pl
import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import NamespaceAlreadyExistsError
from pyiceberg.expressions import AlwaysTrue, EqualTo
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import BucketTransform
from pyiceberg.types import BooleanType, LongType, NestedField, StringType

from .core import Blocked, Settings
from .schema import SCHEMAS


class Lake:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.objects = None
        self._writes = 0
        if settings.storage == "local":
            self.catalog = load_catalog(
                "financial",
                type="sql",
                uri=f"sqlite:///{settings.root / 'catalog.db'}",
                warehouse=(settings.root / "lake").as_uri(),
            )
        else:
            required = [
                "BASIN_CATALOG_URI",
                "BASIN_WAREHOUSE",
                "BASIN_TOKEN",
                "R2_ENDPOINT",
                "R2_ACCESS_KEY_ID",
                "R2_SECRET_ACCESS_KEY",
            ]
            if any(not os.getenv(n) for n in required):
                raise Blocked("Basin requires " + ", ".join(required))
            self.catalog = load_catalog(
                "financial",
                type="rest",
                **{
                    "uri": os.environ["BASIN_CATALOG_URI"],
                    "warehouse": os.environ["BASIN_WAREHOUSE"],
                    "token": os.environ["BASIN_TOKEN"],
                    "s3.endpoint": os.environ["R2_ENDPOINT"],
                    "s3.access-key-id": os.environ["R2_ACCESS_KEY_ID"],
                    "s3.secret-access-key": os.environ["R2_SECRET_ACCESS_KEY"],
                    "s3.region": "auto",
                },
            )

    def initialize(self):
        for ns in ("silver", "gold"):
            try:
                self.catalog.create_namespace(ns)
            except NamespaceAlreadyExistsError:
                pass
        for name, schema in SCHEMAS.items():
            if self.catalog.table_exists(name):
                existing = self.catalog.load_table(name)
                if set(schema.names) - {f.name for f in existing.schema().fields}:
                    with existing.update_schema() as update:
                        update.union_by_name(schema)
                continue
            iceberg = Schema(
                *(
                    NestedField(
                        i,
                        f.name,
                        BooleanType()
                        if pa.types.is_boolean(f.type)
                        else LongType()
                        if pa.types.is_int64(f.type)
                        else StringType(),
                        required=False,
                    )
                    for i, f in enumerate(schema, 1)
                )
            )
            partitions = PartitionSpec()
            if name in {
                "silver.financial_facts",
                "gold.annual_reported_facts",
                "gold.quarterly_reported_facts",
            }:
                partitions = PartitionSpec(
                    PartitionField(
                        source_id=iceberg.find_field("company_id").field_id,
                        field_id=1000,
                        transform=BucketTransform(32),
                        name="issuer_bucket",
                    )
                )
            self.catalog.create_table(
                name,
                schema=iceberg,
                partition_spec=partitions,
                properties={
                    "write.parquet.compression-codec": "zstd",
                    "write.target-file-size-bytes": "134217728",
                    "format-version": "2",
                },
            )

    def rows(self, name, where=None):
        return self.catalog.load_table(name).scan(row_filter=where or AlwaysTrue()).to_arrow().to_pylist()

    def upsert(self, name, rows):
        if not rows:
            return
        table = pa.Table.from_pylist(rows, schema=SCHEMAS[name])
        df = pl.from_arrow(table)
        if df["id"].null_count() or df["id"].n_unique() != df.height:
            raise ValueError("Duplicate/null deterministic keys in " + name)
        self.guard(table)
        # PyIceberg compares all columns and does not commit unchanged data.
        self.catalog.load_table(name).upsert(table, join_cols=["id"])

    def replace(self, name, rows, column, value):
        """Atomically replace one filing's derivation, including removals after rule fixes."""
        condition = EqualTo(column, value)
        previous = self.rows(name, condition)

        def sort(xs):
            return sorted(xs, key=lambda r: r["id"])

        incoming = pa.Table.from_pylist(rows, schema=SCHEMAS[name])
        ids = pl.from_arrow(incoming)["id"]
        if ids.null_count() or ids.n_unique() != len(ids):
            raise ValueError("Duplicate/null deterministic keys in " + name)
        if sort(previous) == sort(incoming.to_pylist()):
            return
        self.guard(incoming)
        if not previous:
            self.catalog.load_table(name).append(incoming)
        else:
            self.catalog.load_table(name).overwrite(incoming, overwrite_filter=condition)

    def guard(self, incoming):
        if self.objects is None:
            return
        # Conservative reservation for Parquet and Iceberg metadata; periodically
        # reconcile with physical inventory (which includes obsolete snapshots).
        current = self.objects.usage(refresh=self._writes % 100 == 0)
        reserve = incoming.nbytes * 2 + 131072
        if current + reserve > self.settings.limit_bytes:
            raise Blocked(
                f"Lake storage guard: projected up to {current + reserve:,} bytes, "
                f"limit {self.settings.limit_bytes:,}; review physical inventory and budget"
            )
        self.objects._usage = current + reserve
        self._writes += 1

    def reset(self):
        """Drop registered derived tables only. Raw is in a separate store and is never touched."""
        for name in SCHEMAS:
            if self.catalog.table_exists(name):
                self.catalog.purge_table(name)
        self.initialize()

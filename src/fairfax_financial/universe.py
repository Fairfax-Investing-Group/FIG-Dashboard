from __future__ import annotations

import csv
import io
import json
import re
from datetime import date

from .core import canonical, company_id, key, security_id

NYSE_URL = "https://www.nyse.com/api/quotes/filter"
SEC_TICKERS = "https://www.sec.gov/files/company_tickers_exchange.json"
OTHER_LISTED = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"


def symbol(value):
    return value.upper().replace(".", "-")


def acquire(raw, fetcher, snapshot_date=None):
    day = snapshot_date or date.today().isoformat()
    pages = []
    total = None
    page = 1
    while total is None or len(pages) < total:
        payload = dict(
            instrumentType="EQUITY",
            pageNumber=page,
            sortColumn="NORMALIZED_TICKER",
            sortOrder="ASC",
            maxResultsPerPage=1000,
            filterToken="",
        )
        data = fetcher.fetch(NYSE_URL, method="POST", payload=payload)
        raw.save(data, NYSE_URL, "nyse-directory", {"date": day, "request": payload})
        rows = json.loads(data)
        if not rows:
            raise ValueError("NYSE directory truncated/empty; universe not published")
        total = int(rows[0]["total"])
        pages.extend(rows)
        page += 1
        if page > 100:
            raise ValueError("Unexpected NYSE pagination")
    if len(pages) != total or len({r["url"] for r in pages}) != total:
        raise ValueError("NYSE pagination changed/duplicated; retry a fresh snapshot")
    # Nasdaq Trader is the listing exchange's published US consolidated directory.
    # It supplies preferred/fund/warrant coverage absent from the EQUITY directory.
    other = raw.save(fetcher.fetch(OTHER_LISTED), OTHER_LISTED, "other-listed", {"date": day})
    tickers = raw.save(fetcher.fetch(SEC_TICKERS), SEC_TICKERS, "sec-tickers", {"date": day})
    sources = [r["id"] for r in raw.receipts("nyse-directory") if r["metadata"]["date"] == day]
    raw.record("universe-bundle", dict(date=day, nyse=sources, other=other["id"], tickers=tickers["id"]))
    return build(raw)


def build(raw, aliases=()):
    receipts = {r["id"]: r for r in raw.receipts()}
    companies, securities, snapshots, flags = {}, {}, [], []
    alias_map = {(a["mic"], a["ticker"]): a for a in aliases}
    bundles = sorted((p for _, p in raw.payloads("universe-bundle")), key=lambda p: p["date"])
    for bundle in bundles:
        mapping = json.loads(raw.read(receipts[bundle["tickers"]]))
        cik_map = {}
        for values in mapping["data"]:
            row = dict(zip(mapping["fields"], values))
            if row["exchange"] == "NYSE":
                cik_map.setdefault(symbol(row["ticker"]), set()).add(str(row["cik"]).zfill(10))
        members = {}
        for rid in bundle["nyse"]:
            for row in json.loads(raw.read(receipts[rid])):
                match = re.fullmatch(r"https://www.nyse.com/quote/XNYS:([^/?]+)", row["url"])
                if match:
                    ticker = row["normalizedTicker"]
                    members[ticker] = dict(
                        ticker=ticker,
                        name=row["instrumentName"],
                        mic="XNYS",
                        source_id=rid,
                        security_type="unknown",
                    )
        directory = raw.read(receipts[bundle["other"]]).decode()
        if "File Creation Time:" not in directory:
            raise ValueError("Other-listed directory missing creation footer")
        for row in csv.DictReader(io.StringIO(directory), delimiter="|"):
            if row.get("Exchange") != "N" or row.get("Test Issue") != "N":
                continue
            ticker = row["ACT Symbol"]
            # Use source-published NASDAQ symbol only for SEC's symbol association.
            match = next((t for t in members if symbol(t) == symbol(row["NASDAQ Symbol"])), None)
            ticker = match or ticker
            if ticker not in members:
                members[ticker] = dict(
                    ticker=ticker,
                    name=row["Security Name"],
                    mic="XNYS",
                    source_id=bundle["other"],
                    security_type="unknown",
                )
            members[ticker]["mapping_symbol"] = row["NASDAQ Symbol"]
            if row["ETF"] == "Y":
                members[ticker]["security_type"] = "ETF"
        for ticker, row in sorted(members.items()):
            ciks = cik_map.get(symbol(row.pop("mapping_symbol", ticker)), set())
            cik = next(iter(ciks)) if len(ciks) == 1 else None
            cid = company_id(cik) if cik else None
            alias = alias_map.get(("XNYS", ticker))
            if alias and not alias.get("source_url"):
                raise ValueError("Security alias requires source evidence")
            native = alias["security_key"] if alias else canonical(["XNYS", cik, ticker])
            sid = security_id("fig-bronze-issue-registry", native)
            securities[sid] = dict(
                id=sid,
                company_id=cid,
                cik=cik,
                **row,
                identity_basis="sourced-alias" if alias else "provisional-first-symbol",
                as_of_date=bundle["date"],
            )
            if cik:
                companies[cid] = dict(
                    id=cid, cik=cik, name=row["name"], source_id=row["source_id"], as_of_date=bundle["date"]
                )
            for code, detail in (
                ([("missing_cik", "No unique SEC ticker mapping")] if not cik else [])
                + [("unknown_security_type", "Source does not explicitly classify this security")]
                * (row["security_type"] == "unknown")
                + (
                    []
                    if alias
                    else [
                        (
                            "provisional_security_identity",
                            "No permanent issue ID exposed; sourced aliases required for ticker changes",
                        )
                    ]
                )
            ):
                flags.append(
                    dict(
                        id=key(bundle["date"], sid, code),
                        code=code,
                        severity="coverage",
                        company_id=cid,
                        details=detail + ": " + ticker,
                        source_id=row["source_id"],
                    )
                )
            snapshots.append(
                dict(
                    id=key(bundle["date"], sid),
                    snapshot_date=bundle["date"],
                    security_id=sid,
                    company_id=cid,
                    source_id=row["source_id"],
                )
            )
    return list(companies.values()), list(securities.values()), snapshots, flags

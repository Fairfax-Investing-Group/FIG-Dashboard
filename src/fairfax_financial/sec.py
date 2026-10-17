from __future__ import annotations

import json
from urllib.parse import urldefrag, urljoin, urlparse

from lxml import etree

from .core import company_id, key

FORMS = {"10-K", "10-K/A", "10-Q", "10-Q/A"}
SUBMISSIONS = "https://data.sec.gov/submissions/"
XSI = "{http://www.w3.org/2001/XMLSchema-instance}schemaLocation"
XLINK = "{http://www.w3.org/1999/xlink}href"
XSD = "http://www.w3.org/2001/XMLSchema"
LINK = "http://www.xbrl.org/2003/linkbase"


def issue(raw, code, error, *, cik=None, accession=None, source_id=None, severity="error"):
    try:
        detail = str(error)
    except Exception:
        detail = type(error).__name__
    payload = dict(
        code=code,
        severity=severity,
        company_id=company_id(cik) if cik else None,
        accession_number=accession,
        fact_id=None,
        details=detail[:4000],
        source_id=source_id,
    )
    payload["id"] = key(payload)
    raw.record("issue", payload)
    return payload


def get_source(raw, fetcher, url, kind, metadata=None, refresh=False):
    cached = None if refresh else raw.cached(url, kind)
    if cached:
        return cached
    return raw.save(fetcher.fetch(url), url, kind, metadata)


def discover(raw, fetcher, cik, since, until, refresh=False):
    url = f"{SUBMISSIONS}CIK{int(cik):010d}.json"
    receipt = get_source(raw, fetcher, url, "submissions", {"cik": cik}, refresh)
    data = json.loads(raw.read(receipt))
    batches = [(receipt, data["filings"]["recent"])]
    for entry in data["filings"].get("files", []):
        if entry["filingTo"] < since or entry["filingFrom"] > until:
            continue
        older = get_source(raw, fetcher, SUBMISSIONS + entry["name"], "submissions-history", {"cik": cik})
        batches.append((older, json.loads(raw.read(older))))
    filings = {}
    for ref, batch in batches:
        lengths = {len(v) for v in batch.values() if isinstance(v, list)}
        if len(lengths) != 1:
            raise ValueError("Malformed SEC submissions column lengths")
        for i, form in enumerate(batch["form"]):
            filed = batch["filingDate"][i]
            if form not in FORMS or not since <= filed <= until:
                continue
            accession = batch["accessionNumber"][i]
            filing = dict(
                id=key(cik, accession),
                company_id=company_id(cik),
                cik=cik,
                accession_number=accession,
                form=form,
                filed_at=filed,
                accepted_at=batch.get("acceptanceDateTime", [None] * len(batch["form"]))[i],
                report_date=batch["reportDate"][i] or None,
                primary_document=batch["primaryDocument"][i],
                source_id=ref["id"],
            )
            raw.record("filing", filing)
            filings[accession] = filing
    if not filings:
        issue(
            raw,
            "no_relevant_filings",
            f"No {sorted(FORMS)} in {since}..{until}; foreign issuers/funds may use other forms",
            cik=cik,
            source_id=receipt["id"],
            severity="coverage",
        )
    return data, list(filings.values())


def xml_root(data):
    return etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True))


def dependencies(data, base):
    """Only XBRL/schema references, never images, exhibits or visual tables."""
    root = xml_root(data)
    refs = set()
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        ns = etree.QName(element).namespace
        local = etree.QName(element).localname
        if ns == XSD and local in {"import", "include", "redefine"}:
            location = element.get("schemaLocation")
            if location:
                refs.add(urldefrag(urljoin(base, location))[0])
        if ns == LINK and local in {"schemaRef", "linkbaseRef", "loc", "roleRef", "arcroleRef"}:
            href = element.get(XLINK)
            if href:
                target = urldefrag(urljoin(base, href))[0]
                if target != base:
                    refs.add(target)
        schema = element.get(XSI)
        if schema:
            words = schema.split()
            if len(words) % 2:
                raise ValueError("Malformed xsi:schemaLocation")
            refs.update(urldefrag(urljoin(base, words[i]))[0] for i in range(1, len(words), 2))
    # XML base support would require URI resolution at each node, refuse rather than guess.
    if root.xpath("//*[@xml:base]", namespaces={"xml": "http://www.w3.org/XML/1998/namespace"}):
        raise ValueError("xml:base is not yet supported by acquisition; filing quarantined")
    return refs


def acquire_filing(raw, fetcher, filing):
    accession, cik = filing["accession_number"], filing["cik"]
    existing = [p for _, p in raw.payloads("filing-bundle") if p["filing"]["id"] == filing["id"]]
    if existing:
        return existing[-1]
    base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/"
    meta = {"cik": cik, "accession_number": accession}
    index_ref = get_source(raw, fetcher, base + "index.json", "filing-index", meta)
    items = json.loads(raw.read(index_ref))["directory"]["item"]
    names = {r["name"] for r in items}
    primary = filing["primary_document"]
    if not primary or primary not in names:
        raise ValueError("Primary filing document absent from directory")
    # Prefer a submitted instance where available. Generated *_htm.xml is a SEC
    # extraction, so prefer the actual inline document when it is inline XBRL.
    primary_ref = get_source(raw, fetcher, base + primary, "filing-document", meta)
    primary_data = raw.read(primary_ref)
    is_inline = b"inlineXBRL" in primary_data
    if is_inline:
        entry = base + primary
        seeds = {entry: primary_ref}
    else:
        candidates = []
        for name in sorted(names):
            if (
                not name.endswith(".xml")
                or name in {"FilingSummary.xml", "MetaLinks.json"}
                or name.startswith("R")
            ):
                continue
            if name.endswith(("_cal.xml", "_def.xml", "_lab.xml", "_pre.xml")):
                continue
            ref = get_source(raw, fetcher, base + name, "filing-document", meta)
            doc = xml_root(raw.read(ref))
            if doc.tag == "{http://www.xbrl.org/2003/instance}xbrl":
                candidates.append((base + name, ref))
        if len(candidates) != 1:
            raise ValueError(f"Expected one submitted XBRL instance, found {len(candidates)}")
        entry, ref = candidates[0]
        seeds = {entry: ref}
    # Preserve all filed XBRL linkbases, including those not transitively referenced.
    for name in sorted(names):
        if name.endswith((".xsd", "_cal.xml", "_def.xml", "_lab.xml", "_pre.xml")):
            seeds[base + name] = get_source(raw, fetcher, base + name, "filing-document", meta)
    documents = {}
    pending = list(seeds)
    while pending:
        url = pending.pop()
        if url in documents:
            continue
        if len(documents) > 1500:
            raise ValueError("Taxonomy graph exceeds acquisition safety bound")
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
            raise ValueError("Unsupported taxonomy URI: " + url)
        # Taxonomies historically use HTTP identifiers; fetch over HTTPS, while
        # preserving original URI as the resolution identity in the bundle.
        fetch_url = url.replace("http://", "https://", 1)
        ref = seeds.get(url) or get_source(raw, fetcher, fetch_url, "taxonomy", {"resolution_url": url})
        data = raw.read(ref)
        refs = dependencies(data, url)
        documents[url] = ref["id"]
        pending.extend(sorted(refs - documents.keys()))
    bundle = dict(filing=filing, entry=entry, documents=documents, index_id=index_ref["id"])
    raw.record("filing-bundle", bundle, filing["id"])
    return bundle


def metadata(raw):
    companies = {}
    for ref in sorted(raw.receipts("submissions"), key=lambda r: (r["collected_at"], r["id"])):
        data = json.loads(raw.read(ref))
        cik = str(data["cik"]).zfill(10)
        cid = company_id(cik)
        row = dict(
            id=cid,
            cik=cik,
            name=data["name"],
            sic=data.get("sic") or None,
            sic_description=data.get("sicDescription") or None,
            fiscal_year_end=data.get("fiscalYearEnd") or None,
            country=None,
            website=data.get("website") or None,
            source_id=ref["id"],
            as_of_date=ref["collected_at"][:10],
        )
        if cid not in companies or companies[cid]["as_of_date"] <= row["as_of_date"]:
            companies[cid] = row
    return list(companies.values())

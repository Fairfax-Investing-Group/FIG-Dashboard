from __future__ import annotations

import importlib.metadata
import re
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urldefrag

from arelle import Cntlr, ModelManager, XbrlConst
from arelle.ModelFormulaObject import FormulaOptions
from arelle.XmlValidateConst import VALID
from lxml import etree

from ._vendor.sec_transform import loadSECtransforms
from .core import canonical, key
from .sec import LINK, XLINK, XSD, XSI, xml_root

PARSER_VERSION = "fairfax-2/sec-4891c4c/arelle-" + importlib.metadata.version("arelle-release")


def taxonomy(namespace):
    for family, pattern in [
        ("us-gaap", r"fasb.org/us-gaap/"),
        ("dei", r"xbrl.sec.gov/dei/"),
        ("ifrs-full", r"ifrs.org/taxonomy/.*/ifrs-full"),
        ("srt", r"fasb.org/srt/"),
    ]:
        if re.search(pattern, namespace):
            return family
    return namespace


def qname(q):
    return f"{{{q.namespaceURI}}}{q.localName}"


def unit_name(q):
    if q.namespaceURI == "http://www.xbrl.org/2003/iso4217":
        return q.localName
    if q.namespaceURI == "http://www.xbrl.org/2003/instance" and q.localName in {"shares", "pure"}:
        return q.localName
    return qname(q)


def localize(raw, bundle, directory):
    """Rewrite URI references only in disposable copies; all original bytes remain immutable.

    Arelle runs offline. Every file in its DTS must be present in the Bronze bundle.
    """
    receipts = {r["id"]: r for r in raw.receipts()}
    paths = {
        url: Path(directory) / (key(url) + Path(urldefrag(url)[0]).suffix) for url in bundle["documents"]
    }
    from urllib.parse import urljoin

    def resolve(href, base):
        target, fragment = urldefrag(urljoin(base, href))
        if target not in paths:
            raise ValueError("Incomplete raw taxonomy dependency: " + target)
        return paths[target].as_uri() + ("#" + fragment if fragment else "")

    for url, rid in bundle["documents"].items():
        root = xml_root(raw.read(receipts[rid]))
        for el in root.iter():
            if not isinstance(el.tag, str):
                continue
            ns, name = etree.QName(el).namespace, etree.QName(el).localname
            if ns == XSD and name in {"import", "include", "redefine"} and el.get("schemaLocation"):
                el.set("schemaLocation", resolve(el.get("schemaLocation"), url))
            if (
                ns == LINK
                and name in {"schemaRef", "linkbaseRef", "loc", "roleRef", "arcroleRef"}
                and el.get(XLINK)
            ):
                el.set(XLINK, resolve(el.get(XLINK), url))
            if el.get(XSI):
                words = el.get(XSI).split()
                el.set(XSI, " ".join(v if i % 2 == 0 else resolve(v, url) for i, v in enumerate(words)))
        paths[url].write_bytes(etree.tostring(root, encoding="UTF-8", xml_declaration=True))
    reverse = {str(p): (url, receipts[bundle["documents"][url]]) for url, p in paths.items()}
    return paths[bundle["entry"]], reverse


def parse(raw, bundle, normalization_version):
    filing = bundle["filing"]
    accession = filing["accession_number"]
    facts, relationships, flags = [], [], []

    def flag(code, details, fid=None):
        payload = dict(
            code=code,
            severity="error",
            company_id=filing["company_id"],
            accession_number=accession,
            fact_id=fid,
            details=str(details)[:4000],
            source_id=filing["source_id"],
        )
        payload["id"] = key(payload)
        flags.append(payload)

    with TemporaryDirectory(prefix="fairfax-xbrl-") as directory:
        entry, reverse = localize(raw, bundle, directory)
        cntlr = Cntlr.Cntlr(logFileName="logToBuffer", disable_persistent_config=True)
        cntlr.webCache.workOffline = True
        manager = ModelManager.initialize(cntlr)
        manager.formulaOptions = FormulaOptions()
        manager.loadCustomTransforms()
        loadSECtransforms(manager.customTransforms)
        try:
            model = manager.load(str(entry))
            if model.modelDocument is None or not model.factsInInstance:
                raise ValueError("Arelle did not load any instance facts")
            manager.validate()
            for err in model.errors:
                flag("xbrl_validation", canonical(err))
            focus = {}
            for f in model.factsInInstance:
                if f.qname and taxonomy(f.qname.namespaceURI) == "dei" and not f.isNil:
                    if f.qname.localName in {"DocumentFiscalYearFocus", "DocumentFiscalPeriodFocus"}:
                        focus.setdefault(f.qname.localName, set()).add(str(f.xValue))
            fy = next(iter(focus.get("DocumentFiscalYearFocus", set())), None)
            fp = next(iter(focus.get("DocumentFiscalPeriodFocus", set())), None)
            if any(len(v) > 1 for v in focus.values()):
                fy, fp = None, None
                flag("ambiguous_fiscal_focus", focus)
            for fact in sorted(model.factsInInstance, key=lambda f: f.objectIndex):
                source_file = str(Path(fact.modelDocument.filepath))
                if source_file not in reverse:
                    raise ValueError("Fact origin is outside retained raw source graph: " + source_file)
                url, receipt = reverse[source_file]
                context = fact.context
                fact_path = fact.getroottree().getpath(fact)
                fid = key(filing["cik"], accession, receipt["source_hash"], fact_path)
                valid = fact.xValid >= VALID and context is not None and fact.concept is not None
                numeric = fact.isNumeric
                value = None if fact.isNil else str(fact.xValue) if fact.xValid >= VALID else None
                start = end = instant = None
                dimensions = {}
                if context is not None:
                    if context.isInstantPeriod:
                        instant = (context.instantDatetime - timedelta(days=1)).date().isoformat()
                    elif context.isStartEndPeriod:
                        start = context.startDatetime.date().isoformat()
                        end = (context.endDatetime - timedelta(days=1)).date().isoformat()
                    else:
                        valid = False
                        flag("malformed_context", "Forever or malformed financial period", fid)
                    for dim, member in context.qnameDims.items():
                        dimensions[qname(dim)] = (
                            qname(member.memberQname)
                            if member.isExplicit
                            else etree.tostring(member.typedMember, encoding="unicode")
                        )
                    if context.nonDimValues("segment") or context.nonDimValues("scenario"):
                        dimensions["_non_dimensional_context"] = True
                    if context.entityIdentifier[1].lstrip("0") != filing["cik"].lstrip("0"):
                        valid = False
                        flag("entity_mismatch", context.entityIdentifier, fid)
                if numeric and fact.unit is None:
                    valid = False
                    flag("invalid_unit", "Numeric fact has no resolved unit", fid)
                unit = None
                if fact.unit is not None:
                    numerator, denominator = fact.unit.measures
                    unit = canonical(
                        dict(
                            numerator=sorted(unit_name(q) for q in numerator),
                            denominator=sorted(unit_name(q) for q in denominator),
                        )
                    )
                if not valid:
                    flag("invalid_fact", "Invalid fact retained in Silver and excluded from Gold", fid)
                current = (end or instant) == filing.get("report_date")
                facts.append(
                    dict(
                        id=fid,
                        company_id=filing["company_id"],
                        cik=filing["cik"],
                        accession_number=accession,
                        taxonomy=taxonomy(fact.qname.namespaceURI),
                        namespace=fact.qname.namespaceURI,
                        concept=fact.qname.localName,
                        label=fact.concept.label(lang="en") if fact.concept is not None else None,
                        value=value,
                        lexical_value=fact.value,
                        unit=unit,
                        unit_id=fact.unitID,
                        context_id=fact.contextID,
                        context_xml=etree.tostring(context, encoding="unicode")
                        if context is not None
                        else None,
                        entity_identifier=context.entityIdentifier[1] if context is not None else None,
                        entity_scheme=context.entityIdentifier[0] if context is not None else None,
                        period_start=start,
                        period_end=end,
                        instant_date=instant,
                        fiscal_year=fy if current else None,
                        fiscal_period=fp if current else None,
                        filing_fiscal_year=fy,
                        filing_fiscal_period=fp,
                        form=filing["form"],
                        filed_at=filing["filed_at"],
                        accepted_at=filing["accepted_at"],
                        dimensions=canonical(dimensions),
                        decimals=fact.decimals,
                        precision=fact.precision,
                        scale=fact.get("scale"),
                        sign=fact.get("sign"),
                        format=fact.get("format"),
                        xml_lang=fact.xmlLang,
                        source_document=Path(url).name,
                        source_url=url,
                        source_hash=receipt["source_hash"],
                        ingested_at=receipt["collected_at"],
                        parser_version=PARSER_VERSION,
                        normalization_version=normalization_version,
                        fact_path=fact_path,
                        is_nil=fact.isNil,
                        is_numeric=numeric,
                        is_valid=valid,
                    )
                )
            for arcrole in (
                XbrlConst.parentChild,
                XbrlConst.summationItem,
                XbrlConst.all,
                XbrlConst.notAll,
                XbrlConst.hypercubeDimension,
                XbrlConst.dimensionDomain,
                XbrlConst.domainMember,
                XbrlConst.dimensionDefault,
            ):
                for rel in model.relationshipSet(arcrole).modelRelationships:
                    if rel.fromModelObject is None or rel.toModelObject is None:
                        continue
                    row = dict(
                        accession_number=accession,
                        arcrole=arcrole,
                        linkrole=rel.linkrole,
                        from_concept=qname(rel.fromModelObject.qname),
                        to_concept=qname(rel.toModelObject.qname),
                        weight=str(rel.weight) if rel.weight is not None else None,
                        order=str(rel.order),
                        preferred_label=rel.preferredLabel,
                    )
                    row["id"] = key(row)
                    relationships.append(row)
        finally:
            manager.close()
            cntlr.close()
    # Exact duplicate relationship arcs do not need duplicate physical rows.
    return (
        facts,
        list({r["id"]: r for r in relationships}.values()),
        list({r["id"]: r for r in flags}.values()),
    )

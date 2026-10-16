"""Arrow schemas use exact lexical numbers: no float rounding/decimal overflow.

Gold is long-form: one canonical primitive, unit and source fact per row. Period
shape and filing fiscal focus are separate, so prior comparative facts are never
assigned the filing's fiscal year/quarter without evidence.
"""

import pyarrow as pa


def strings(*names):
    return [(n, pa.large_string()) for n in names]


FACT_COLUMNS = strings(
    "id",
    "company_id",
    "cik",
    "accession_number",
    "taxonomy",
    "namespace",
    "concept",
    "label",
    "value",
    "lexical_value",
    "unit",
    "unit_id",
    "context_id",
    "context_xml",
    "entity_identifier",
    "entity_scheme",
    "period_start",
    "period_end",
    "instant_date",
    "fiscal_year",
    "fiscal_period",
    "filing_fiscal_year",
    "filing_fiscal_period",
    "form",
    "filed_at",
    "accepted_at",
    "dimensions",
    "decimals",
    "precision",
    "scale",
    "sign",
    "format",
    "xml_lang",
    "source_document",
    "source_url",
    "source_hash",
    "ingested_at",
    "parser_version",
    "normalization_version",
    "fact_path",
) + [("is_nil", pa.bool_()), ("is_numeric", pa.bool_()), ("is_valid", pa.bool_())]

CANONICAL_COLUMNS = strings(
    "id",
    "company_id",
    "cik",
    "fiscal_year",
    "fiscal_period",
    "period_start",
    "period_end",
    "instant_date",
    "period_kind",
    "form",
    "filed_at",
    "accepted_at",
    "source_accession",
    "field",
    "value",
    "unit",
    "source_fact_id",
    "mapping_id",
    "normalization_version",
)

SCHEMAS = {
    "silver.companies": strings(
        "id",
        "cik",
        "name",
        "sic",
        "sic_description",
        "fiscal_year_end",
        "country",
        "website",
        "source_id",
        "as_of_date",
    ),
    "silver.securities": strings(
        "id",
        "company_id",
        "cik",
        "ticker",
        "name",
        "mic",
        "security_type",
        "identity_basis",
        "source_id",
        "as_of_date",
    ),
    "silver.universe_snapshots": strings(
        "id", "snapshot_date", "security_id", "company_id", "source_id", "snapshot_id", "collected_at"
    ),
    "silver.filings": strings(
        "id",
        "company_id",
        "cik",
        "accession_number",
        "form",
        "filed_at",
        "accepted_at",
        "report_date",
        "primary_document",
        "source_id",
    ),
    "silver.financial_facts": FACT_COLUMNS,
    "silver.relationships": strings(
        "id",
        "accession_number",
        "arcrole",
        "linkrole",
        "from_concept",
        "to_concept",
        "weight",
        "order",
        "preferred_label",
    ),
    "silver.concept_mappings": strings(
        "id", "version", "taxonomy", "concept", "field", "period_type", "unit_kind", "rule"
    ),
    "silver.source_manifest": strings(
        "id",
        "source_url",
        "source_hash",
        "storage_path",
        "kind",
        "cik",
        "accession_number",
        "collected_at",
        "metadata",
    )
    + [("size", pa.int64()), ("stored_size", pa.int64())],
    "silver.data_quality_flags": strings(
        "id", "code", "severity", "company_id", "accession_number", "fact_id", "details", "source_id"
    ),
    "silver.parse_runs": strings("id", "accession_number", "input_hash", "parser_version", "status"),
    "gold.company_metadata": strings(
        "id",
        "cik",
        "name",
        "sic",
        "sic_description",
        "fiscal_year_end",
        "country",
        "website",
        "source_id",
        "as_of_date",
    ),
    "gold.annual_reported_facts": CANONICAL_COLUMNS,
    "gold.quarterly_reported_facts": CANONICAL_COLUMNS,
    "gold.analyst_estimates": strings(
        "id",
        "company_id",
        "fiscal_year",
        "revenue_estimate",
        "eps_estimate",
        "currency",
        "eps_basis",
        "revenue_estimate_count",
        "eps_estimate_count",
        "source",
        "as_of_date",
        "collected_at",
        "source_id",
    ),
    "gold.ownership_snapshots": strings(
        "id",
        "company_id",
        "ownership_type",
        "value",
        "unit",
        "as_of_date",
        "source",
        "collected_at",
        "source_id",
    ),
}
SCHEMAS = {name: pa.schema(cols) for name, cols in SCHEMAS.items()}
